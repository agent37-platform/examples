import type { ReactNode } from 'react';
import { Sidebar } from '@/components/layout/Sidebar';

/** The two-pane application frame: fixed sidebar + scrollable main content. */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-y-auto bg-background">{children}</main>
    </div>
  );
}
