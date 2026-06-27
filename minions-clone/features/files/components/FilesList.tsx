import Link from 'next/link';
import { Download, File as FileIcon, FolderOpen } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn, timeAgo } from '@/lib/util';
import type { FileItem } from '@/features/files/types';

/** Render a byte count as a short human-readable size ("2.4 KB", "1.1 MB"). */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  const rounded = exponent === 0 ? value : Math.round(value * 10) / 10;
  return `${rounded} ${units[exponent]}`;
}

export interface FilesListProps {
  files: FileItem[];
}

/**
 * The Files table: one row per uploaded attachment, with a download link.
 * A Server Component — pure render off the passed-in list.
 */
export function FilesList({ files }: FilesListProps) {
  if (files.length === 0) {
    return (
      <EmptyState
        icon={FolderOpen}
        title="No files yet"
        description="Files you attach to tasks show up here."
      />
    );
  }

  const now = Date.now();

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <ul className="divide-y divide-border">
        {files.map((file) => (
          <li
            key={file.id}
            className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-muted/50"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
              <FileIcon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </div>

            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-foreground">{file.filename}</p>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                {file.taskId ? (
                  <Link
                    href={`/tasks/${file.taskId}`}
                    className="truncate transition-colors hover:text-foreground"
                  >
                    {file.taskTitle ?? 'Untitled task'}
                  </Link>
                ) : (
                  <span className="truncate">{file.taskTitle ?? 'Untitled task'}</span>
                )}
              </div>
            </div>

            <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:inline">
              {formatBytes(file.bytes)}
            </span>
            <span className="hidden w-20 shrink-0 text-right text-xs text-subtle sm:inline">
              {timeAgo(file.createdAt, now)}
            </span>

            <a
              href={`/api/files/content?path=${encodeURIComponent(file.path)}`}
              className={cn(
                'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors',
                'border border-input bg-background hover:bg-muted',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              )}
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              Download
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
