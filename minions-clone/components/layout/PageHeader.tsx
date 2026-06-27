import { Fragment, type ReactNode } from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export interface PageHeaderProps {
  items: BreadcrumbItem[];
  actions?: ReactNode;
}

/** The top breadcrumb bar that sits above each page's content. */
export function PageHeader({ items, actions }: PageHeaderProps) {
  return (
    <header className="flex h-14 items-center justify-between border-b border-border px-6">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <Fragment key={`${item.label}-${index}`}>
              {index > 0 && (
                <ChevronRight className="h-4 w-4 shrink-0 text-subtle" aria-hidden="true" />
              )}
              {last || !item.href ? (
                <span
                  className={
                    last
                      ? 'font-medium text-foreground'
                      : 'text-muted-foreground'
                  }
                  aria-current={last ? 'page' : undefined}
                >
                  {item.label}
                </span>
              ) : (
                <Link
                  href={item.href}
                  className="text-muted-foreground transition-colors hover:text-foreground"
                >
                  {item.label}
                </Link>
              )}
            </Fragment>
          );
        })}
      </nav>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}
