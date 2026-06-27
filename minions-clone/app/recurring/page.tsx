import { Repeat2 } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';

export default function RecurringPage() {
  return (
    <>
      <PageHeader items={[{ label: 'Recurring' }]} />
      <EmptyState
        icon={Repeat2}
        title="Recurring tasks"
        description="Schedule tasks to run on a cadence. Coming soon — the data model and UI shell are in place."
        action={
          <Button variant="secondary" disabled>
            New recurring task
          </Button>
        }
      />
    </>
  );
}
