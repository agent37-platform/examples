'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/util';

export interface SelectOption {
  value: string;
  label: string;
  icon?: LucideIcon;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  leadingIcon?: LucideIcon;
  ariaLabel: string;
  size?: 'sm' | 'md';
}

const sizes: Record<NonNullable<SelectProps['size']>, string> = {
  sm: 'h-8 px-2.5 text-xs',
  md: 'h-9 px-3 text-sm',
};

/** A custom dropdown styled as a pill — opens a popover list, closes on outside click / Escape. */
export function Select({
  value,
  onChange,
  options,
  leadingIcon: LeadingIcon,
  ariaLabel,
  size = 'md',
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-lg border border-input bg-background',
          'transition-colors hover:bg-muted',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          sizes[size],
        )}
      >
        {LeadingIcon ? <LeadingIcon className="h-4 w-4 text-muted-foreground" /> : null}
        <span className="truncate">{selected?.label ?? ''}</span>
        <ChevronDown className="h-4 w-4 text-muted-foreground" />
      </button>

      {open ? (
        <div
          role="listbox"
          className="absolute left-0 z-20 mt-1 min-w-full rounded-lg border border-border bg-background p-1 shadow-sm"
        >
          {options.map((option) => {
            const OptionIcon = option.icon;
            const isSelected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                  'transition-colors hover:bg-muted',
                  'focus-visible:outline-none focus-visible:bg-muted',
                )}
              >
                {OptionIcon ? <OptionIcon className="h-4 w-4 text-muted-foreground" /> : null}
                <span className="flex-1 truncate">{option.label}</span>
                {isSelected ? <Check className="h-4 w-4 text-foreground" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
