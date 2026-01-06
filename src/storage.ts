/**
 * GAS Masking Proxy - KV Storage Utilities
 */

import type { App, AppWithRules, MaskingRule, Env } from './types';

// Generate a short random ID (6 characters)
export function generateId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// App storage keys
const APP_PREFIX = 'app:';
const APP_LIST_KEY = 'apps:list';

/**
 * Get all registered apps
 */
export async function getAllApps(env: Env): Promise<App[]> {
  const appIds = await env.APPS.get<string[]>(APP_LIST_KEY, 'json');
  if (!appIds || appIds.length === 0) {
    return [];
  }

  const apps: App[] = [];
  for (const id of appIds) {
    const app = await getApp(env, id);
    if (app) {
      apps.push(app);
    }
  }
  return apps;
}

/**
 * Get a single app by ID
 */
export async function getApp(env: Env, id: string): Promise<App | null> {
  const app = await env.APPS.get<App>(`${APP_PREFIX}${id}`, 'json');
  return app;
}

/**
 * Get app with rules
 */
export async function getAppWithRules(env: Env, id: string): Promise<AppWithRules | null> {
  const app = await getApp(env, id);
  if (!app) return null;

  const rules = await getRules(env, id);
  const useDefaultRules = await getUseDefaultRules(env, id);

  return {
    ...app,
    rules,
    useDefaultRules,
  };
}

/**
 * Create a new app
 */
export async function createApp(env: Env, name: string, url: string): Promise<App> {
  const id = generateId();
  const now = new Date().toISOString();
  const app: App = {
    id,
    name,
    url,
    createdAt: now,
    updatedAt: now,
  };

  // Save app
  await env.APPS.put(`${APP_PREFIX}${id}`, JSON.stringify(app));

  // Update app list
  const appIds = (await env.APPS.get<string[]>(APP_LIST_KEY, 'json')) || [];
  appIds.push(id);
  await env.APPS.put(APP_LIST_KEY, JSON.stringify(appIds));

  // Set default rules flag to true
  await setUseDefaultRules(env, id, true);

  return app;
}

/**
 * Update an existing app
 */
export async function updateApp(
  env: Env,
  id: string,
  updates: Partial<Pick<App, 'name' | 'url'>>
): Promise<App | null> {
  const app = await getApp(env, id);
  if (!app) return null;

  const updatedApp: App = {
    ...app,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  await env.APPS.put(`${APP_PREFIX}${id}`, JSON.stringify(updatedApp));
  return updatedApp;
}

/**
 * Delete an app
 */
export async function deleteApp(env: Env, id: string): Promise<boolean> {
  const app = await getApp(env, id);
  if (!app) return false;

  // Delete app
  await env.APPS.delete(`${APP_PREFIX}${id}`);

  // Delete rules
  await env.APPS.delete(`${APP_PREFIX}${id}:rules`);
  await env.APPS.delete(`${APP_PREFIX}${id}:useDefaultRules`);

  // Update app list
  const appIds = (await env.APPS.get<string[]>(APP_LIST_KEY, 'json')) || [];
  const newAppIds = appIds.filter((appId) => appId !== id);
  await env.APPS.put(APP_LIST_KEY, JSON.stringify(newAppIds));

  return true;
}

/**
 * Get rules for an app
 */
export async function getRules(env: Env, appId: string): Promise<MaskingRule[]> {
  const rules = await env.APPS.get<MaskingRule[]>(`${APP_PREFIX}${appId}:rules`, 'json');
  return rules || [];
}

/**
 * Save rules for an app
 */
export async function saveRules(env: Env, appId: string, rules: MaskingRule[]): Promise<void> {
  await env.APPS.put(`${APP_PREFIX}${appId}:rules`, JSON.stringify(rules));
}

/**
 * Add a rule to an app
 */
export async function addRule(
  env: Env,
  appId: string,
  rule: Omit<MaskingRule, 'id'>
): Promise<MaskingRule> {
  const rules = await getRules(env, appId);
  const newRule: MaskingRule = {
    ...rule,
    id: `rule_${generateId()}`,
  };
  rules.push(newRule);
  await saveRules(env, appId, rules);
  return newRule;
}

/**
 * Update a rule
 */
export async function updateRule(
  env: Env,
  appId: string,
  ruleId: string,
  updates: Partial<Omit<MaskingRule, 'id'>>
): Promise<MaskingRule | null> {
  const rules = await getRules(env, appId);
  const index = rules.findIndex((r) => r.id === ruleId);
  if (index === -1) return null;

  rules[index] = { ...rules[index], ...updates };
  await saveRules(env, appId, rules);
  return rules[index];
}

/**
 * Delete a rule
 */
export async function deleteRule(env: Env, appId: string, ruleId: string): Promise<boolean> {
  const rules = await getRules(env, appId);
  const newRules = rules.filter((r) => r.id !== ruleId);
  if (newRules.length === rules.length) return false;

  await saveRules(env, appId, newRules);
  return true;
}

/**
 * Get useDefaultRules setting
 */
export async function getUseDefaultRules(env: Env, appId: string): Promise<boolean> {
  const value = await env.APPS.get(`${APP_PREFIX}${appId}:useDefaultRules`);
  return value !== 'false';
}

/**
 * Set useDefaultRules setting
 */
export async function setUseDefaultRules(
  env: Env,
  appId: string,
  useDefault: boolean
): Promise<void> {
  await env.APPS.put(`${APP_PREFIX}${appId}:useDefaultRules`, String(useDefault));
}
