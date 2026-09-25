import { z } from 'zod';
import type { Paths } from './paths.js';
import { ACCOUNT_ID_RE } from './types.js';
import type { Account, AccountBudget, AuthMode, Config, Defaults, ProviderId } from './types.js';
import { readText, withLock, writeFileAtomic } from './fsx.js';

export const MAX_TIMEOUT_SEC = 86_400;

export const DEFAULTS: Defaults = {
  permission: 'edit',
  timeoutSec: 1800,
  maxAttempts: 3,
  cooldownSec: 1800,
};

export const BudgetSchema: z.ZodType<AccountBudget> = z.object({
  tokens5h: z.number().int().positive().optional(),
  tokens7d: z.number().int().positive().optional(),
});

export const AccountSchema: z.ZodType<Account> = z.object({
  id: z.string().regex(ACCOUNT_ID_RE, 'invalid account id'),
  provider: z.enum(['claude', 'codex']),
  profileDir: z.string().min(1),
  weight: z.number().positive().default(1),
  budget: BudgetSchema.default({}),
  enabled: z.boolean().default(true),
  auth: z.enum(['profile', 'token']).default('profile'),
  model: z.string().min(1).optional(),
  createdAt: z.string().default(() => new Date().toISOString()),
});

export const DefaultsSchema: z.ZodType<Defaults> = z.object({
  permission: z.enum(['read-only', 'edit', 'full']).default(DEFAULTS.permission),
  timeoutSec: z.number().int().positive().max(MAX_TIMEOUT_SEC).default(DEFAULTS.timeoutSec),
  maxAttempts: z.number().int().positive().default(DEFAULTS.maxAttempts),
  cooldownSec: z.number().int().nonnegative().default(DEFAULTS.cooldownSec),
});

export const ConfigSchema: z.ZodType<Config> = z.object({
  version: z.literal(1).default(1),
  strategy: z.enum(['least-used', 'round-robin', 'weighted', 'priority']).default('least-used'),
  defaults: DefaultsSchema.default({ ...DEFAULTS }),
  accounts: z
    .array(AccountSchema)
    .default([])
    .refine((list) => new Set(list.map((a) => a.id)).size === list.length, { message: 'duplicate account id' }),
});

export function defaultConfig(): Config {
  return {
    version: 1,
    strategy: 'least-used',
    defaults: { ...DEFAULTS },
    accounts: [],
  };
}

export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
      return `${where}: ${issue.message}`;
    })
    .join('; ');
}

export function parseConfig(raw: unknown, source = 'config'): Config {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid ${source}: ${formatIssues(parsed.error)}`);
  return parsed.data;
}

export function parseConfigText(text: string, file: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid JSON in ${file}: ${(err as Error).message}`);
  }
  return parseConfig(raw, `config ${file}`);
}

export async function loadConfig(paths: Paths): Promise<Config> {
  const text = await readText(paths.config);
  if (text === undefined) {
    const config = defaultConfig();
    await saveConfig(paths, config);
    return config;
  }
  return parseConfigText(text, paths.config);
}

export async function saveConfig(paths: Paths, config: Config): Promise<void> {
  const valid = parseConfig(config);
  await withLock(paths.home, () => writeFileAtomic(paths.config, `${JSON.stringify(valid, null, 2)}\n`, 0o600));
}

export function getAccount(config: Config, id: string): Account | undefined {
  return config.accounts.find((a) => a.id === id);
}

export function upsertAccount(config: Config, account: Account): Config {
  const copy = { ...account, budget: { ...account.budget } };
  const exists = config.accounts.some((a) => a.id === account.id);
  const accounts = exists
    ? config.accounts.map((a) => (a.id === account.id ? copy : a))
    : [...config.accounts, copy];
  return { ...config, defaults: { ...config.defaults }, accounts };
}

export function removeAccount(config: Config, id: string): Config {
  return {
    ...config,
    defaults: { ...config.defaults },
    accounts: config.accounts.filter((a) => a.id !== id),
  };
}

export function assertAccountId(id: string): void {
  if (!ACCOUNT_ID_RE.test(id)) {
    throw new Error(
      `invalid account id "${id}": use 1-32 characters of a-z, 0-9, ".", "_" or "-", starting with a letter or digit`,
    );
  }
}

export function newAccount(input: {
  id: string;
  provider: ProviderId;
  profileDir: string;
  auth?: AuthMode;
  weight?: number;
  budget?: AccountBudget;
  model?: string;
}): Account {
  assertAccountId(input.id);
  const account: Account = {
    id: input.id,
    provider: input.provider,
    profileDir: input.profileDir,
    weight: input.weight ?? 1,
    budget: { ...(input.budget ?? {}) },
    enabled: true,
    auth: input.auth ?? 'profile',
    createdAt: new Date().toISOString(),
  };
  if (input.model !== undefined) account.model = input.model;
  return AccountSchema.parse(account);
}
