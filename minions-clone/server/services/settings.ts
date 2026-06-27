import 'server-only';
import { getConfig } from '../config';
import { getSettings, updateSettings } from '../db/repositories/settings';
import { ensureInstanceId } from './instance';
import type { AppSettingsDTO, UpdateSettingsRequest } from '@/features/settings/types';

export async function getAppSettings(): Promise<AppSettingsDTO> {
  const cfg = getConfig();
  const s = await getSettings();
  return {
    instanceId: cfg.pinnedInstanceId ?? s.instanceId ?? null,
    pinned: Boolean(cfg.pinnedInstanceId),
    template: cfg.template,
    defaultModel: s.defaultModel ?? null,
    defaultProvider: s.defaultProvider ?? null,
    budgetTopupMicros: s.budgetTopupMicros ?? cfg.budgetTopupMicros,
  };
}

export async function updateAppSettings(patch: UpdateSettingsRequest): Promise<AppSettingsDTO> {
  await updateSettings({
    defaultModel: patch.defaultModel ?? null,
    defaultProvider: patch.defaultProvider ?? null,
  });
  return getAppSettings();
}

/** Provision the shared instance on demand (used by the Settings "set up instance" action). */
export async function provisionInstanceNow(): Promise<string> {
  return ensureInstanceId();
}
