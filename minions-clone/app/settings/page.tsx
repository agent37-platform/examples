import { PageHeader } from '@/components/layout/PageHeader';
import { SettingsForm } from '@/features/settings/components/SettingsForm';
import { getAppSettings } from '@/server/services/settings';
import { getModelOptions } from '@/server/services/tasks';
import type { TaskModelOption } from '@/features/tasks/types';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const settings = await getAppSettings();
  let models: TaskModelOption[] = [];
  try {
    models = await getModelOptions();
  } catch {
    models = [];
  }

  return (
    <>
      <PageHeader items={[{ label: 'Settings' }]} />
      <div className="mx-auto max-w-2xl px-6 py-6">
        <SettingsForm settings={settings} models={models} />
      </div>
    </>
  );
}
