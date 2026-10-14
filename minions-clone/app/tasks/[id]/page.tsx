import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/layout/PageHeader';
import { TaskDetail } from '@/features/tasks/components/TaskDetail';
import { getTaskDetail } from '@/server/services/tasks';

export const dynamic = 'force-dynamic';

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = await getTaskDetail(id);
  if (!task) notFound();
  return (
    <div className="flex h-full flex-col">
      <PageHeader items={[{ label: 'Tasks', href: '/tasks' }, { label: 'Task' }]} />
      <TaskDetail task={task} />
    </div>
  );
}
