import 'server-only';

/**
 * Server-only configuration. The Agent37 key is workspace-scoped and must never be bundled
 * into client code — importing 'server-only' makes a client import fail the build loudly.
 */

export class Agent37ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Agent37ConfigError';
  }
}

export interface ServerConfig {
  apiKey: string;
  apiBase: string;
  appDomain: string;
  template: string;
  budgetTopupMicros: number;
  /** Optional pinned instance id (10-char DNS label). The provisioned id is persisted in the local
   * DB (settings.instance_id) and survives restarts, so this is an override: set it to force a
   * specific instance (e.g. a shared one) instead of whatever the DB remembers / would provision. */
  pinnedInstanceId: string | null;
}

const INSTANCE_ID = /^[a-z0-9]{10}$/;

let cached: ServerConfig | null = null;

export function getConfig(): ServerConfig {
  if (cached) return cached;

  const apiKey = process.env.AGENT37_API_KEY?.trim();
  if (!apiKey) {
    throw new Agent37ConfigError(
      'AGENT37_API_KEY is not set. Copy .env.example to .env and add your key from https://www.agent37.com/dashboard/cloud/api-keys',
    );
  }

  const pinned = process.env.AGENT37_INSTANCE_ID?.trim() || null;
  if (pinned && !INSTANCE_ID.test(pinned)) {
    throw new Agent37ConfigError('AGENT37_INSTANCE_ID must be a 10-character lowercase alphanumeric instance id.');
  }

  cached = {
    apiKey,
    apiBase: process.env.AGENT37_API_BASE?.trim() || 'https://api.agent37.com',
    appDomain: process.env.AGENT37_APP_DOMAIN?.trim() || 'agent37.app',
    template: process.env.AGENT37_TEMPLATE?.trim() || 'agent37-hermes',
    budgetTopupMicros: Number(process.env.AGENT37_BUDGET_TOPUP_MICROS || 1_000_000),
    pinnedInstanceId: pinned,
  };
  return cached;
}

/** Validate an instance id before interpolating it into a host name. */
export function isInstanceId(id: string): boolean {
  return INSTANCE_ID.test(id);
}

/** The per-instance Agent API base, e.g. https://ab12cd34ef.agent37.app */
export function instanceOrigin(id: string): string {
  return `https://${id}.${getConfig().appDomain}`;
}
