import 'server-only';
import {
  Agent37Error,
  cancelResponse,
  createResponse,
  getSession,
  listModels,
  openResponseReplay,
  openResponseStream,
} from '../agent37/client';
import type { CreateResponseInput, SessionMessage } from '../agent37/types';
import { encodeSseFrame, makeFrameScanner, SSE } from '../agent37/sse';
import {
  addAttachment,
  claimQueuedTask,
  deleteTask as deleteTaskRow,
  deleteTasksByStatuses,
  getTaskById,
  insertTask,
  listAttachments,
  listTasks as listTaskRows,
  updateTask,
} from '../db/repositories/tasks';
import { statusesForColumn } from '@/features/tasks/types';
import type { TaskAttachmentRow, TaskRow } from '../db/schema';
import { ensureInstanceId, ensureInstanceReady, getExistingInstanceId } from './instance';
import { titleFromPrompt } from '@/lib/util';
import type {
  CreateTaskRequest,
  Task,
  TaskAttachment,
  TaskMessage,
  TaskModelOption,
  TaskWithAttachments,
  TaskWithMessages,
  BoardColumnId,
} from '@/features/tasks/types';

// Rows are JSON-serializable and camelCased, so DTO mapping is mostly the identity — but going
// through these keeps the wire shape decoupled from the tables if they ever diverge.
function toTask(row: TaskRow): Task {
  return { ...row };
}
function toAttachment(row: TaskAttachmentRow): TaskAttachment {
  return { ...row };
}

/** Map one Agent37 session-history entry into the thread's display message shape. */
function toMessage(taskId: string, m: SessionMessage): TaskMessage {
  const created = typeof m.created_at === 'number' ? m.created_at : Number(new Date(m.created_at ?? 0)) || 0;
  return {
    id: m.id,
    taskId,
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
    reasoning: m.thinking ?? null,
    responseId: m.id,
    createdAt: created,
  };
}

/** The opening turn for a task whose session doesn't exist yet (queued, never run). */
function promptMessage(row: TaskRow): TaskMessage {
  return {
    id: `${row.id}-prompt`,
    taskId: row.id,
    role: 'user',
    content: row.prompt,
    reasoning: null,
    responseId: null,
    createdAt: row.createdAt,
  };
}

/**
 * The chat thread, read LIVE from the Agent37 session — we no longer mirror the transcript. A
 * task with no session yet (or an unreachable instance) falls back to showing its opening prompt.
 */
async function loadThread(row: TaskRow): Promise<TaskMessage[]> {
  if (!row.sessionId) return [promptMessage(row)];
  const instanceId = await getExistingInstanceId();
  if (!instanceId) return [promptMessage(row)];
  try {
    const session = await getSession(instanceId, row.sessionId);
    const msgs = (session.history ?? [])
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => toMessage(row.id, m));
    return msgs.length ? msgs : [promptMessage(row)];
  } catch {
    return [promptMessage(row)];
  }
}

export async function createTask(req: CreateTaskRequest): Promise<TaskWithAttachments> {
  const task = await insertTask({
    title: titleFromPrompt(req.prompt),
    prompt: req.prompt,
    status: 'queued',
    priority: req.priority,
    mode: req.mode,
    model: req.model ?? null,
    provider: req.provider ?? null,
  });

  const attachments: TaskAttachment[] = [];
  for (const a of req.attachments ?? []) {
    attachments.push(toAttachment(await addAttachment(task.id, a)));
  }
  return { ...toTask(task), attachments };
}

export async function listTasks(): Promise<Task[]> {
  const rows = await listTaskRows();
  return rows.map(toTask);
}

/** Full detail for the task page: metadata + attachments + the rendered chat thread. */
export async function getTaskDetail(taskId: string): Promise<TaskWithMessages | null> {
  const row = await getTaskById(taskId);
  if (!row) return null;
  const [attachments, messages] = await Promise.all([listAttachments(taskId), loadThread(row)]);
  return { ...toTask(row), attachments: attachments.map(toAttachment), messages };
}

export async function deleteTask(taskId: string): Promise<boolean> {
  const row = await getTaskById(taskId);
  if (!row) return false;
  await deleteTaskRow(taskId);
  return true;
}

