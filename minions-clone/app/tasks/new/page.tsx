import { PageHeader } from '@/components/layout/PageHeader';
import { TaskComposer } from '@/features/tasks/components/TaskComposer';

export default function NewTaskPage() {
  return (
    <>
      <PageHeader items={[{ label: 'Tasks', href: '/tasks' }, { label: 'New Task' }]} />
      <div className="relative flex min-h-[calc(100vh-3.5rem)] flex-col">
        <div className="flex flex-1 items-center justify-center py-16">
          <TaskComposer />
        </div>
      </div>
    </>
  );
}
