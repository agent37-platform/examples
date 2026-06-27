'use client';

import { Check, Wrench, X } from 'lucide-react';
import { Spinner } from '@/components/ui/Spinner';
import { cn } from '@/lib/util';
import type { UiMessage, UiTool } from '@/features/tasks/hooks/useTaskChat';
import { ThoughtProcess } from './ThoughtProcess';

/** One turn in the thread: a right-aligned user bubble, or a left-aligned assistant answer. */
export function ChatMessage({ message, streaming = false }: { message: UiMessage; streaming?: boolean }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-muted px-4 py-2 text-[15px] text-foreground">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="text-foreground">
      <ThoughtProcess reasoning={message.reasoning} defaultOpen={streaming && !message.content} />

      {message.tools.length > 0 && (
        <div className="mb-2 space-y-1.5">
          {message.tools.map((tool) => (
            <ToolChip key={tool.id} tool={tool} />
          ))}
        </div>
      )}

      <div className="whitespace-pre-wrap text-[15px] leading-relaxed text-foreground">
        {message.content}
        {streaming && message.pending && <span className="animate-caret">▍</span>}
      </div>
    </div>
  );
}

function ToolChip({ tool }: { tool: UiTool }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-2.5 py-1 text-sm">
      <Wrench className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="truncate text-foreground">{tool.label ?? tool.tool}</span>
      <span className="shrink-0">
        {tool.state === 'started' && <Spinner className="h-3.5 w-3.5 text-running" />}
        {tool.state === 'completed' && <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />}
        {tool.state === 'failed' && <X className={cn('h-3.5 w-3.5 text-danger')} aria-hidden="true" />}
      </span>
    </div>
  );
}
