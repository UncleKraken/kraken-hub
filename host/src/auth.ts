import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DB } from './db/index.js';

export type Role = 'operator' | 'manager';

export interface Actor {
  id: string;
  username: string;
  displayName: string;
  role: Role;
}

const SCRYPT_N = 16384;
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days; tokens are also revoked at logout

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n) });
  return timingSafeEqual(expected, actual);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function issueToken(db: DB, userId: string, now: number): string {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO auth_tokens (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    sha256(token),
    userId,
    now,
    now + TOKEN_TTL_MS,
  );
  return token;
}

export function revokeToken(db: DB, token: string): void {
  db.prepare('DELETE FROM auth_tokens WHERE token_hash = ?').run(sha256(token));
}

export function actorFromToken(db: DB, token: string | undefined, now: number): Actor | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.display_name AS displayName, u.role
       FROM auth_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ? AND t.expires_at > ? AND u.active = 1`,
    )
    .get(sha256(token), now) as Actor | undefined;
  return row ?? null;
}

/** Checks a manager's credentials typed at the counter, for approvals. */
export function verifyManager(db: DB, username: string, password: string): Actor | null {
  const row = db
    .prepare(`SELECT id, username, display_name AS displayName, role, password_hash AS hash FROM users WHERE username = ? AND active = 1`)
    .get(username) as (Actor & { hash: string }) | undefined;
  if (!row || row.role !== 'manager' || !verifyPassword(password, row.hash)) return null;
  const { hash: _hash, ...actor } = row;
  return actor;
}
