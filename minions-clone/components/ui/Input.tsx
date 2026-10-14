import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/util';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

/** A styled single-line text input — hairline border, soft focus ring. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-9 w-full rounded-lg border border-input bg-background px-3 text-sm',
        'placeholder:text-subtle',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
});
