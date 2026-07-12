import { TaskBoard } from '@/features/tasks/components/TaskBoard';
import { listTasks } from '@/server/services/tasks';

export const dynamic = 'force-dynamic';

/** The Tasks page IS the Kanban board — it renders its own "Tasks" title (no breadcrumb header). */
export default async function TasksPage() {
  const tasks = await listTasks();
  return (
    <div className="h-full min-h-0">
      <TaskBoard initialTasks={tasks} />
    </div>
  );
}
