import 'server-only';
import { createInstance, instanceHealthy } from '../agent37/client';
import { getConfig } from '../config';
import { getSettings, updateSettings } from '../db/repositories/settings';

/**
 * Resolves the one shared Agent37 instance the whole app uses (decision: one instance, one
 * session per task). Resolution order: a pinned id from env, then a remembered id in the DB,
 * then provision a new instance once and remember it. A module-level promise guards against two
 * concurrent first-run requests each creating a (billed) container.
 */

let provisioning: Promise<string> | null = null;

/** Resolve the instance id WITHOUT provisioning. Returns null if none exists yet. */
export async function getExistingInstanceId(): Promise<string | null> {
  const cfg = getConfig();
  if (cfg.pinnedInstanceId) return cfg.pinnedInstanceId;
  const settings = await getSettings();
  return settings.instanceId ?? null;
}

export async function ensureInstanceId(): Promise<string> {
  const cfg = getConfig();
  if (cfg.pinnedInstanceId) return cfg.pinnedInstanceId;

  const settings = await getSettings();
  if (settings.instanceId) return settings.instanceId;

  if (!provisioning) {
    provisioning = (async () => {
      const fresh = await getSettings();
      if (fresh.instanceId) return fresh.instanceId; // another request won the race
      const instance = await createInstance({ name: 'minions-clone' });
      await updateSettings({ instanceId: instance.id });
      return instance.id;
    })().catch((err) => {
      provisioning = null; // let a later request retry provisioning
      throw err;
    });
  }
  return provisioning;
}

/** Resolve the instance id and whether the agent inside has booted enough to answer. */
export async function ensureInstanceReady(): Promise<{ id: string; ready: boolean }> {
  const id = await ensureInstanceId();
  const ready = await instanceHealthy(id);
  return { id, ready };
}
