'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui/Card';
import { Textarea } from '@/components/ui/Textarea';
import { ApiError } from '@/lib/fetcher';
import { cn } from '@/lib/util';
import {
  MODE_LABELS,
  PRIORITY_LABELS,
  TASK_MODES,
  TASK_PRIORITIES,
  type TaskMode,
  type TaskModelOption,
  type TaskPriority,
} from '@/features/tasks/types';
import { createTask, fetchModels, uploadAttachment } from '@/features/tasks/api/client';
import { ComposerToolbar, type AttachmentChip } from './ComposerToolbar';

const FALLBACK_MODEL: TaskModelOption = { id: 'default', label: 'Default', provider: null, isDefault: true };

interface PendingAttachment extends AttachmentChip {
  path: string | null;
  bytes: number;
}

const priorityOptions = TASK_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }));
const modeOptions = TASK_MODES.map((m) => ({ value: m, label: MODE_LABELS[m] }));

/** The centered "What do you need done?" New Task experience. */
export function TaskComposer() {
  const router = useRouter();

  const [models, setModels] = useState<TaskModelOption[]>([FALLBACK_MODEL]);
  const [model, setModel] = useState('default');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [mode, setMode] = useState<TaskMode>('goal');

  const [prompt, setPrompt] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let active = true;
    fetchModels()
      .then((opts) => {
        if (!active || opts.length === 0) return;
        setModels(opts);
        const preferred = opts.find((o) => o.isDefault) ?? opts[0];
        setModel(preferred.id);
      })
      .catch(() => {
        // Tolerate failure — keep the fallback "Default" option.
      });
    return () => {
      active = false;
    };
  }, []);

  // Auto-grow the textarea to fit its content.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [prompt]);

  // ModelPicker needs the full option objects (provider + isDefault), not flattened pairs.
  const modelOptions = models;

  const uploading = attachments.some((a) => a.uploading);
  const canSubmit = prompt.trim().length > 0 && !uploading;

  const handleAttach = async (file: File) => {
    const key = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setError(null);
    setAttachments((prev) => [
      ...prev,
      { key, filename: file.name, uploading: true, path: null, bytes: file.size },
    ]);
    try {
      const uploaded = await uploadAttachment(file);
      setAttachments((prev) =>
        prev.map((a) =>
          a.key === key
            ? { ...a, uploading: false, path: uploaded.path, filename: uploaded.filename, bytes: uploaded.bytes }
            : a,
        ),
      );
    } catch (err) {
      setAttachments((prev) => prev.filter((a) => a.key !== key));
      setError(err instanceof Error ? err.message : 'Failed to upload file.');
    }
  };

  const handleRemove = (key: string) => {
    setAttachments((prev) => prev.filter((a) => a.key !== key));
  };

  const handleSubmit = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    const selected = models.find((m) => m.id === model);
    try {
      const task = await createTask({
        prompt: prompt.trim(),
        priority,
        mode,
        model: model === 'default' ? null : model,
        provider: selected?.provider ?? null,
        attachments: attachments
          .filter((a) => a.path)
          .map((a) => ({ path: a.path as string, filename: a.filename, bytes: a.bytes })),
      });
      router.push(`/tasks/${task.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong creating the task.');
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  };

  const chips: AttachmentChip[] = attachments.map((a) => ({
    key: a.key,
    filename: a.filename,
    uploading: a.uploading,
  }));

  return (
    <div className="mx-auto w-full max-w-3xl px-6">
      <h1 className="mb-8 text-center text-3xl font-semibold text-foreground">What do you need done?</h1>

      <Card className="rounded-2xl p-3">
        <Textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
          placeholder="Describe your task in detail..."
          className={cn(
            'min-h-[84px] resize-none border-0 bg-transparent px-2 py-1 text-base shadow-none',
            'focus-visible:ring-0 focus-visible:outline-none',
          )}
        />
        <div className="mt-2 px-1">
          <ComposerToolbar
            modelOptions={modelOptions}
            model={model}
            onModelChange={setModel}
            priorityOptions={priorityOptions}
            priority={priority}
            onPriorityChange={(v) => setPriority(v as TaskPriority)}
            modeOptions={modeOptions}
            mode={mode}
            onModeChange={(v) => setMode(v as TaskMode)}
            attachments={chips}
            onAttach={handleAttach}
            onRemoveAttachment={handleRemove}
            canSubmit={canSubmit}
            submitting={submitting}
            onSubmit={handleSubmit}
          />
        </div>
      </Card>

      {error ? (
        <p className="mt-3 text-center text-sm text-danger">{error}</p>
      ) : (
        <p className="mt-3 text-center text-sm text-muted-foreground">
          The more context you give, the better your assistant will do.
        </p>
      )}
    </div>
  );
}
