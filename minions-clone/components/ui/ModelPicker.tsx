'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/util';

export interface ModelPickerOption {
  id: string;
  label: string;
  provider: string | null;
  isDefault: boolean;
}

export interface ModelPickerProps {
  value: string;
  onChange: (value: string) => void;
  options: ModelPickerOption[];
  leadingIcon?: LucideIcon;
  ariaLabel: string;
  size?: 'sm' | 'md';
  /** Shown as the provider group name for options with no provider of their own. */
  fallbackProvider?: string;
}

const sizes: Record<NonNullable<ModelPickerProps['size']>, string> = {
  sm: 'h-8 px-2.5 text-xs',
  md: 'h-9 px-3 text-sm',
};

/**
 * A command-palette-style model picker: a pill trigger (matching the other composer selects)
 * that opens a two-pane popover — providers on the left with model counts, a search box and
 * the matching models on the right. Closes on select, outside click, or Escape.
 */
export function ModelPicker({
  value,
  onChange,
  options,
  leadingIcon: LeadingIcon,
  ariaLabel,
  size = 'md',
  fallbackProvider = 'Agent37',
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = options.find((o) => o.id === value) ?? options[0];

  // Group options under a provider name, falling back for provider-less options.
  const groups = useMemo(() => {
    const map = new Map<string, ModelPickerOption[]>();
    for (const opt of options) {
      const name = opt.provider ?? fallbackProvider;
      const list = map.get(name) ?? [];
      list.push(opt);
      map.set(name, list);
    }
    return Array.from(map.entries()).map(([name, items]) => ({ name, items }));
  }, [options, fallbackProvider]);

  const q = query.trim().toLowerCase();
  const matches = (opt: ModelPickerOption, providerName: string) =>
    !q ||
    opt.id.toLowerCase().includes(q) ||
    opt.label.toLowerCase().includes(q) ||
    providerName.toLowerCase().includes(q);

  // Per-provider match counts, then drop empty providers while searching.
  const visibleGroups = useMemo(
    () =>
      groups
        .map((g) => ({ ...g, items: g.items.filter((opt) => matches(opt, g.name)) }))
        .filter((g) => g.items.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, q],
  );

  // Resolve which provider pane is shown: keep the active one if it still has matches,
  // otherwise fall back to the selected option's provider, otherwise the first group.
  const currentProviderName =
    visibleGroups.find((g) => g.name === activeProvider)?.name ??
    visibleGroups.find((g) => g.items.some((o) => o.id === value))?.name ??
    visibleGroups[0]?.name ??
    null;

  const currentItems = visibleGroups.find((g) => g.name === currentProviderName)?.items ?? [];

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

  // Reset transient state and focus the search box each time the popover opens.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveProvider(selected?.provider ?? null);
    const id = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const choose = (id: string) => {
    onChange(id);
    setOpen(false);
  };

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
          role="dialog"
          aria-label={ariaLabel}
          className={cn(
            'absolute left-0 z-20 mt-2 flex w-[34rem] max-w-[calc(100vw-2rem)] overflow-hidden',
            'rounded-2xl border border-border bg-background shadow-lg',
          )}
        >
          {/* Left: providers with model counts. */}
          <ul role="tablist" className="w-44 shrink-0 overflow-y-auto border-r border-border py-1.5">
            {visibleGroups.map((g) => {
              const isActive = g.name === currentProviderName;
              return (
                <li key={g.name}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => setActiveProvider(g.name)}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-sm',
                      'transition-colors hover:bg-muted',
                      isActive ? 'bg-muted font-semibold text-foreground' : 'text-foreground',
                    )}
                  >
                    <span className="truncate">{g.name}</span>
                    <span className="text-xs text-muted-foreground">{g.items.length}</span>
                  </button>
                </li>
              );
            })}
            {visibleGroups.length === 0 ? (
              <li className="px-4 py-2.5 text-sm text-muted-foreground">No matches</li>
            ) : null}
          </ul>

          {/* Right: search + matching models. */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="p-2.5">
              <div className="flex items-center gap-2 rounded-xl border border-input px-3 py-2.5">
                <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search models or providers..."
                  className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                />
              </div>
            </div>

            <ul role="listbox" aria-label="Models" className="max-h-72 overflow-y-auto border-t border-border py-1">
              {currentItems.map((opt) => {
                const isSelected = opt.id === value;
                return (
                  <li key={opt.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => choose(opt.id)}
                      className={cn(
                        'flex w-full items-center justify-between gap-3 px-4 py-3 text-left',
                        'transition-colors hover:bg-muted',
                        isSelected ? 'bg-muted' : '',
                      )}
                    >
                      <span className="truncate text-sm font-semibold text-foreground">{opt.id}</span>
                      {opt.isDefault ? (
                        <span className="shrink-0 text-sm text-muted-foreground">Default</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
              {currentItems.length === 0 ? (
                <li className="px-4 py-3 text-sm text-muted-foreground">No models found</li>
              ) : null}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}