/** Delete every task in a board column (the header "Delete all in …" action). Returns the count. */
export async function deleteTasksInColumn(column: BoardColumnId): Promise<number> {
  return deleteTasksByStatuses(statusesForColumn(column));
}

/**
 * Move a task between board columns. 'queued' is the "reopen, no re-run" target for the In
 * Progress column — a previously-run task becomes queued again but openTaskStream won't restart
 * it (see the reopened guard there). sortOrder, when given, repositions the card within a column.
 */
export async function setTaskStatus(
  taskId: string,
  status: 'completed' | 'ready_for_review' | 'queued',
  sortOrder?: number,
): Promise<Task | null> {
  const patch: { status: typeof status; sortOrder?: number } = { status };
  if (typeof sortOrder === 'number') patch.sortOrder = sortOrder;
  const updated = await updateTask(taskId, patch);
  return updated ? toTask(updated) : null;
}

/** Reposition a card within its column without changing status (intra-column drag). */
export async function setTaskSortOrder(taskId: string, sortOrder: number): Promise<Task | null> {
  const updated = await updateTask(taskId, { sortOrder });
  return updated ? toTask(updated) : null;
}

export async function renameTask(taskId: string, title: string): Promise<Task | null> {
  const clean = title.trim().slice(0, 120) || 'Untitled task';
  const updated = await updateTask(taskId, { title: clean, titleGenerated: true });
  return updated ? toTask(updated) : null;
}

/**
 * Auto-name a task from its first exchange via one cheap, throwaway (separate-session) turn.
 * Idempotent: if a title was already generated/edited, returns it unchanged.
 */
export async function generateTaskTitle(taskId: string): Promise<string | null> {
  const row = await getTaskById(taskId);
  if (!row) return null;
  if (row.titleGenerated) return row.title;

  const instanceId = await getExistingInstanceId();
  // Read the exchange live from the session (no local transcript). The prompt is always the
  // opening user turn; the first assistant reply comes from Agent37 history when available.
  const messages = await loadThread(row);
  const firstUser = messages.find((m) => m.role === 'user')?.content ?? row.prompt;
  const firstAssistant = messages.find((m) => m.role === 'assistant')?.content ?? '';

  if (!instanceId) {
    const fallback = titleFromPrompt(firstUser);
    await updateTask(taskId, { title: fallback, titleGenerated: true }).catch(() => {});
    return fallback;
  }

  const prompt =
    'Write a concise 3-6 word title (imperative, Title Case, no quotes, no trailing punctuation) ' +
    `for this task based on the exchange.\n\nUser: ${firstUser.slice(0, 600)}\nAssistant: ${firstAssistant.slice(0, 600)}\n\nReturn ONLY the title.`;
  try {
    // No session_id → a fresh throwaway session, so this never pollutes the task's conversation.
    const resp = await createResponse(instanceId, { input: prompt, thinking: 'none', mode: 'chat' });
    const title = cleanTitle(resp.output_text) || titleFromPrompt(firstUser);
    const updated = await updateTask(taskId, { title, titleGenerated: true });
    return updated?.title ?? title;
  } catch {
    const fallback = titleFromPrompt(firstUser);
    await updateTask(taskId, { title: fallback, titleGenerated: true }).catch(() => {});
    return fallback;
  }
}

