import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { fail } from './errors.ts';
import type { Store } from './db.ts';

export interface Identity {
  userId: string;
  sessionHash: string;
  expiresAt: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    identity: Identity | null;
  }
}

const deriveKey = (password: string, salt: string): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(key));
  });

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await deriveKey(password, salt);
  return `${salt}:${key.toString('hex')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [salt, hash] = encoded.split(':');
  if (!salt || !hash) return false;
  const actual = await deriveKey(password, salt);
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const opaqueToken = (): string => randomBytes(32).toString('base64url');
export const digest = (token: string): string => createHash('sha256').update(token).digest('hex');

export function authenticate(store: Store, request: FastifyRequest): Identity {
  const authorization = request.headers.authorization;
  if (!authorization || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) {
    return fail(401, 'UNAUTHORIZED', '请提供有效的 Bearer token');
  }
  const sessionHash = digest(authorization.slice(7));
  const row = store.get<{ user_id: string; expires_at: string }>(
    'SELECT user_id, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?',
    sessionHash, new Date().toISOString(),
  );
  if (!row) return fail(401, 'UNAUTHORIZED', '登录已失效，请重新登录');
  return { userId: row.user_id, sessionHash, expiresAt: row.expires_at };
}

export function identity(request: FastifyRequest): Identity {
  return request.identity ?? fail(401, 'UNAUTHORIZED', '请先登录');
}
