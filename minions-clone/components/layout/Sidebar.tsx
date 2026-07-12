'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Columns3,
  Folder,
  PanelLeftClose,
  Repeat2,
  Settings,
  Sparkles,
  SquarePen,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/util';
import { IconButton } from '@/components/ui/IconButton';
import { Logo } from '@/components/layout/Logo';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const MAIN_ITEMS: NavItem[] = [
  { href: '/tasks/new', label: 'New Task', icon: SquarePen },
  { href: '/tasks', label: 'Tasks', icon: Columns3 },
  { href: '/recurring', label: 'Recurring', icon: Repeat2 },
  { href: '/files', label: 'Files', icon: Folder },
];

const ADVANCED_ITEMS: NavItem[] = [
  { href: '/skills', label: 'Skills', icon: Sparkles },
];

const SETTINGS_ITEM: NavItem = { href: '/settings', label: 'Settings', icon: Settings };

/**
 * Decide whether a nav row is the active one for the current pathname.
 * '/tasks/new' matches only exactly; '/tasks' matches the list and any
 * '/tasks/<id>' detail page but never '/tasks/new'; everything else is an
 * exact-or-prefix match.
 */
function isActive(href: string, pathname: string): boolean {
  if (href === '/tasks/new') return pathname === '/tasks/new';
  if (href === '/tasks') {
    return pathname === '/tasks' || (pathname.startsWith('/tasks/') && pathname !== '/tasks/new');
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavRow({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = isActive(item.href, pathname);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-10 items-center gap-3 rounded-lg px-3 text-sm transition-colors',
        active
          ? 'bg-muted font-medium text-foreground'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <Icon className="h-[18px] w-[18px] shrink-0" />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

/** The fixed left navigation column. */
export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-background">
      <div className="flex h-14 items-center justify-between px-4">
        <Link href="/tasks/new" className="flex items-center gap-2" aria-label="Minions home">
          <Logo />
          <span className="text-sm font-semibold text-foreground">Minions</span>
        </Link>
        <IconButton label="Collapse sidebar">
          <PanelLeftClose className="h-[18px] w-[18px]" />
        </IconButton>
      </div>

      <nav className="flex flex-1 flex-col px-3 pb-3">
        <div className="flex flex-col gap-0.5">
          {MAIN_ITEMS.map((item) => (
            <NavRow key={item.href} item={item} pathname={pathname} />
          ))}
        </div>

        <p className="mb-1 mt-6 px-3 text-xs font-medium uppercase tracking-wider text-subtle">
          Advanced
        </p>
        <div className="flex flex-col gap-0.5">
          {ADVANCED_ITEMS.map((item) => (
            <NavRow key={item.href} item={item} pathname={pathname} />
          ))}
        </div>

        <div className="mt-auto">
          <NavRow item={SETTINGS_ITEM} pathname={pathname} />
        </div>
      </nav>
    </aside>
  );
}
