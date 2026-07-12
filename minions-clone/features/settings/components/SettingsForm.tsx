'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Server, Cpu, Check } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Select, type SelectOption } from '@/components/ui/Select';
import { Spinner } from '@/components/ui/Spinner';
import { ApiError } from '@/lib/fetcher';
import { provisionInstance, updateSettings } from '@/features/settings/api/client';
import type { AppSettingsDTO } from '@/features/settings/types';
import type { TaskModelOption } from '@/features/tasks/types';

export interface SettingsFormProps {
  settings: AppSettingsDTO;
  models: TaskModelOption[];
}

const DEFAULT_VALUE = 'default';

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.hint ? `${err.message} — ${err.hint}` : err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}

export function SettingsForm({ settings, models }: SettingsFormProps) {
  const router = useRouter();

  // ---- Instance section ----------------------------------------------------
  const [provisioning, setProvisioning] = useState(false);
  const [provisionError, setProvisionError] = useState<string | null>(null);

  async function onProvision() {
    setProvisioning(true);
    setProvisionError(null);
    try {
      await provisionInstance();
      router.refresh();
    } catch (err) {
      setProvisionError(errorMessage(err));
    } finally {
      setProvisioning(false);
    }
  }

  // ---- Default model section ----------------------------------------------
  // Build the dropdown options: an implicit "Default" first, then the live models.
  const options = useMemo<SelectOption[]>(() => {
    const seen = new Set<string>();
    const list: SelectOption[] = [{ value: DEFAULT_VALUE, label: 'Default' }];
    for (const m of models) {
      if (m.id === DEFAULT_VALUE || seen.has(m.id)) continue;
      seen.add(m.id);
      list.push({ value: m.id, label: m.label });
    }
    return list;
  }, [models]);

  const initialModel = settings.defaultModel ?? DEFAULT_VALUE;
  const [model, setModel] = useState(initialModel);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const dirty = model !== initialModel;

  async function onSave() {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    const isDefault = model === DEFAULT_VALUE;
    const provider = isDefault ? null : models.find((m) => m.id === model)?.provider ?? null;
    try {
      await updateSettings({
        defaultModel: isDefault ? null : model,
        defaultProvider: provider,
      });
      setSaved(true);
      router.refresh();
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Instance */}
      <Card className="p-5">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
            <Server className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-foreground">Instance</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              The Agent37 container your tasks run in.
            </p>

            <dl className="mt-4 space-y-2 text-sm">
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">Template</dt>
                <dd className="truncate font-mono text-xs text-foreground">{settings.template}</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">Instance ID</dt>
                <dd className="truncate font-mono text-xs text-foreground">
                  {settings.instanceId ?? (
                    <span className="font-sans text-subtle">No instance yet</span>
                  )}
                </dd>
              </div>
            </dl>

            {settings.pinned ? (
              <p className="mt-4 text-xs text-subtle">
                Pinned via <span className="font-mono">AGENT37_INSTANCE_ID</span> — read-only here.
              </p>
            ) : settings.instanceId ? (
              <p className="mt-4 text-xs text-subtle">
                Provisioned and remembered. Tasks reuse this instance.
              </p>
            ) : (
              <div className="mt-4 space-y-2">
                <p className="text-xs text-subtle">
                  No instance has been created yet. One will be provisioned on your first task, or
                  set one up now.
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={onProvision}
                  disabled={provisioning}
                >
                  {provisioning ? (
                    <>
                      <Spinner className="h-4 w-4" />
                      Provisioning…
                    </>
                  ) : (
                    'Provision instance'
                  )}
                </Button>
                {provisionError ? (
                  <p className="text-xs text-danger">{provisionError}</p>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* Default model */}
      <Card className="p-5">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
            <Cpu className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-foreground">Default model</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Used for new tasks unless you pick a different model in the composer.
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Select
                value={model}
                onChange={(value) => {
                  setModel(value);
                  setSaved(false);
                  setSaveError(null);
                }}
                options={options}
                leadingIcon={Cpu}
                ariaLabel="Default model"
              />
              <Button variant="primary" size="sm" onClick={onSave} disabled={saving || !dirty}>
                {saving ? (
                  <>
                    <Spinner className="h-4 w-4" />
                    Saving…
                  </>
                ) : (
                  'Save'
                )}
              </Button>
              {saved && !dirty ? (
                <span className="inline-flex items-center gap-1 text-xs text-success">
                  <Check className="h-4 w-4" aria-hidden="true" />
                  Saved
                </span>
              ) : null}
            </div>
            {saveError ? <p className="mt-2 text-xs text-danger">{saveError}</p> : null}
          </div>
        </div>
      </Card>
    </div>
  );
}
