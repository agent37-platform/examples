'use client';

import { useRouter } from 'next/navigation';
import { Spinner } from '@/components/ui/Spinner';
import { useTaskChat } from '@/features/tasks/hooks/useTaskChat';
import { deleteTask } from '@/features/tasks/api/client';
import type { TaskWithMessages } from '@/features/tasks/types';
import { TaskHeader } from './TaskHeader';
import { MessageThread } from './MessageThread';
import { FollowupComposer } from './FollowupComposer';

/**
 * The task detail experience: an editable header, the multi-turn chat thread, and a pinned
 * follow-up composer. All conversation state lives in useTaskChat; this component is layout.
 */
export function TaskDetail({ task }: { task: TaskWithMessages }) {
  const router = useRouter();
  const chat = useTaskChat({ task });

  const streaming = chat.livePhase === 'streaming' || chat.livePhase === 'connecting';
  const lastMessage = chat.messages[chat.messages.length - 1];
  const warming = chat.livePhase === 'connecting' && !(lastMessage?.content);

  const handleDelete = async () => {
    await deleteTask(task.id);
    router.push('/tasks');
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Header spans the full content width: title far-left, actions far-right. */}
        <div className="w-full px-8 py-6">
          <TaskHeader
            taskId={task.id}
            title={chat.title}
            status={chat.status}
            updatedAt={task.updatedAt}
            onRename={chat.rename}
            onMarkComplete={chat.markComplete}
            onReopen={chat.reopen}
            onDelete={handleDelete}
          />
        </div>

        {/* Only the conversation is constrained to a comfortable reading column. */}
        <div className="mx-auto w-full max-w-3xl px-6 pb-10">
          {warming && (
            <div className="mb-6 flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="h-4 w-4" />
              <span>Warming up the agent…</span>
            </div>
          )}
          <MessageThread messages={chat.messages} streaming={streaming} error={chat.error} />
        </div>
      </div>

      <div className="shrink-0 border-t border-border bg-background">
        <div className="mx-auto w-full max-w-3xl px-6 py-4">
          <FollowupComposer
            disabled={chat.status === 'running' || chat.livePhase === 'connecting'}
            sending={chat.sending}
            onSend={chat.send}
          />
        </div>
      </div>
    </div>
  );
}
