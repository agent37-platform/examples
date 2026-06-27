import type { SseFrame } from './types';

/**
 * SSE helpers shared by the gateway and the task stream route.
 *
 * The Agent37 stream is a sequence of frames separated by a blank line. Each frame has an
 * `event:` line and a `data:` line (JSON). Lines starting with `:` are comments/keepalives
 * (the gateway sends `:keepalive` every ~30s) and must be ignored. There are exactly eight
 * event types — see SseEventName in ./types.
 */

export const SSE = {
  created: 'response.created',
  reasoningDelta: 'response.reasoning.delta',
  outputTextDelta: 'response.output_text.delta',
  toolStarted: 'response.tool_call.started',
  toolCompleted: 'response.tool_call.completed',
  toolFailed: 'response.tool_call.failed',
  completed: 'response.completed',
  failed: 'response.failed',
} as const;

/** The two frames after which the stream closes. */
export function isTerminalEvent(event: string): boolean {
  return event === SSE.completed || event === SSE.failed;
}

/** Async-iterate parsed frames from a web ReadableStream of SSE bytes. */
export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let split: number;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const rawFrame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const frame = parseFrame(rawFrame);
        if (frame) yield frame;
      }
    }
    // Flush any trailing frame without a final blank line.
    const tail = parseFrame(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function parseFrame(raw: string): SseFrame | null {
  let event = '';
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue; // blank or keepalive comment
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (!event || dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) };
  } catch {
    return null;
  }
}

/** Serialize one SSE frame for synthesizing a stream (e.g. replaying a finished task). */
export function encodeSseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Incremental scanner for the tee in the task stream service: the raw SSE bytes are forwarded
 * to the browser untouched, while a copy is fed here to detect frames (response.created and the
 * terminal events) so the server can persist task state. feed() each decoded text chunk.
 */
export function makeFrameScanner(onFrame: (frame: SseFrame) => void): {
  feed: (text: string) => void;
} {
  let buffer = '';
  return {
    feed(text: string) {
      buffer += text;
      let split: number;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const frame = parseFrame(raw);
        if (frame) onFrame(frame);
      }
    },
  };
}
