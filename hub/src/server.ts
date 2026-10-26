import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import type { DB } from './db.js';
import { AuthError, ingest, IngestInput, overview } from './store.js';

export interface HubOptions {
  db: DB;
  clock?: () => number;
  logger?: boolean;
  publicDir?: string;
}

/** Default day range for the dashboard: the last 7 UTC days, inclusive. */
function defaultRange(now: number): { from: string; to: string } {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { from: day(now - 6 * 86_400_000), to: day(now) };
}

export async function buildHub(opts: HubOptions): Promise<{ app: FastifyInstance }> {
  const { db } = opts;
  const clock = opts.clock ?? Date.now;
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 2 * 1024 * 1024 });

  app.get('/api/health', async () => ({ ok: true, now: clock() }));

  // A branch pushes its daily rollup here.
  app.post('/ingest', async (req, reply) => {
    const parsed = IngestInput.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: parsed.error.issues[0]?.message ?? 'invalid input' };
    }
    try {
      return ingest(db, parsed.data, clock());
    } catch (err) {
      if (err instanceof AuthError) {
        reply.code(401);
        return { error: 'unauthorized' };
      }
      throw err;
    }
  });

  // Combined, cross-branch overview for the dashboard.
  app.get('/api/overview', async (req) => {
    const q = req.query as { from?: string; to?: string };
    const def = defaultRange(clock());
    const dayRe = /^\d{4}-\d{2}-\d{2}$/;
    const from = q.from && dayRe.test(q.from) ? q.from : def.from;
    const to = q.to && dayRe.test(q.to) ? q.to : def.to;
    return overview(db, from, to, clock());
  });

  // The dashboard (static files), when a public dir is present.
  const publicDir = opts.publicDir;
  if (publicDir && existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: publicDir });
  }

  return { app };
}
