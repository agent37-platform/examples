import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge conditional class names and de-conflict Tailwind utilities.
 * The one styling helper every UI primitive uses.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format an epoch-ms timestamp as a short relative string ("2m ago", "just now"). */
export function timeAgo(epochMs: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** Derive a short, human task title from the first line of a prompt. */
export function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.trim().split('\n')[0]?.trim() ?? '';
  if (firstLine.length <= 70) return firstLine || 'Untitled task';
  return firstLine.slice(0, 67).trimEnd() + '…';
}
