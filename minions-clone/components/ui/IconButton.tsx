import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/util';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible label — icon-only buttons must name themselves for screen readers. */
  label: string;
  variant?: 'ghost' | 'solid';
}

/** A square, icon-only button (sidebar toggles, the composer send button, etc.). */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, label, variant = 'ghost', type = 'button', children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:pointer-events-none disabled:opacity-40',
        variant === 'ghost' ? 'text-muted-foreground hover:bg-muted hover:text-foreground' : 'bg-foreground text-background hover:bg-foreground/90',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});
