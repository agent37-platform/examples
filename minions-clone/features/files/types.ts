/** Client-safe types for the Files feature. */

/** A file that was uploaded as a task attachment, joined to its task. */
export interface FileItem {
  id: string;
  path: string;
  filename: string;
  bytes: number;
  createdAt: number;
  taskId: string;
  taskTitle: string | null;
}

/** The result of POST /api/files (an upload that landed on the Agent37 instance). */
export interface UploadedFile {
  path: string;
  filename: string;
  bytes: number;
}
