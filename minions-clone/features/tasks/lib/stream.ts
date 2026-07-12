/**
 * Reusable client core for consuming an Agent37 task SSE stream through our /api routes. Used by
 * the chat hook for both the initial/reattach stream (POST /api/tasks/[id]/stream) and follow-up
 * turns (POST /api/tasks/[id]/messages). Handles the warm-up retry dance, parses frames into
 * callbacks, and reconnects (which hits Agent37's replay) if a stream drops before a terminal
 * frame. onOpen fires on every fresh connection so callers can reset accumulators (a replay
 * re-sends every delta from the start, so appending without a reset would duplicate text).
 */

export interface StreamErrorBody {
  code: string;
  message: string;
  hint?: string;
}

export interface StreamHandlers {
  onCreated?: () => void;
  onReasoning?: (text: string) => void;
  onOutput?: (text: string) => void;
  onTool?: (tool: string, label: string | undefined, state: 'started' | 'completed' | 'failed') => void;
  onCompleted?: (outputText: string) => void;
  onFailed?: (error: StreamErrorBody) => void;
  /** Fires when a fresh event-stream connection opens — reset accumulators here. */
  onOpen?: () => void;
  onPhase?: (phase: 'connecting' | 'streaming') => void;
}

export type StreamOutcome =
  | { status: 'terminal' } // a response.completed or response.failed frame arrived
  | { status: 'aborted' }
  | { status: 'error'; error: StreamErrorBody };

interface RunOptions {
  url: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  signal: AbortSignal;
  handlers: StreamHandlers;
}

const WARM_RETRY_MS = 2500;
const MAX_WARM_ATTEMPTS = 20;
const RECONNECT_MS = 1500;
const MAX_RECONNECTS = 5;
const WARMING_CODES = new Set(['instance_warming', 'task_starting']);

export async function runTaskStream({ url, method = 'POST', body, signal, handlers }: RunOptions): Promise<StreamOutcome> {
  let warmAttempts = 0;
  let reconnects = 0;
  let buffer = '';

  const dispatch = (event: string, data: Record<string, unknown>): boolean => {
    switch (event) {
      case 'response.created':
        handlers.onCreated?.();
        handlers.onPhase?.('streaming');
        return false;
      case 'response.reasoning.delta':
        if (typeof data.text === 'string') handlers.onReasoning?.(data.text);
        return false;
      case 'response.output_text.delta':
        if (typeof data.text === 'string') handlers.onOutput?.(data.text);
        return false;
      case 'response.tool_call.started':
        handlers.onTool?.(String(data.tool ?? 'tool'), data.label as string | undefined, 'started');
        return false;
      case 'response.tool_call.completed':
        handlers.onTool?.(String(data.tool ?? 'tool'), data.label as string | undefined, 'completed');
        return false;
      case 'response.tool_call.failed':
        handlers.onTool?.(String(data.tool ?? 'tool'), data.label as string | undefined, 'failed');
        return false;
      case 'response.completed':
        handlers.onCompleted?.(typeof data.output_text === 'string' ? data.output_text : '');
        return true;
      case 'response.failed':
        handlers.onFailed?.((data.error as StreamErrorBody) ?? { code: 'failed', message: 'The task failed.' });
        return true;
      default:
        return false;
    }
  };

  const feed = (text: string): boolean => {
    buffer += text;
    let terminal = false;
    let split: number;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const frame = parseFrame(raw);
      if (frame && dispatch(frame.event, frame.data)) terminal = true;
    }
    return terminal;
  };

  while (!signal.aborted) {
    handlers.onPhase?.('connecting');

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (err) {
      if (isAbort(err) || signal.aborted) return { status: 'aborted' };
      if (reconnects++ >= MAX_RECONNECTS) return { status: 'error', error: { code: 'network_error', message: 'Lost connection to the stream.' } };
      await delay(RECONNECT_MS);
      continue;
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      // A JSON error arrived instead of a stream.
      const err = await readJsonError(res);
      if (signal.aborted) return { status: 'aborted' };
      if (WARMING_CODES.has(err.code) && warmAttempts++ < MAX_WARM_ATTEMPTS) {
        await delay(WARM_RETRY_MS);
        continue;
      }
      return { status: 'error', error: err };
    }

    // Fresh event stream — reset for this connection (replay re-sends from the start).
    buffer = '';
    warmAttempts = 0;
    handlers.onOpen?.();

    const stream = res.body;
    if (!stream) {
      if (reconnects++ >= MAX_RECONNECTS) return { status: 'error', error: { code: 'stream_error', message: 'The stream returned no body.' } };
      await delay(RECONNECT_MS);
      continue;
    }

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let sawTerminal = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (feed(decoder.decode(value, { stream: true }))) {
          sawTerminal = true;
          break;
        }
      }
    } catch (err) {
      if (isAbort(err) || signal.aborted) return { status: 'aborted' };
      // fall through to reconnect handling
    } finally {
      reader.cancel().catch(() => {});
    }

    if (signal.aborted) return { status: 'aborted' };
    if (sawTerminal) return { status: 'terminal' };

    // Stream ended without a terminal frame — reconnect (which hits replay) if we have budget.
    if (reconnects++ >= MAX_RECONNECTS) return { status: 'error', error: { code: 'stream_dropped', message: 'The stream ended unexpectedly.' } };
    await delay(RECONNECT_MS);
  }
  return { status: 'aborted' };
}

function parseFrame(raw: string): { event: string; data: Record<string, unknown> } | null {
  let event = '';
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!event || dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) as Record<string, unknown> };
  } catch {
    return null;
  }
}

async function readJsonError(res: Response): Promise<StreamErrorBody> {
  try {
    const body = (await res.json()) as { error?: StreamErrorBody };
    if (body?.error?.code) return body.error;
  } catch {
    // not JSON
  }
  return { code: 'error', message: `Request failed (${res.status}).` };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}
