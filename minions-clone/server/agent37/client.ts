import 'server-only';
import { getConfig, instanceOrigin, isInstanceId } from '../config';
import type {
  Agent37ErrorBody,
  CreateInstanceInput,
  CreateResponseInput,
  FileUploadResult,
  Instance,
  ModelsResponse,
  ResponseObject,
  SessionDetail,
  SessionSummary,
} from './types';

/**
 * The Agent37 gateway. The ONLY place the sk_live_ key is used. Two planes share one key:
 *   - Hosting API at apiBase (api.agent37.com): create/list/delete instances.
 *   - Agent API at https://{instanceId}.{appDomain}: models, responses, sessions, files.
 *
 * Branch on err.code (machine-readable), never on HTTP status or message text.
 */

export class Agent37Error extends Error {
  code: string;
  status: number;
  hint?: string;
  param?: string;
  constructor(status: number, body: Agent37ErrorBody) {
    super(body.message || body.code || `Agent37 request failed (HTTP ${status})`);
    this.name = 'Agent37Error';
    this.status = status;
    this.code = body.code || 'upstream_error';
    this.hint = body.hint;
    this.param = body.param;
  }
}

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${getConfig().apiKey}` };
}

// The API returns two error shapes: structured { error: { code, message, hint? } } from the
// Hosting/Agent APIs, and flat strings { error: "invalid_api_key" } from edge rejections.
// Normalize both into Agent37Error.
function toError(status: number, body: unknown): Agent37Error {
  if (body && typeof body === 'object' && 'error' in body) {
    const e = (body as { error: unknown }).error;
    if (e && typeof e === 'object' && 'code' in e) return new Agent37Error(status, e as Agent37ErrorBody);
    if (typeof e === 'string') return new Agent37Error(status, { code: e, message: e.replaceAll('_', ' ') });
  }
  return new Agent37Error(status, { code: 'upstream_error', message: `Unexpected upstream response (HTTP ${status}).` });
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { ...authHeaders(), 'Content-Type': 'application/json', ...init.headers },
      cache: 'no-store',
    });
  } catch (err) {
    throw new Agent37Error(502, { code: 'upstream_unreachable', message: String((err as Error)?.message || err) });
  }
  const text = await res.text();
  const body = text ? safeJson(text) : null;
  if (!res.ok) throw toError(res.status, body);
  return body as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function assertInstanceId(id: string): void {
  if (!isInstanceId(id)) {
    throw new Agent37Error(400, { code: 'invalid_request', message: 'Bad instance id.' });
  }
}

// ============================ Hosting API: instances ============================

export async function createInstance(input: CreateInstanceInput = {}): Promise<Instance> {
  const { apiBase, template, budgetTopupMicros } = getConfig();
  const body: CreateInstanceInput = {
    template: input.template ?? template,
    name: input.name ?? 'minions-clone',
    // Without managed-LLM budget the default cap is $0 and replies come back empty.
    budget: input.budget ?? { topup_micros: budgetTopupMicros },
    ...input,
  };
  return requestJson<Instance>(`${apiBase}/v1/instances`, { method: 'POST', body: JSON.stringify(body) });
}

export async function listInstances(): Promise<Instance[]> {
  const { apiBase } = getConfig();
  const res = await requestJson<{ data: Instance[] }>(`${apiBase}/v1/instances`);
  return res.data ?? [];
}

export async function getInstance(id: string): Promise<Instance> {
  assertInstanceId(id);
  return requestJson<Instance>(`${getConfig().apiBase}/v1/instances/${id}`);
}

export async function deleteInstance(id: string): Promise<void> {
  assertInstanceId(id);
  await requestJson(`${getConfig().apiBase}/v1/instances/${id}`, { method: 'DELETE' });
}

/** Poll target for readiness: the container can be "running" before the agent answers. */
export async function instanceHealthy(id: string, timeoutMs = 8000): Promise<boolean> {
  assertInstanceId(id);
  try {
    const res = await fetch(`${instanceOrigin(id)}/v1/health`, {
      headers: authHeaders(),
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return Boolean(body?.ok);
  } catch {
    return false;
  }
}

// ============================ Agent API: models ============================

export async function listModels(instanceId: string): Promise<ModelsResponse> {
  assertInstanceId(instanceId);
  return requestJson<ModelsResponse>(`${instanceOrigin(instanceId)}/v1/models`);
}

// ============================ Agent API: responses ============================

export async function createResponse(instanceId: string, input: CreateResponseInput): Promise<ResponseObject> {
  assertInstanceId(instanceId);
  return requestJson<ResponseObject>(`${instanceOrigin(instanceId)}/v1/responses`, {
    method: 'POST',
    body: JSON.stringify({ ...input, stream: false }),
  });
}

export async function getResponse(instanceId: string, responseId: string): Promise<ResponseObject> {
  assertInstanceId(instanceId);
  return requestJson<ResponseObject>(
    `${instanceOrigin(instanceId)}/v1/responses/${encodeURIComponent(responseId)}`,
  );
}

export async function cancelResponse(instanceId: string, responseId: string): Promise<ResponseObject> {
  assertInstanceId(instanceId);
  return requestJson<ResponseObject>(
    `${instanceOrigin(instanceId)}/v1/responses/${encodeURIComponent(responseId)}/cancel`,
    { method: 'POST' },
  );
}

/**
 * Open a fresh streaming turn (stream:true). Returns the raw upstream Response so the caller
 * can tee bytes to the browser while watching frames server-side. Pre-stream failures (e.g.
 * 409 session_busy) arrive as JSON, not SSE — the caller checks the content-type.
 */
export async function openResponseStream(
  instanceId: string,
  input: CreateResponseInput,
  signal?: AbortSignal,
): Promise<Response> {
  assertInstanceId(instanceId);
  return openStream(`${instanceOrigin(instanceId)}/v1/responses`, {
    method: 'POST',
    body: JSON.stringify({ ...input, stream: true }),
    signal,
  });
}

/** Reattach to a running (or finished) turn: replays every event so far, then stays live. */
export async function openResponseReplay(
  instanceId: string,
  responseId: string,
  signal?: AbortSignal,
): Promise<Response> {
  assertInstanceId(instanceId);
  return openStream(`${instanceOrigin(instanceId)}/v1/responses/${encodeURIComponent(responseId)}/stream`, {
    signal,
  });
}

async function openStream(url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { ...authHeaders(), 'Content-Type': 'application/json', Accept: 'text/event-stream', ...init.headers },
      cache: 'no-store',
    });
  } catch (err) {
    throw new Agent37Error(502, { code: 'upstream_unreachable', message: String((err as Error)?.message || err) });
  }
  if (!res.headers.get('content-type')?.includes('text/event-stream')) {
    const body = safeJson(await res.text());
    throw toError(res.status, body);
  }
  return res;
}

// ============================ Agent API: sessions ============================

export async function listSessions(instanceId: string): Promise<SessionSummary[]> {
  assertInstanceId(instanceId);
  const res = await requestJson<{ data: SessionSummary[] }>(`${instanceOrigin(instanceId)}/v1/sessions`);
  return res.data ?? [];
}

export async function getSession(instanceId: string, sessionId: string): Promise<SessionDetail> {
  assertInstanceId(instanceId);
  return requestJson<SessionDetail>(
    `${instanceOrigin(instanceId)}/v1/sessions/${encodeURIComponent(sessionId)}`,
  );
}

export async function deleteSession(instanceId: string, sessionId: string): Promise<void> {
  assertInstanceId(instanceId);
  await requestJson(`${instanceOrigin(instanceId)}/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
}

