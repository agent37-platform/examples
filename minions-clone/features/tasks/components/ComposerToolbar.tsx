'use client';

import { useRef } from 'react';
import { ArrowUp, Loader2, Paperclip, Sparkles, Target, X, Zap } from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { Select } from '@/components/ui/Select';
import { ModelPicker, type ModelPickerOption } from '@/components/ui/ModelPicker';
import { cn } from '@/lib/util';

export interface AttachmentChip {
  /** A client-side key; uploading chips have no path yet. */
  key: string;
  filename: string;
  uploading: boolean;
}

interface SelectOption {
  value: string;
  label: string;
}

interface ComposerToolbarProps {
  modelOptions: ModelPickerOption[];
  model: string;
  onModelChange: (value: string) => void;

  priorityOptions: SelectOption[];
  priority: string;
  onPriorityChange: (value: string) => void;

  modeOptions: SelectOption[];
  mode: string;
  onModeChange: (value: string) => void;

  attachments: AttachmentChip[];
  onAttach: (file: File) => void;
  onRemoveAttachment: (key: string) => void;

  canSubmit: boolean;
  submitting: boolean;
  onSubmit: () => void;
}

/** The bottom control row of the composer: attach + model/priority/mode selects + send. */
export function ComposerToolbar({
  modelOptions,
  model,
  onModelChange,
  priorityOptions,
  priority,
  onPriorityChange,
  modeOptions,
  mode,
  onModeChange,
  attachments,
  onAttach,
  onRemoveAttachment,
  canSubmit,
  submitting,
  onSubmit,
}: ComposerToolbarProps) {
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <div className="flex flex-col gap-2">
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {attachments.map((a) => (
            <span
              key={a.key}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted/50 px-2.5 py-1 text-xs text-foreground"
            >
              {a.uploading ? (
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
              ) : (
                <Paperclip className="h-3 w-3 text-muted-foreground" />
              )}
              <span className="max-w-[180px] truncate">{a.filename}</span>
              <button
                type="button"
                aria-label={`Remove ${a.filename}`}
                onClick={() => onRemoveAttachment(a.key)}
                className="text-subtle transition-colors hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          ref={fileInput}
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onAttach(file);
            e.target.value = '';
          }}
        />
        <IconButton label="Attach a file" onClick={() => fileInput.current?.click()}>
          <Paperclip className="h-4 w-4" />
        </IconButton>

        <ModelPicker
          ariaLabel="Model"
          leadingIcon={Sparkles}
          size="sm"
          value={model}
          onChange={onModelChange}
          options={modelOptions}
        />
        <Select
          ariaLabel="Priority"
          leadingIcon={Zap}
          size="sm"
          value={priority}
          onChange={onPriorityChange}
          options={priorityOptions}
        />
        <Select
          ariaLabel="Mode"
          leadingIcon={Target}
          size="sm"
          value={mode}
          onChange={onModeChange}
          options={modeOptions}
        />

        <div className="ml-auto">
          <IconButton
            label="Send task"
            variant="solid"
            disabled={!canSubmit || submitting}
            onClick={onSubmit}
            className={cn('h-9 w-9 rounded-full')}
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
          </IconButton>
        </div>
      </div>
    </div>
  );
}
