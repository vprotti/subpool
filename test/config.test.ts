import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePaths, type Paths } from '../src/core/paths.js';
import {
  ConfigSchema,
  DEFAULTS,
  MAX_TIMEOUT_SEC,
  defaultConfig,
  loadConfig,
  saveConfig,
  getAccount,
  upsertAccount,
  removeAccount,
  assertAccountId,
  newAccount,
  parseConfig,
  parseConfigText,
} from '../src/core/config.js';
import type { Account, Config } from '../src/core/types.js';

let home: string;
let paths: Paths;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'subpool-config-'));
  paths = resolvePaths(home);
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

function sampleAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'work',
    provider: 'claude',
    profileDir: path.join(home, 'profiles', 'claude-work'),
    weight: 1,
    budget: {},
    enabled: true,
    auth: 'profile',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('ConfigSchema', () => {
  it('parses an empty object to defaultConfig()', () => {
    expect(ConfigSchema.parse({})).toEqual(defaultConfig());
  });

  it('defaultConfig matches the documented defaults', () => {
    const cfg = defaultConfig();
    expect(cfg.version).toBe(1);
    expect(cfg.strategy).toBe('least-used');
    expect(cfg.defaults).toEqual({ permission: 'edit', timeoutSec: 1800, maxAttempts: 3, cooldownSec: 1800 });
    expect(cfg.defaults).toEqual(DEFAULTS);
    expect(cfg.accounts).toEqual([]);
    expect(defaultConfig().defaults).not.toBe(cfg.defaults);
  });

  it('fills defaults for a partial account', () => {
    const cfg = ConfigSchema.parse({
      accounts: [{ id: 'a1', provider: 'codex', profileDir: '/p/codex-a1' }],
    });
    const acc = cfg.accounts[0]!;
    expect(acc.weight).toBe(1);
    expect(acc.budget).toEqual({});
    expect(acc.enabled).toBe(true);
    expect(acc.auth).toBe('profile');
    expect(acc.model).toBeUndefined();
    expect(typeof acc.createdAt).toBe('string');
    expect(Number.isNaN(Date.parse(acc.createdAt))).toBe(false);
  });

  it('rejects invalid account ids', () => {
    for (const id of ['', 'Work', '-lead', 'a b', 'a'.repeat(33), 'x/y']) {
      expect(() => ConfigSchema.parse({ accounts: [{ id, provider: 'claude', profileDir: '/p' }] })).toThrow();
    }
  });

  it('accepts valid account ids', () => {
    for (const id of ['a', 'work', 'claude-2', 'me.home_1', '0abc', 'a'.repeat(32)]) {
      expect(() => ConfigSchema.parse({ accounts: [{ id, provider: 'claude', profileDir: '/p' }] })).not.toThrow();
    }
  });

  it('rejects unknown providers, strategies and duplicate ids', () => {
    expect(() => parseConfig({ accounts: [{ id: 'a', provider: 'gemini', profileDir: '/p' }] })).toThrow(/provider/);
    expect(() => parseConfig({ strategy: 'random' })).toThrow(/strategy/);
    expect(() =>
      parseConfig({
        accounts: [
          { id: 'a', provider: 'claude', profileDir: '/p' },
          { id: 'a', provider: 'codex', profileDir: '/q' },
        ],
      }),
    ).toThrow(/duplicate account id/);
  });

  it('bounds defaults.timeoutSec to one day', () => {
    expect(MAX_TIMEOUT_SEC).toBe(86_400);
    expect(parseConfig({ defaults: { timeoutSec: 86_400 } }).defaults.timeoutSec).toBe(86_400);
    expect(() => parseConfig({ defaults: { timeoutSec: 3_000_000 } })).toThrow(/timeoutSec/);
  });

  it('parseConfigText reports invalid JSON with the file name', () => {
    expect(() => parseConfigText('{oops', '/x/config.json')).toThrow(/invalid JSON in \/x\/config\.json/);
  });
});

