'use client';

import { useRef, useState } from 'react';
import { ArrowUp, Paperclip, Sparkles, Target, Zap } from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { Select } from '@/components/ui/Select';
import { Card } from '@/components/ui/Card';
import { Textarea } from '@/components/ui/Textarea';
import { cn } from '@/lib/util';
import {
  MODE_LABELS,
  PRIORITY_LABELS,
  TASK_MODES,
  TASK_PRIORITIES,
} from '@/features/tasks/types';

const MODEL_OPTIONS = [{ value: 'default', label: 'default', icon: Sparkles }];
const PRIORITY_OPTIONS = TASK_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }));
const MODE_OPTIONS = TASK_MODES.map((m) => ({ value: m, label: MODE_LABELS[m] }));

const MAX_TEXTAREA_HEIGHT = 200;

/**
 * The bottom composer for sending a follow-up in the SAME session. The model/priority/mode pills
 * are visual affordances for the next turn — the backend reuses the task's own model/session.
 */
export function FollowupComposer({
  disabled,
  sending,
  onSend,
}: {
  disabled: boolean;
  sending: boolean;
  onSend: (input: string) => void;
}) {
  const [value, setValue] = useState('');
  const [model, setModel] = useState('default');
  const [priority, setPriority] = useState('medium');
  const [mode, setMode] = useState('goal');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canSend = value.trim().length > 0 && !disabled && !sending;

  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  };

  const submit = () => {
    if (!canSend) return;
    onSend(value.trim());
    setValue('');
    const el = textareaRef.current;
    if (el) el.style.height = 'auto';
  };

  return (
    <Card className="rounded-2xl p-2.5">
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          grow(e.target);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={1}
        placeholder="Reply or ask a follow-up…"
        className={cn(
          'min-h-0 max-h-[200px] resize-none border-0 bg-transparent px-2 py-1.5 text-[15px] shadow-none',
          'focus-visible:outline-none focus-visible:ring-0',
        )}
      />

      <div className="mt-1 flex items-center gap-2">
        <IconButton label="Attach a file" disabled>
          <Paperclip className="h-4 w-4" />
        </IconButton>

        <Select
          ariaLabel="Model"
          leadingIcon={Sparkles}
          size="sm"
          value={model}
          onChange={setModel}
          options={MODEL_OPTIONS}
        />
        <Select
          ariaLabel="Priority"
          leadingIcon={Zap}
          size="sm"
          value={priority}
          onChange={setPriority}
          options={PRIORITY_OPTIONS}
        />
        <Select
          ariaLabel="Mode"
          leadingIcon={Target}
          size="sm"
          value={mode}
          onChange={setMode}
          options={MODE_OPTIONS}
        />

        <div className="ml-auto">
          <IconButton
            label="Send follow-up"
            variant="solid"
            disabled={!canSend}
            onClick={submit}
            className="h-9 w-9 rounded-full"
          >
            <ArrowUp className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
    </Card>
  );
}
