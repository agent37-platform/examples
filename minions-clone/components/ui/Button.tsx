import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/util';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg' | 'icon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variants: Record<Variant, string> = {
  primary: 'bg-foreground text-background hover:bg-foreground/90',
  secondary: 'border border-input bg-background hover:bg-muted',
  ghost: 'hover:bg-muted text-foreground',
  danger: 'border border-input bg-background text-danger hover:bg-danger/5',
};

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-sm rounded-lg gap-1.5',
  md: 'h-9 px-4 text-sm rounded-lg gap-2',
  lg: 'h-11 px-5 text-base rounded-xl gap-2',
  icon: 'h-9 w-9 rounded-lg',
};

/**
 * The base button. Presentational and unstyled-opinionated to match the monochrome reference:
 * a near-black "primary", hairline-bordered "secondary", and a quiet "ghost".
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'secondary', size = 'md', type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex items-center justify-center font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:pointer-events-none disabled:opacity-50',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
});
