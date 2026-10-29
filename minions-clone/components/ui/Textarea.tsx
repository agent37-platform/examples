import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/util';

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

/** A styled multi-line text input — matches Input, grows to a min height. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cn(
        'min-h-[80px] w-full rounded-lg border border-input bg-background px-3 py-2 text-sm',
        'placeholder:text-subtle',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
});
