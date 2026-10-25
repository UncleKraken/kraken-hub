/**
 * Talks to the host. Every command carries a requestId generated once per user
 * action; network retries reuse it, so the host never applies an action twice.
 */

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly params: Record<string, string | number> = {},
  ) {
    super(code);
  }
}

let token: string | null = (() => {
  try {
    return localStorage.getItem('kh.token');
  } catch {
    return null;
  }
})();

export function getToken(): string | null {
  return token;
}

export function setToken(t: string | null): void {
  token = t;
  try {
    if (t) localStorage.setItem('kh.token', t);
    else localStorage.removeItem('kh.token');
  } catch {
    /* storage may be unavailable */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function request<T>(method: string, url: string, body?: unknown, retries = 0): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      if (attempt < retries) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      throw new ApiError('error.network', 0);
    }
    const data = (await res.json().catch(() => ({}))) as { error?: { code: string; params?: Record<string, string | number> } } & T;
    if (!res.ok) {
      if (res.status >= 500 && attempt < retries) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      if (res.status === 401 && url !== '/api/login') setToken(null);
      throw new ApiError(data.error?.code ?? 'error.internal', res.status, data.error?.params ?? {});
    }
    return data;
  }
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url, undefined, 2),
  post: <T>(url: string, body: unknown) => request<T>('POST', url, body),
};

export interface Approval {
  username: string;
  password: string;
}

/** Sends a command. Safe to retry: the same requestId is reused on every attempt. */
export async function command<T = Record<string, unknown>>(type: string, payload: unknown, opts: { approval?: Approval; requestId?: string } = {}): Promise<T> {
  const requestId = opts.requestId ?? crypto.randomUUID();
  const res = await request<{ result: T }>('POST', '/api/commands', { type, requestId, payload, approval: opts.approval }, 3);
  return res.result;
}
