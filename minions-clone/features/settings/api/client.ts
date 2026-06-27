import { api } from '@/lib/fetcher';
import type { AppSettingsDTO, UpdateSettingsRequest } from '@/features/settings/types';

/** Fetch the app's current settings (instance, default model, etc.). */
export function getSettings(): Promise<AppSettingsDTO> {
  return api.get<AppSettingsDTO>('/api/settings');
}

/** Persist a settings patch and return the refreshed settings. */
export function updateSettings(body: UpdateSettingsRequest): Promise<AppSettingsDTO> {
  return api.patch<AppSettingsDTO>('/api/settings', body);
}

/** Provision the shared Agent37 instance on demand. Can take a while on a cold create. */
export function provisionInstance(): Promise<{ instanceId: string }> {
  return api.post<{ instanceId: string }>('/api/settings/provision');
}
