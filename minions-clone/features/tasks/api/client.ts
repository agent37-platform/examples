/**
 * Client-side API for the Tasks vertical. Every call goes through @/lib/fetcher's `api` so
 * non-2xx responses surface as an ApiError. This module is imported by client components, so it
 * must never reach for a @/server/* import.
 */
import { api } from '@/lib/fetcher';
import type {
  BoardColumnId,
  CreateTaskRequest,
  Task,
  TaskModelOption,
  TaskWithAttachments,
  TaskWithMessages,
  UpdateTaskRequest,
} from '@/features/tasks/types';
import type { UploadedFile } from '@/features/files/types';

export function listTasks(): Promise<Task[]> {
  return api.get<Task[]>('/api/tasks');
}

/** Full detail for the task page: metadata + attachments + the rendered chat thread. */
export function getTaskDetail(id: string): Promise<TaskWithMessages> {
  return api.get<TaskWithMessages>(`/api/tasks/${id}`);
}

export function createTask(body: CreateTaskRequest): Promise<TaskWithAttachments> {
  return api.post<TaskWithAttachments>('/api/tasks', body);
}

/** Rename, or mark complete / reopen — returns the refreshed task with its thread. */
export function updateTask(id: string, body: UpdateTaskRequest): Promise<TaskWithMessages> {
  return api.patch<TaskWithMessages>(`/api/tasks/${id}`, body);
}

export function deleteTask(id: string): Promise<{ deleted: boolean }> {
  return api.delete<{ deleted: boolean }>(`/api/tasks/${id}`);
}

/** Delete every task in a board column (the column header "Delete all in …" action). */
export function deleteTasksInColumn(column: BoardColumnId): Promise<{ deleted: number }> {
  return api.post<{ deleted: number }>('/api/tasks/bulk-delete', { column });
}

export function cancelTask(id: string): Promise<Task> {
  return api.post<Task>(`/api/tasks/${id}/cancel`);
}

/** Auto-name a task from its first exchange. Idempotent; call once after the first turn finishes. */
export function generateTitle(id: string): Promise<{ title: string }> {
  return api.post<{ title: string }>(`/api/tasks/${id}/title`);
}

export function fetchModels(): Promise<TaskModelOption[]> {
  return api.get<TaskModelOption[]>('/api/models');
}

/**
 * Upload a file as a task attachment. Uses a raw fetch with FormData since the multipart body
 * can't go through the JSON `api` helper. Mirrors the error envelope on failure.
 */
export async function uploadAttachment(file: File): Promise<UploadedFile> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/files', { method: 'POST', body: form });
  if (!res.ok) {
    let message = `Upload failed (${res.status}).`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body?.error?.message) message = body.error.message;
    } catch {
      // Non-JSON error body; keep the generic message.
    }
    throw new Error(message);
  }
  return (await res.json()) as UploadedFile;
}