describe('loadConfig / saveConfig', () => {
  it('creates the file with defaults, parent dirs and mode 0600 when missing', async () => {
    const nested = resolvePaths(path.join(home, 'deep', 'er'));
    const cfg = await loadConfig(nested);
    expect(cfg).toEqual(defaultConfig());
    const stat = await fs.stat(nested.config);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(nested.config, 'utf8'))).toEqual(defaultConfig());
    const entries = await fs.readdir(path.dirname(nested.config));
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });

  it('roundtrips a full config', async () => {
    const cfg: Config = {
      version: 1,
      strategy: 'weighted',
      defaults: { permission: 'full', timeoutSec: 60, maxAttempts: 2, cooldownSec: 300 },
      accounts: [
        sampleAccount({ id: 'work', weight: 2, budget: { tokens5h: 100000, tokens7d: 1000000 }, model: 'opus' }),
        sampleAccount({ id: 'gpt', provider: 'codex', profileDir: '/p/codex-gpt', auth: 'profile', enabled: false }),
      ],
    };
    await saveConfig(paths, cfg);
    const loaded = await loadConfig(paths);
    expect(loaded).toEqual(cfg);
    const entries = await fs.readdir(home);
    expect(entries).toEqual(['config.json']);
  });

  it('applies defaults when the file is partial', async () => {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      paths.config,
      JSON.stringify({ accounts: [{ id: 'solo', provider: 'claude', profileDir: '/p/claude-solo', auth: 'token' }] }),
    );
    const loaded = await loadConfig(paths);
    expect(loaded.version).toBe(1);
    expect(loaded.strategy).toBe('least-used');
    expect(loaded.defaults).toEqual(DEFAULTS);
    expect(loaded.accounts).toHaveLength(1);
    expect(loaded.accounts[0]).toMatchObject({ id: 'solo', auth: 'token', weight: 1, enabled: true, budget: {} });
  });

  it('throws a readable error on invalid JSON', async () => {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(paths.config, '{ "strategy": ');
    await expect(loadConfig(paths)).rejects.toThrow(/invalid JSON in .*config\.json/);
  });

  it('throws a readable error on schema violations', async () => {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(paths.config, JSON.stringify({ accounts: [{ id: 'BAD ID', provider: 'claude', profileDir: '/p' }] }));
    await expect(loadConfig(paths)).rejects.toThrow(/invalid config .*accounts\.0\.id/);
  });

  it('saveConfig refuses an invalid config', async () => {
    const bad = { ...defaultConfig(), strategy: 'nope' } as unknown as Config;
    await expect(saveConfig(paths, bad)).rejects.toThrow(/invalid config/);
    await expect(fs.stat(paths.config)).rejects.toThrow();
  });
});

describe('account helpers', () => {
  it('getAccount finds by id', () => {
    const cfg = upsertAccount(defaultConfig(), sampleAccount());
    expect(getAccount(cfg, 'work')?.provider).toBe('claude');
    expect(getAccount(cfg, 'nope')).toBeUndefined();
  });

  it('upsertAccount appends without mutating the input', () => {
    const base = defaultConfig();
    const acc = sampleAccount();
    const next = upsertAccount(base, acc);
    expect(base.accounts).toEqual([]);
    expect(next.accounts).toHaveLength(1);
    expect(next.accounts[0]).toEqual(acc);
    expect(next.accounts[0]).not.toBe(acc);
    expect(next).not.toBe(base);
    expect(next.defaults).toEqual(base.defaults);
  });

  it('upsertAccount replaces in place keeping order', () => {
    const a = sampleAccount({ id: 'a' });
    const b = sampleAccount({ id: 'b', provider: 'codex' });
    const cfg = upsertAccount(upsertAccount(defaultConfig(), a), b);
    const updated = upsertAccount(cfg, { ...a, weight: 5, model: 'sonnet' });
    expect(cfg.accounts[0]!.weight).toBe(1);
    expect(updated.accounts.map((x) => x.id)).toEqual(['a', 'b']);
    expect(updated.accounts[0]).toMatchObject({ weight: 5, model: 'sonnet' });
    expect(updated.accounts[1]).toBe(cfg.accounts[1]);
  });

  it('removeAccount returns a new config and leaves the original alone', () => {
    const cfg = upsertAccount(upsertAccount(defaultConfig(), sampleAccount({ id: 'a' })), sampleAccount({ id: 'b' }));
    const removed = removeAccount(cfg, 'a');
    expect(cfg.accounts.map((x) => x.id)).toEqual(['a', 'b']);
    expect(removed.accounts.map((x) => x.id)).toEqual(['b']);
    expect(removed).not.toBe(cfg);
    expect(removeAccount(cfg, 'missing').accounts).toEqual(cfg.accounts);
  });

  it('assertAccountId accepts valid ids and rejects invalid ones with a readable message', () => {
    expect(() => assertAccountId('work-1')).not.toThrow();
    expect(() => assertAccountId('Work')).toThrow(/invalid account id "Work"/);
    expect(() => assertAccountId('')).toThrow(/invalid account id/);
    expect(() => assertAccountId('.hidden')).toThrow(/invalid account id/);
  });

  it('newAccount fills defaults and validates the id', () => {
    const acc = newAccount({ id: 'gpt-1', provider: 'codex', profileDir: '/p/codex-gpt-1' });
    expect(acc).toMatchObject({
      id: 'gpt-1',
      provider: 'codex',
      profileDir: '/p/codex-gpt-1',
      weight: 1,
      budget: {},
      enabled: true,
      auth: 'profile',
    });
    expect(acc.model).toBeUndefined();
    expect(Number.isNaN(Date.parse(acc.createdAt))).toBe(false);
    const rich = newAccount({
      id: 'work',
      provider: 'claude',
      profileDir: '/p/claude-work',
      auth: 'token',
      weight: 3,
      budget: { tokens5h: 50000 },
      model: 'opus',
    });
    expect(rich).toMatchObject({ auth: 'token', weight: 3, budget: { tokens5h: 50000 }, model: 'opus' });
    expect(() => newAccount({ id: 'Bad Id', provider: 'claude', profileDir: '/p' })).toThrow(/invalid account id/);
    expect(() => newAccount({ id: 'ok', provider: 'claude', profileDir: '/p', weight: 0 })).toThrow();
  });
});
