/** Client-safe types for the Settings feature. */

export interface AppSettingsDTO {
  /** The instance the app is using (pinned via env or remembered after provisioning). */
  instanceId: string | null;
  /** True when the instance id came from AGENT37_INSTANCE_ID and can't be changed in the UI. */
  pinned: boolean;
  template: string;
  defaultModel: string | null;
  defaultProvider: string | null;
  budgetTopupMicros: number;
}

export interface UpdateSettingsRequest {
  defaultModel?: string | null;
  defaultProvider?: string | null;
}
