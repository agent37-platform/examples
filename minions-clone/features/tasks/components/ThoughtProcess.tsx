'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

/**
 * A collapsible "Thought process" disclosure that holds the assistant's reasoning. Renders
 * nothing when there is no reasoning to show.
 */
export function ThoughtProcess({
  reasoning,
  defaultOpen = false,
}: {
  reasoning: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (!reasoning.trim()) return null;

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />
        )}
        Thought process
      </button>
      {open && (
        <pre className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap border-l border-border pl-3 font-sans text-[13px] leading-relaxed text-muted-foreground">
          {reasoning}
        </pre>
      )}
    </div>
  );
}
