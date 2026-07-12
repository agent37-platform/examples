import 'server-only';
import { downloadFile, uploadFile } from '../agent37/client';
import { listAllFiles } from '../db/repositories/files';
import { ensureInstanceId } from './instance';
import type { FileItem, UploadedFile } from '@/features/files/types';

/** Forward a browser multipart upload to the shared instance; returns where it landed. */
export async function uploadToInstance(form: FormData): Promise<UploadedFile> {
  const instanceId = await ensureInstanceId();
  return uploadFile(instanceId, form);
}

export async function listFiles(): Promise<FileItem[]> {
  return listAllFiles();
}

/** Open a download stream for a file path on the instance (for GET /api/files/content). */
export async function openFileDownload(path: string, signal?: AbortSignal): Promise<Response> {
  const instanceId = await ensureInstanceId();
  return downloadFile(instanceId, path, signal);
}
