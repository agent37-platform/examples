/**
 * Tiny typed client for our own API. Every feature's api/ module and hook goes through this, so
 * error handling is uniform: a non-2xx response throws an ApiError carrying the server's
 * { code, message, hint } envelope.
 */

export interface ApiErrorBody {
  code: string;
  message: string;
  hint?: string;
}

export class ApiError extends Error {
  code: string;
  status: number;
  hint?: string;
  constructor(status: number, body: ApiErrorBody) {
    super(body.message || body.code || `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code || 'error';
    this.hint = body.hint;
  }
}

async function handle<T>(res: Response): Promise<T> {
  const text = await res.text();
  const body = text ? safeParse(text) : null;
  if (!res.ok) {
    const e = (body as { error?: ApiErrorBody } | null)?.error;
    throw new ApiError(res.status, e && typeof e === 'object' ? e : { code: 'error', message: `Request failed (${res.status})` });
  }
  return body as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const api = {
  get: <T>(url: string, init?: RequestInit) => fetch(url, { ...init }).then((r) => handle<T>(r)),
  post: <T>(url: string, data?: unknown, init?: RequestInit) =>
    fetch(url, {
      method: 'POST',
      headers: data !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: data !== undefined ? JSON.stringify(data) : undefined,
      ...init,
    }).then((r) => handle<T>(r)),
  patch: <T>(url: string, data?: unknown, init?: RequestInit) =>
    fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data ?? {}),
      ...init,
    }).then((r) => handle<T>(r)),
  delete: <T>(url: string, init?: RequestInit) => fetch(url, { method: 'DELETE', ...init }).then((r) => handle<T>(r)),
};
