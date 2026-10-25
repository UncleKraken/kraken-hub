import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Actor, Role } from '../auth.js';
import { verifyManager } from '../auth.js';
import type { DB } from '../db/index.js';
import { AppError, forbidden } from '../errors.js';

/**
 * Every change to the venue goes through one command bus:
 * 1. The client sends {type, requestId, payload}. requestId is a UUID the client
 *    generates once per user action, so retries and double taps are harmless.
 * 2. If we've seen requestId before, we return the stored response unchanged.
 * 3. Otherwise the handler runs inside one transaction with the audit entries,
 *    and the response is stored under requestId in the same transaction.
 * 4. Listeners are told the venue changed so open screens refresh.
 */

export interface CommandContext {
  db: DB;
  actor: Actor;
  /** Manager who approved this action at the counter, if any. */
  approvedBy: Actor | null;
  now: number;
  requestId: string;
  id: () => string;
  audit: (entry: { action: string; entity: string; entityId?: string | null; before?: unknown; after?: unknown }) => void;
  /** Throws unless the actor (or an approving manager) is a manager. */
  requireManager: () => void;
}

export interface CommandDef<S extends z.ZodType> {
  type: string;
  schema: S;
  /** Roles allowed to run it at all. Handlers can demand more via ctx.requireManager(). */
  roles: Role[];
  handler: (ctx: CommandContext, payload: z.infer<S>) => unknown;
}

export function defineCommand<S extends z.ZodType>(def: CommandDef<S>): CommandDef<S> {
  return def;
}

export const CommandEnvelope = z.object({
  type: z.string().min(1),
  requestId: z.uuid(),
  payload: z.unknown().default({}),
  approval: z.object({ username: z.string().min(1), password: z.string().min(1) }).optional(),
});
export type CommandEnvelope = z.infer<typeof CommandEnvelope>;

export type ChangeListener = (info: { type: string; actorId: string }) => void;

export class CommandBus {
  private readonly defs = new Map<string, CommandDef<z.ZodType>>();
  private readonly listeners = new Set<ChangeListener>();

  constructor(
    private readonly db: DB,
    private readonly clock: () => number = Date.now,
  ) {}

  register(...defs: CommandDef<z.ZodType>[]): this {
    for (const d of defs) {
      if (this.defs.has(d.type)) throw new Error(`duplicate command ${d.type}`);
      this.defs.set(d.type, d);
    }
    return this;
  }

  onChange(fn: ChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  execute(actor: Actor, envelope: CommandEnvelope): unknown {
    const def = this.defs.get(envelope.type);
    if (!def) throw new AppError('error.unknown_command', 400, { type: envelope.type });

    const seen = this.db
      .prepare('SELECT command, response FROM idempotency WHERE request_id = ?')
      .get(envelope.requestId) as { command: string; response: string } | undefined;
    if (seen) {
      if (seen.command !== envelope.type) throw new AppError('error.request_id_reused', 409);
      return JSON.parse(seen.response);
    }

    if (!def.roles.includes(actor.role)) throw forbidden();

    const parsed = def.schema.safeParse(envelope.payload);
    if (!parsed.success) {
      throw new AppError('error.invalid_input', 400, { detail: parsed.error.issues[0]?.message ?? '' });
    }

    let approvedBy: Actor | null = null;
    if (envelope.approval) {
      approvedBy = verifyManager(this.db, envelope.approval.username, envelope.approval.password);
      if (!approvedBy) throw new AppError('error.approval_failed', 403);
    }

    const now = this.clock();
    const audits: Parameters<CommandContext['audit']>[0][] = [];
    const ctx: CommandContext = {
      db: this.db,
      actor,
      approvedBy,
      now,
      requestId: envelope.requestId,
      id: () => randomUUID(),
      audit: (e) => audits.push(e),
      requireManager: () => {
        if (actor.role !== 'manager' && !approvedBy) throw new AppError('error.needs_manager', 403);
      },
    };

    const run = this.db.transaction(() => {
      const result = def.handler(ctx, parsed.data) ?? { ok: true };
      const insertAudit = this.db.prepare(
        `INSERT INTO audit_log (at, actor_id, approved_by, action, entity, entity_id, before, after, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const a of audits) {
        insertAudit.run(
          now,
          actor.id,
          approvedBy?.id ?? null,
          a.action,
          a.entity,
          a.entityId ?? null,
          a.before === undefined ? null : JSON.stringify(a.before),
          a.after === undefined ? null : JSON.stringify(a.after),
          envelope.requestId,
        );
      }
      this.db
        .prepare('INSERT INTO idempotency (request_id, command, actor_id, response, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(envelope.requestId, envelope.type, actor.id, JSON.stringify(result), now);
      return result;
    });

    const result = run();
    for (const fn of this.listeners) {
      try {
        fn({ type: envelope.type, actorId: actor.id });
      } catch {
        // A broken listener must never fail a committed command.
      }
    }
    return result;
  }
}