// ============================ Agent API: files ============================

/** Forward a multipart upload. Pass the browser's FormData straight through (one `file` field). */
export async function uploadFile(instanceId: string, form: FormData): Promise<FileUploadResult> {
  assertInstanceId(instanceId);
  let res: Response;
  try {
    // Note: no Content-Type header — fetch sets the multipart boundary from FormData itself.
    res = await fetch(`${instanceOrigin(instanceId)}/v1/files`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
      cache: 'no-store',
    });
  } catch (err) {
    throw new Agent37Error(502, { code: 'upstream_unreachable', message: String((err as Error)?.message || err) });
  }
  const text = await res.text();
  const body = text ? safeJson(text) : null;
  if (!res.ok) throw toError(res.status, body);
  return body as FileUploadResult;
}

/** Stream a file's bytes back. Returns the raw upstream Response for the route to pipe. */
export async function downloadFile(instanceId: string, path: string, signal?: AbortSignal): Promise<Response> {
  assertInstanceId(instanceId);
  const url = `${instanceOrigin(instanceId)}/v1/files/content?path=${encodeURIComponent(path)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: authHeaders(), cache: 'no-store', signal });
  } catch (err) {
    throw new Agent37Error(502, { code: 'upstream_unreachable', message: String((err as Error)?.message || err) });
  }
  if (!res.ok) throw toError(res.status, safeJson(await res.text()));
  return res;
}
