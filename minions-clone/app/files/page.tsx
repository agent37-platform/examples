import { PageHeader } from '@/components/layout/PageHeader';
import { FilesList } from '@/features/files/components/FilesList';
import { listFiles } from '@/server/services/files';

export const dynamic = 'force-dynamic';

export default async function FilesPage() {
  const files = await listFiles();

  return (
    <>
      <PageHeader items={[{ label: 'Files' }]} />
      <div className="px-6 py-6">
        <FilesList files={files} />
      </div>
    </>
  );
}
