import { Sparkles } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';

export default function SkillsPage() {
  return (
    <>
      <PageHeader items={[{ label: 'Skills' }]} />
      <EmptyState
        icon={Sparkles}
        title="Skills"
        description="Teach your agent reusable skills. Coming soon."
      />
    </>
  );
}