function cleanTitle(s: string): string {
  return (s ?? '')
    .trim()
    .split('\n')[0]
    .replace(/^["'#\s]+/, '')
    .replace(/["'.\s]+$/, '')
    .slice(0, 80);
}

export async function cancelTask(taskId: string): Promise<Task | null> {
  const row = await getTaskById(taskId);
  if (!row) return null;
  if (row.status !== 'running' || !row.responseId) {
    if (row.status === 'queued') {
      const updated = await updateTask(taskId, { status: 'cancelled' });
      return updated ? toTask(updated) : null;
    }
    return toTask(row);
  }
  const instanceId = await ensureInstanceId();
  try {
    // Tell Agent37 to stop the turn; the partial output stays in the session and shows on reload.
    await cancelResponse(instanceId, row.responseId);
    const updated = await updateTask(taskId, { status: 'cancelled' });
    return updated ? toTask(updated) : null;
  } catch {
    const updated = await updateTask(taskId, { status: 'cancelled' });
    return updated ? toTask(updated) : null;
  }
}

// The implicit "use the session/instance default" option, always offered first.
const DEFAULT_MODEL_OPTION: TaskModelOption = { id: 'default', label: 'Default', provider: null, isDefault: true };

/**
 * Map Agent37's model list (GET /v1/models) into the composer's option shape. Deliberately does
 * NOT provision: if no instance exists yet we offer only "default", so merely opening the
 * composer never spins up a billed container (that happens on the first task). Once an instance
 * exists, the live models are appended beneath the persistent "default" sentinel — "default"
 * always stays selectable and maps to `model: null` (let the instance pick) on submit.
 */
export async function getModelOptions(): Promise<TaskModelOption[]> {
  const instanceId = await getExistingInstanceId();
  if (!instanceId) return [DEFAULT_MODEL_OPTION];
  try {
    const models = await listModels(instanceId);
    // Skip any upstream "default" id so it can't collide with our sentinel above.
    const live = (models.data ?? [])
      .filter((m) => m.id !== DEFAULT_MODEL_OPTION.id)
      .map((m) => ({
        id: m.id,
        label: m.label || m.id,
        provider: m.provider ?? models.default_provider ?? null,
        isDefault: false,
      }));
    return [DEFAULT_MODEL_OPTION, ...live];
  } catch {
    // Network/upstream hiccup — fall back to the always-safe "default" choice.
    return [DEFAULT_MODEL_OPTION];
  }
}

// ============================ Streaming orchestration ============================

/**
 * Stream behind POST /api/tasks/[id]/stream — the FIRST turn (kick off a queued task) or a
 * reattach to a running turn. Returns an SSE byte stream, teed so task + message state is
 * persisted from the same stream the browser renders.
 */
export async function openTaskStream(taskId: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const row = await getTaskById(taskId);
  if (!row) throw new Agent37Error(404, { code: 'task_not_found', message: 'No such task.' });

  // No live turn to stream: terminal tasks, and "reopened" tasks (dragged back to In Progress) —
  // those are 'queued' but have already run (responseId set), so they show their existing thread
  // and continue via follow-ups rather than re-running the original prompt.
  const reopened = row.status === 'queued' && Boolean(row.responseId);
  if ((row.status !== 'queued' && row.status !== 'running') || reopened) return replayTerminal(row, signal);

  if (row.responseId && row.status === 'running') {
    const instanceId = await ensureInstanceId();
    const upstream = await openResponseReplay(instanceId, row.responseId, signal);
    return teeAndPersist(taskId, upstream);
  }

  // First start. Make sure the agent is awake before claiming so a cold instance doesn't strand
  // the task in 'running' with no response id.
  const { id: instanceId, ready } = await ensureInstanceReady();
  if (!ready) {
    throw new Agent37Error(503, {
      code: 'instance_warming',
      message: 'The agent is starting up. This can take a minute on first run — retrying…',
    });
  }

  const claimed = await claimQueuedTask(taskId);
  if (!claimed) {
    const fresh = await getTaskById(taskId);
    if (fresh?.responseId) {
      const upstream = await openResponseReplay(instanceId, fresh.responseId, signal);
      return teeAndPersist(taskId, upstream);
    }
    throw new Agent37Error(409, { code: 'task_starting', message: 'The task is already starting — retry shortly.' });
  }

  const attachments = await listAttachments(taskId);
  try {
    const upstream = await openResponseStream(instanceId, buildFirstTurnInput(row, attachments), signal);
    return teeAndPersist(taskId, upstream);
  } catch (err) {
    await updateTask(taskId, { status: 'queued' }).catch(() => {});
    throw err;
  }
}

/**
 * Stream behind POST /api/tasks/[id]/messages — a follow-up turn in the SAME session. Opens a new
 * response (reusing session_id so Agent37 keeps context) and tees. The user's text lands in the
 * Agent37 session, so it shows up in the thread on the next live read — we store no copy.
 */
export async function sendFollowup(taskId: string, input: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const row = await getTaskById(taskId);
  if (!row) throw new Agent37Error(404, { code: 'task_not_found', message: 'No such task.' });
  if (row.status === 'running') {
    throw new Agent37Error(409, { code: 'task_busy', message: 'A turn is already running. Wait for it to finish.' });
  }

  const { id: instanceId, ready } = await ensureInstanceReady();
  if (!ready) {
    throw new Agent37Error(503, { code: 'instance_warming', message: 'The agent is starting up — retrying…' });
  }

  // Follow-ups are plain chat turns; the goal framing was applied on the first turn and the
  // session already carries that context.
  const reqInput: CreateResponseInput = {
    input,
    model: row.model ?? undefined,
    provider: row.provider ?? undefined,
    session_id: row.sessionId ?? undefined,
    metadata: { task_id: taskId },
    mode: 'chat',
  };

  // Open upstream first; only commit local state once the turn is actually accepted.
  const upstream = await openResponseStream(instanceId, reqInput, signal);
  await updateTask(taskId, { status: 'running', responseId: null });
  return teeAndPersist(taskId, upstream);
}

function buildFirstTurnInput(task: TaskRow, attachments: TaskAttachmentRow[]): CreateResponseInput {
  const files = attachments.map((a) => a.path);
  // 'goal' steers the agent to work end-to-end via Agent37's native goal mode; 'ask' is a plain
  // chat turn. We send the raw prompt either way, so the session stores the user's original text
  // (no preamble) and the live thread reads back cleanly.
  return {
    input: task.prompt,
    files: files.length ? files : undefined,
    model: task.model ?? undefined,
    provider: task.provider ?? undefined,
    session_id: task.sessionId ?? undefined,
    metadata: { task_id: task.id },
    mode: task.mode === 'goal' ? 'goal' : 'chat',
  };
}

/**
 * Pipe upstream SSE bytes to the browser untouched while scanning a copy to persist only the
 * board lifecycle: on response.created store the session/response pointers; on the terminal frame
 * set status (ready_for_review on success, failed on error). The transcript itself is NOT mirrored
 * — it lives in the Agent37 session. DB writes are awaited at close so a fast disconnect can't
 * drop the status transition.
 */
function teeAndPersist(taskId: string, upstream: Response): ReadableStream<Uint8Array> {
  const reader = upstream.body!.getReader();
  const decoder = new TextDecoder();
  const pending: Promise<unknown>[] = [];

  const scanner = makeFrameScanner((frame) => {
    const data = frame.data as Record<string, unknown>;
    switch (frame.event) {
      case SSE.created:
        pending.push(
          updateTask(taskId, {
            responseId: String(data.id ?? ''),
            sessionId: String(data.session_id ?? ''),
            status: 'running',
          }).catch(() => {}),
        );
        break;
      case SSE.completed:
        pending.push(updateTask(taskId, { status: 'ready_for_review' }).catch(() => {}));
        break;
      case SSE.failed:
        pending.push(updateTask(taskId, { status: 'failed' }).catch(() => {}));
        break;
    }
  });

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          await Promise.allSettled(pending);
          controller.close();
          return;
        }
        scanner.feed(decoder.decode(value, { stream: true }));
        controller.enqueue(value);
      } catch (err) {
        await Promise.allSettled(pending);
        controller.error(err);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
      await Promise.allSettled(pending);
    },
  });
}

/**
 * Re-show a finished or reopened task without a fresh turn. Rather than replay a cached copy, we
 * replay the real Agent37 response stream (`/v1/responses/{id}/stream`) — every event so far, then
 * end. If there's nothing to replay (never ran, or no reachable instance) emit one empty terminal.
 */
async function replayTerminal(row: TaskRow, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  if (row.responseId) {
    const instanceId = await getExistingInstanceId();
    if (instanceId) {
      const upstream = await openResponseReplay(instanceId, row.responseId, signal);
      return upstream.body!;
    }
  }
  const encoder = new TextEncoder();
  const frame = encodeSseFrame(SSE.completed, { output_text: '' });
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}
