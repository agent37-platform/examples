'use client';

import { useEffect, useRef } from 'react';
import type { StreamErrorBody } from '@/features/tasks/lib/stream';
import type { UiMessage } from '@/features/tasks/hooks/useTaskChat';
import { ChatMessage } from './ChatMessage';

/**
 * The ordered chat thread. The last assistant message renders as "streaming" while a turn is
 * live, and the view auto-scrolls to the bottom as tokens arrive.
 */
export function MessageThread({
  messages,
  streaming,
  error,
}: {
  messages: UiMessage[];
  streaming: boolean;
  error?: StreamErrorBody;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  const last = messages[messages.length - 1];
  // Re-scroll whenever the thread length or the live message's text grows.
  const signature = `${messages.length}:${last?.content.length ?? 0}:${last?.reasoning.length ?? 0}`;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [signature]);

  const lastIsEmpty = !last || (!last.content && !last.reasoning);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      {messages.map((message, index) => {
        const isLast = index === messages.length - 1;
        return (
          <ChatMessage
            key={message.id}
            message={message}
            streaming={streaming && isLast && message.role === 'assistant'}
          />
        );
      })}

      {error && lastIsEmpty && (
        <div className="rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm text-danger">
          <p className="font-medium">{error.message}</p>
          {error.hint && <p className="mt-1 text-xs text-danger/80">{error.hint}</p>}
        </div>
      )}

      <div ref={endRef} />
    </div>
  );
}
