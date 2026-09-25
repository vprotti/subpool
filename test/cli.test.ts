import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommanderError } from 'commander';
import { resolvePaths, type Paths } from '../src/core/paths.js';
import { loadConfig } from '../src/core/config.js';
import { Ledger } from '../src/core/ledger.js';
import type { Account, AccountUsage, Config, Job, LoginOptions, ProviderAdapter, ProviderId, RoutedResult, RunEvent, RunRequest, RunResult } from '../src/core/types.js';
import {
  CliError,
  accountStatus,
  applyAccountChanges,
  buildRunRequest,
  buildSelectOptions,
  exitCodeFor,
  findOnPath,
  formatCooldown,
  formatDoctor,
  formatDuration,
  formatEvent,
  formatTable,
  formatTokens,
  formatUtilization,
  isInside,
  isJobSnapshot,
  isMain,
  isStaleJob,
  jobDisplayStatus,
  jobsRows,
  loginHint,
  lsRows,
  nodeVersionCheck,
  parseProvider,
  parsePositiveInt,
  parseStrategy,
  providerTotals,
  readVersion,
  relativeProfile,
  runCli,
  runSummary,
  truncate,
  usageError,
  usageRows,
  withCancelSignal,
} from '../src/cli.js';

const NOW = 1_800_000_000_000;

function account(over: Partial<Account> = {}): Account {
  return {
    id: 'a',
    provider: 'claude',
    profileDir: '/tmp/profiles/claude-a',
    weight: 1,
    budget: {},
    enabled: true,
    auth: 'profile',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function usage(over: Partial<AccountUsage> = {}): AccountUsage {
  return {
    accountId: 'a',
    provider: 'claude',
    enabled: true,
    window5h: { tokens: 0, runs: 0, costUsd: 0 },
    window7d: { tokens: 0, runs: 0, costUsd: 0 },
    utilization: 0,
    ...over,
  };
}

function config(over: Partial<Config> = {}): Config {
  return {
    version: 1,
    strategy: 'least-used',
    defaults: { permission: 'edit', timeoutSec: 1800, maxAttempts: 3, cooldownSec: 1800 },
    accounts: [],
    ...over,
  };
}

interface FakeOptions {
  loggedIn?: boolean;
  detail?: string;
  loginError?: string;
  result?: Partial<RunResult>;
  events?: RunEvent[];
  waitForAbort?: boolean;
}

interface FakeAdapter extends ProviderAdapter {
  logins: Array<{ profileDir: string; opts: LoginOptions }>;
  statusCalls: string[];
  runs: RunRequest[];
}

function fakeProvider(id: ProviderId, opts: FakeOptions = {}): FakeAdapter {
  const adapter: FakeAdapter = {
    id,
    binary: id,
    logins: [],
    statusCalls: [],
    runs: [],
    async login(profileDir, loginOpts) {
      adapter.logins.push({ profileDir, opts: loginOpts });
      if (opts.loginError) throw new Error(opts.loginError);
    },
    async status(profileDir) {
      adapter.statusCalls.push(profileDir);
      const status: { loggedIn: boolean; detail?: string } = { loggedIn: opts.loggedIn ?? true };
      if (opts.detail !== undefined) status.detail = opts.detail;
      return status;
    },
    async run(req, acc, onEvent) {
      adapter.runs.push(req);
      for (const e of opts.events ?? []) onEvent?.(e);
      if (opts.waitForAbort) {
        await new Promise<void>((resolve) => {
          if (req.signal?.aborted) resolve();
          else req.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return {
          ok: false,
          output: '',
          usage: { input: 0, output: 0, cached: 0, total: 0 },
          provider: id,
          accountId: acc.id,
          durationMs: 1,
          exitCode: null,
          error: 'cancelled',
        };
      }
      return {
        ok: true,
        output: `hello from ${acc.id}`,
        usage: { input: 10, output: 5, cached: 0, total: 15 },
        provider: id,
        accountId: acc.id,
        durationMs: 1500,
        exitCode: 0,
        ...opts.result,
      };
    },
  };
  return adapter;
}

interface Harness {
  home: string;
  paths: Paths;
  env: NodeJS.ProcessEnv;
  claude: FakeAdapter;
  codex: FakeAdapter;
  stdout: string;
  stderr: string;
  secrets: string[];
  prompts: string[];
  signals: EventEmitter;
  run: (argv: string[]) => Promise<number>;
}

async function harness(fakes: { claude?: FakeOptions; codex?: FakeOptions } = {}): Promise<Harness> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'subpool-cli-'));
  const paths = resolvePaths(home);
  const claude = fakeProvider('claude', fakes.claude);
  const codex = fakeProvider('codex', fakes.codex);
  const h: Harness = {
    home,
    paths,
    env: { SUBPOOL_HOME: home, PATH: '' },
    claude,
    codex,
    stdout: '',
    stderr: '',
    secrets: [],
    prompts: [],
    signals: new EventEmitter(),
    run: async (argv) => {
      h.stdout = '';
      h.stderr = '';
      return runCli(argv, {
        stdout: (t) => {
          h.stdout += t;
        },
        stderr: (t) => {
          h.stderr += t;
        },
        env: h.env,
        providers: { claude: h.claude, codex: h.codex },
        now: () => NOW,
        cwd: home,
        signals: h.signals,
        readSecret: async (prompt) => {
          h.prompts.push(prompt);
          return h.secrets.shift() ?? '';
        },
      });
    },
  };
  return h;
}

describe('formatTable', () => {
  it('aligns columns, pads headers and trims trailing whitespace', () => {
    const text = formatTable(['ID', 'N'], [['alpha', '1'], ['b', '1234']], ['left', 'right']);
    expect(text).toBe('ID        N\nalpha     1\nb      1234\n');
    for (const line of text.split('\n')) expect(line).toBe(line.replace(/\s+$/, ''));
  });

  it('fills missing cells and prints only the header for no rows', () => {
    expect(formatTable(['A', 'BB'], [])).toBe('A  BB\n');
    expect(formatTable(['A', 'BB'], [['x']])).toBe('A  BB\nx\n');
  });
});

describe('formatting helpers', () => {
  it('formats tokens with k/M suffixes', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(-5)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(12345)).toBe('12.3k');
    expect(formatTokens(123456)).toBe('123k');
    expect(formatTokens(1_234_567)).toBe('1.2M');
    expect(formatTokens(2_500_000_000)).toBe('2.5G');
  });

  it('formats durations', () => {
    expect(formatDuration(0)).toBe('<1s');
    expect(formatDuration(999)).toBe('<1s');
    expect(formatDuration(12_000)).toBe('12s');
    expect(formatDuration(185_000)).toBe('3m 05s');
    expect(formatDuration(3_720_000)).toBe('1h 02m');
  });

  it('truncates to one line', () => {
    expect(truncate('a  b\n c', 10)).toBe('a b c');
    expect(truncate('abcdefghijklmnop', 6)).toBe('abcde…');
  });

  it('builds ls rows with status, budgets, utilization and cooldown', () => {
    const accounts = [
      account({ id: 'work', budget: { tokens5h: 100_000 }, model: 'opus' }),
      account({ id: 'off', provider: 'codex', enabled: false }),
      account({ id: 'cool' }),
    ];
    const usages = [
      usage({ accountId: 'work', window5h: { tokens: 25_000, runs: 2, costUsd: 0 }, window7d: { tokens: 40_000, runs: 3, costUsd: 0 }, utilization: 0.25 }),
      usage({ accountId: 'off', provider: 'codex', enabled: false }),
      usage({ accountId: 'cool', cooldownUntil: NOW + 60_000, cooldownReason: 'rate' }),
    ];
    const rows = lsRows(accounts, usages, NOW);
    expect(rows[0]).toEqual(['work', 'claude', 'ready', '25.0k/100k', '40.0k', '25%', '-', 'opus']);
    expect(rows[1]?.slice(0, 3)).toEqual(['off', 'codex', 'disabled']);
    expect(rows[1]?.[5]).toBe('-');
    expect(rows[2]?.[2]).toBe('cooldown');
    expect(rows[2]?.[6]).toMatch(/^until \d{2}:\d{2}$/);
    expect(accountStatus(accounts[2]!, usages[2], NOW + 120_000)).toBe('ready');
    expect(formatCooldown(usages[2], NOW + 120_000)).toBe('-');
    expect(formatUtilization(accounts[2]!, usages[2])).toBe('-');
  });

  it('builds usage rows with per-provider totals', () => {
    const usages = [
      usage({ accountId: 'a', window5h: { tokens: 100, runs: 1, costUsd: 0.5 }, window7d: { tokens: 300, runs: 2, costUsd: 1.25 }, lastUsedAt: NOW }),
      usage({ accountId: 'b', window5h: { tokens: 50, runs: 1, costUsd: 0 }, window7d: { tokens: 50, runs: 1, costUsd: 0 } }),
      usage({ accountId: 'c', provider: 'codex', window5h: { tokens: 7, runs: 1, costUsd: 0 }, window7d: { tokens: 7, runs: 1, costUsd: 0 } }),
    ];
    const rows = usageRows(usages, NOW);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual(['a', 'claude', '100', '1', '300', '2', '$1.25', expect.stringMatching(/^\d{2}:\d{2}$/)]);
    expect(rows[1]?.[7]).toBe('-');
    expect(rows[3]).toEqual(['total (claude)', 'claude', '150', '2', '350', '3', '$1.25', '']);
    expect(rows[4]).toEqual(['total (codex)', 'codex', '7', '1', '7', '1', '-', '']);
    const totals = providerTotals(usages);
    expect(totals.claude.accounts).toBe(2);
    expect(totals.codex.window7d.tokens).toBe(7);
  });

  it('builds job rows and validates snapshots', () => {
    const job: Job = {
      id: 'job_1',
      status: 'done',
      createdAt: NOW - 10_000,
      startedAt: NOW - 9_000,
      finishedAt: NOW - 4_000,
      request: { prompt: 'refactor the   parser\nand add tests for everything in the module', cwd: '/tmp', permission: 'edit', timeoutSec: 60 },
      options: {},
      provider: 'codex',
      accountId: 'gpt',
      attempts: [],
      events: [],
    };
    const rows = jobsRows([job, { ...job, id: 'job_2', status: 'running', finishedAt: undefined, provider: undefined, accountId: undefined }], NOW);
    expect(rows[0]).toEqual(['job_1', 'done', 'codex', 'gpt', expect.stringMatching(/\d{2}:\d{2}$/), '5s', 'refactor the parser and add tests for e…']);
    expect(rows[1]?.slice(1, 4)).toEqual(['running', '-', '-']);
    expect(rows[1]?.[5]).toBe('9s');
    expect(isJobSnapshot(job)).toBe(true);
    expect(isJobSnapshot({ id: 'x' })).toBe(false);
    expect(isJobSnapshot(null)).toBe(false);
  });

  it('marks running snapshots that outlived their timeout as stale', () => {
    const running: Job = {
      id: 'job_r',
      status: 'running',
      createdAt: NOW - 60_000,
      startedAt: NOW - 60_000,
      request: { prompt: 'p', cwd: '/tmp', permission: 'edit', timeoutSec: 60 },
      options: {},
      attempts: [],
      events: [],
    };
    expect(isStaleJob(running, NOW)).toBe(false);
    expect(jobDisplayStatus(running, NOW)).toBe('running');
    const later = NOW + 3 * 60_000 + 5 * 60_000 + 1;
    expect(isStaleJob(running, later)).toBe(true);
    expect(jobDisplayStatus(running, later)).toBe('stale');
    expect(jobsRows([running], later)[0]?.[1]).toBe('stale');
    expect(isStaleJob({ ...running, status: 'done', finishedAt: NOW }, later)).toBe(false);
    expect(isStaleJob({ ...running, status: 'queued', startedAt: undefined }, later)).toBe(true);
  });

  it('formats run events for stderr streaming', () => {
    expect(formatEvent({ type: 'start', at: 1 }, 'a')).toBe('[a] started');
    expect(formatEvent({ type: 'message', at: 1, text: 'hi' }, 'a')).toBe('[a] hi');
    expect(formatEvent({ type: 'message', at: 1 }, 'a')).toBeUndefined();
    expect(formatEvent({ type: 'tool', at: 1, text: 'Bash ls' }, 'a')).toBe('[a] > Bash ls');
    expect(formatEvent({ type: 'stderr', at: 1, text: 'warn' }, 'a')).toBe('[a] ! warn');
    expect(formatEvent({ type: 'end', at: 1 }, 'a')).toBe('[a] finished');
  });

  it('summarizes routed results', () => {
    const result: RoutedResult = {
      ok: true,
      output: '',
      usage: { input: 1000, output: 500, cached: 0, total: 1500 },
      provider: 'claude',
      accountId: 'work',
      durationMs: 12_000,
      exitCode: 0,
      attempts: [
        { accountId: 'x', provider: 'claude', durationMs: 1 },
        { accountId: 'work', provider: 'claude', durationMs: 2 },
      ],
    };
    expect(runSummary(result)).toBe('[work] done in 12s, 1.5k tokens, 2 attempts');
  });

  it('formats doctor checks', () => {
    const text = formatDoctor([
      { level: 'ok', label: 'node', detail: 'v22' },
      { level: 'fail', label: 'claude binary', detail: 'missing' },
      { level: 'warn', label: 'accounts', detail: 'none' },
    ]);
    expect(text).toBe('ok    node: v22\nFAIL  claude binary: missing\nwarn  accounts: none\n');
    expect(nodeVersionCheck('22.1.0').level).toBe('ok');
    expect(nodeVersionCheck('18.20.0').level).toBe('fail');
  });
});

describe('parsing and paths', () => {
  it('maps errors to exit codes', () => {
    expect(exitCodeFor(new CliError('x'))).toBe(1);
    expect(exitCodeFor(usageError('x'))).toBe(2);
    expect(exitCodeFor(new CommanderError(1, 'commander.unknownCommand', 'x'))).toBe(2);
    expect(exitCodeFor(new CommanderError(0, 'commander.helpDisplayed', ''))).toBe(0);
    expect(exitCodeFor(new CommanderError(0, 'commander.version', ''))).toBe(0);
    expect(exitCodeFor(new CommanderError(0, 'commander.help', '(outputHelp)'))).toBe(0);
    expect(exitCodeFor(new CommanderError(1, 'commander.help', ''))).toBe(2);
    expect(exitCodeFor(new Error('boom'))).toBe(1);
  });

  it('validates providers, strategies and integers', () => {
    expect(parseProvider('codex')).toBe('codex');
    expect(() => parseProvider('gemini')).toThrow(/unknown provider/);
    expect(parseStrategy('weighted')).toBe('weighted');
    expect(() => parseStrategy('random')).toThrow(/unknown strategy/);
    expect(parsePositiveInt('42')).toBe(42);
    expect(() => parsePositiveInt('0')).toThrow(/positive integer/);
    expect(() => parsePositiveInt('1.5')).toThrow(/positive integer/);
  });

  it('applies account changes', () => {
    const base = account({ budget: { tokens5h: 10, tokens7d: 20 }, model: 'x' });
    const none = applyAccountChanges(base, {});
    expect(none.changed).toBe(false);
    const changed = applyAccountChanges(base, { disable: true, weight: 3, tokens5h: 0, tokens7d: 500, model: '-' });
    expect(changed.changed).toBe(true);
    expect(changed.account).toMatchObject({ enabled: false, weight: 3, budget: { tokens7d: 500 } });
    expect(changed.account.budget.tokens5h).toBeUndefined();
    expect(changed.account.model).toBeUndefined();
    expect(base.budget.tokens5h).toBe(10);
  });

  it('builds run requests from options and config defaults and requires an existing cwd', async () => {
    const cfg = config();
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'subpool-run-'));
    try {
      await fs.mkdir(path.join(base, 'sub'));
      const req = buildRunRequest('do it', cfg, { cwd: 'sub' }, base);
      expect(req).toEqual({ prompt: 'do it', cwd: path.resolve(base, 'sub'), permission: 'edit', timeoutSec: 1800 });
      const custom = buildRunRequest('x', cfg, { permission: 'full', timeout: 5, model: 'm' }, base);
      expect(custom).toMatchObject({ cwd: base, permission: 'full', timeoutSec: 5, model: 'm' });
      expect(() => buildRunRequest('x', cfg, { cwd: 'missing' }, base)).toThrow(/does not exist/);
      try {
        buildRunRequest('x', cfg, { cwd: 'missing' }, base);
      } catch (err) {
        expect(exitCodeFor(err)).toBe(2);
      }
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
    expect(buildSelectOptions({})).toEqual({});
    expect(buildSelectOptions({ provider: 'codex', account: 'gpt' })).toEqual({ provider: 'codex', account: 'gpt' });
  });

  it('withCancelSignal aborts on SIGINT/SIGTERM and removes its listeners afterwards', async () => {
    const emitter = new EventEmitter();
    const seen: boolean[] = [];
    const result = await withCancelSignal(emitter, async (signal) => {
      seen.push(signal.aborted);
      emitter.emit('SIGINT');
      seen.push(signal.aborted);
      return 'done';
    });
    expect(result).toBe('done');
    expect(seen).toEqual([false, true]);
    expect(emitter.listenerCount('SIGINT')).toBe(0);
    expect(emitter.listenerCount('SIGTERM')).toBe(0);
    await expect(
      withCancelSignal(emitter, async () => {
        throw new Error('inner');
      }),
    ).rejects.toThrow('inner');
    expect(emitter.listenerCount('SIGTERM')).toBe(0);
  });

  it('computes profile paths and hints', () => {
    const paths = resolvePaths('/home/u/.subpool');
    expect(relativeProfile(paths, '/home/u/.subpool/profiles/claude-work')).toBe(path.join('profiles', 'claude-work'));
    expect(relativeProfile(paths, '/elsewhere/dir')).toBe('/elsewhere/dir');
    expect(isInside('/a/b', '/a/b/c')).toBe(true);
    expect(isInside('/a/b', '/a/b')).toBe(false);
    expect(isInside('/a/b', '/a/bc')).toBe(false);
    expect(loginHint('claude', '/p')).toBe('CLAUDE_CONFIG_DIR=/p claude auth login');
    expect(loginHint('codex', '/p')).toBe('CODEX_HOME=/p codex login');
  });

  it('reads the package version and detects main module', () => {
    expect(readVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(isMain(undefined, import.meta.url)).toBe(false);
    expect(isMain('/does/not/exist', import.meta.url)).toBe(false);
    expect(isMain(new URL(import.meta.url).pathname, import.meta.url)).toBe(true);
  });

  it('finds executables on a PATH', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'subpool-path-'));
    try {
      const bin = path.join(dir, 'fakebin');
      await fs.writeFile(bin, '#!/bin/sh\n', { mode: 0o755 });
      const env = { PATH: `${path.join(dir, 'missing')}${path.delimiter}${dir}` };
      expect(await findOnPath('fakebin', env)).toBe(bin);
      expect(await findOnPath('nothere', env)).toBeUndefined();
      expect(await findOnPath(bin, { PATH: '' })).toBe(bin);
      expect(await findOnPath('fakebin', { PATH: '' })).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('runCli', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });

  afterEach(async () => {
    await fs.rm(h.home, { recursive: true, force: true });
  });

  it('prints the version and help with exit 0', async () => {
    expect(await h.run(['--version'])).toBe(0);
    expect(h.stdout.trim()).toBe(readVersion());
    expect(await h.run(['--help'])).toBe(0);
    expect(h.stdout).toContain('link');
    expect(h.stdout).toContain('doctor');
  });

  it('returns 2 for unknown commands and bad option values', async () => {
    expect(await h.run(['bogus'])).toBe(2);
    expect(h.stderr).toMatch(/unknown command/);
    expect(h.stderr.trim().split('\n')).toHaveLength(1);
    expect(await h.run(['run', '--timeout', 'abc', 'task'])).toBe(2);
    expect(h.stderr).toMatch(/positive integer/);
    expect(await h.run([])).toBe(2);
  });

  it('gets and sets the strategy on an empty home', async () => {
    expect(await h.run(['strategy'])).toBe(0);
    expect(h.stdout).toBe('least-used\n');
    expect(await h.run(['strategy', 'weighted'])).toBe(0);
    expect(h.stdout).toBe('strategy set to weighted\n');
    expect(await h.run(['strategy'])).toBe(0);
    expect(h.stdout).toBe('weighted\n');
    expect((await loadConfig(h.paths)).strategy).toBe('weighted');
    expect(await h.run(['strategy', 'random'])).toBe(2);
    expect(h.stderr).toMatch(/^error: unknown strategy "random"/);
  });

  it('lists an empty pool', async () => {
    expect(await h.run(['ls', '--json'])).toBe(0);
    expect(JSON.parse(h.stdout)).toEqual([]);
    expect(await h.run(['ls'])).toBe(0);
    expect(h.stdout).toContain('no accounts linked');
    expect(await h.run(['usage', '--json'])).toBe(0);
    expect(JSON.parse(h.stdout)).toEqual({ accounts: [], totals: expect.any(Object) });
    expect(await h.run(['jobs', '--json'])).toBe(0);
    expect(JSON.parse(h.stdout)).toEqual([]);
    expect(await h.run(['jobs'])).toBe(0);
    expect(h.stdout).toContain('no jobs');
    expect(await h.run(['check'])).toBe(0);
    expect(h.stdout).toContain('no accounts linked');
  });

  it('fails with exit 1 when setting a missing account', async () => {
    expect(await h.run(['set', 'missing', '--enable'])).toBe(1);
    expect(h.stderr).toBe('error: account "missing" not found (run: subpool ls)\n');
    expect(await h.run(['set', 'missing', '--enable', '--disable'])).toBe(2);
    expect(await h.run(['unlink', 'missing'])).toBe(1);
  });

  it('rejects invalid ids and provider/option combinations with exit 2', async () => {
    expect(await h.run(['link', 'claude', 'Bad Id'])).toBe(2);
    expect(h.stderr).toMatch(/invalid account id/);
    expect(await h.run(['link', 'gemini', 'x'])).toBe(2);
    expect(await h.run(['link', 'codex', 'x', '--token'])).toBe(2);
    expect(await h.run(['link', 'claude', 'x', '--device-auth'])).toBe(2);
    expect(h.claude.logins).toHaveLength(0);
    expect(h.codex.logins).toHaveLength(0);
  });

  it('links a claude account with a token from the environment', async () => {
    h.env.SUBPOOL_TOKEN = ' sk-ant-oat01-test ';
    expect(await h.run(['link', 'claude', 'work', '--token', '--weight', '2', '--tokens-5h', '1000', '--model', 'opus'])).toBe(0);
    expect(h.stdout).toBe(`linked work (claude) -> ${path.join('profiles', 'claude-work')}\n`);
    expect(h.prompts).toHaveLength(0);
    expect(h.claude.logins).toEqual([{ profileDir: path.join(h.paths.profiles, 'claude-work'), opts: { token: 'sk-ant-oat01-test' } }]);
    expect(h.claude.statusCalls).toEqual([path.join(h.paths.profiles, 'claude-work')]);
    const stat = await fs.stat(path.join(h.paths.profiles, 'claude-work'));
    expect(stat.isDirectory()).toBe(true);
    const cfg = await loadConfig(h.paths);
    expect(cfg.accounts).toHaveLength(1);
    expect(cfg.accounts[0]).toMatchObject({ id: 'work', provider: 'claude', auth: 'token', weight: 2, budget: { tokens5h: 1000 }, model: 'opus' });
    expect(await h.run(['link', 'claude', 'work', '--token'])).toBe(1);
    expect(h.stderr).toMatch(/already exists/);
  });

  it('prompts for the token when the environment is empty', async () => {
    h.secrets.push('typed-token\n');
    expect(await h.run(['link', 'claude', 'tok', '--token'])).toBe(0);
    expect(h.prompts).toEqual(['token: ']);
    expect(h.stderr).toContain('claude setup-token');
    expect(h.claude.logins[0]?.opts.token).toBe('typed-token');
    h.secrets.push('   ');
    expect(await h.run(['link', 'claude', 'empty', '--token'])).toBe(2);
    expect(h.stderr).toMatch(/empty token/);
    expect((await loadConfig(h.paths)).accounts.map((a) => a.id)).toEqual(['tok']);
  });

  it('links a codex account with device auth and warns when not logged in', async () => {
    h.codex = fakeProvider('codex', { loggedIn: false, detail: 'Not logged in' });
    expect(await h.run(['link', 'codex', 'gpt', '--device-auth'])).toBe(0);
    expect(h.codex.logins[0]?.opts).toEqual({ deviceAuth: true });
    expect(h.stderr).toContain('warning: gpt is not logged in (Not logged in)');
    expect(h.stderr).toContain('codex login');
    expect(h.stdout).toBe(`linked gpt (codex) -> ${path.join('profiles', 'codex-gpt')}\n`);
    expect((await loadConfig(h.paths)).accounts[0]).toMatchObject({ id: 'gpt', provider: 'codex', auth: 'profile' });
  });

  it('does not save the account when login fails', async () => {
    h.claude = fakeProvider('claude', { loginError: 'claude auth login exited with code 1' });
    expect(await h.run(['link', 'claude', 'broken'])).toBe(1);
    expect(h.stderr).toContain('error: claude auth login exited with code 1');
    expect((await loadConfig(h.paths)).accounts).toEqual([]);
  });

  it('lists, checks, sets and unlinks linked accounts', async () => {
    h.env.SUBPOOL_TOKEN = 't';
    expect(await h.run(['link', 'claude', 'work', '--token'])).toBe(0);
    expect(await h.run(['link', 'codex', 'gpt'])).toBe(0);
    await new Ledger(h.paths, () => NOW).setCooldown('gpt', NOW + 3_600_000, 'usage limit');

    expect(await h.run(['ls'])).toBe(0);
    const lines = h.stdout.trim().split('\n');
    expect(lines[0]).toMatch(/^ID\s+PROVIDER\s+STATUS\s+5H\s+7D\s+UTIL\s+COOLDOWN\s+MODEL$/);
    expect(lines[1]).toMatch(/^work\s+claude\s+ready\s+0\s+0\s+-\s+-\s+-$/);
    expect(lines[2]).toMatch(/^gpt\s+codex\s+cooldown\s+0\s+0\s+-\s+until \d{2}:\d{2}\s+-$/);
    expect(lines[3]).toBe('strategy: least-used');

    expect(await h.run(['ls', '--json'])).toBe(0);
    const listed = JSON.parse(h.stdout) as Array<{ id: string; status: string; usage: { cooldownReason?: string } }>;
    expect(listed.map((a) => [a.id, a.status])).toEqual([['work', 'ready'], ['gpt', 'cooldown']]);
    expect(listed[1]?.usage.cooldownReason).toBe('usage limit');

    expect(await h.run(['usage'])).toBe(0);
    expect(h.stdout).toContain('total (claude)');
    expect(h.stdout).toContain('total (codex)');

    expect(await h.run(['check'])).toBe(0);
    expect(h.stdout).toMatch(/work\s+claude\s+logged in/);
    expect(h.stdout).toMatch(/gpt\s+codex\s+logged in/);
    expect(await h.run(['check', 'nope'])).toBe(1);

    expect(await h.run(['set', 'gpt', '--disable', '--weight', '3', '--tokens-7d', '5000', '--model', 'gpt-5', '--clear-cooldown'])).toBe(0);
    expect(h.stdout).toBe('updated gpt\n');
    const cfg = await loadConfig(h.paths);
    expect(cfg.accounts[1]).toMatchObject({ id: 'gpt', enabled: false, weight: 3, budget: { tokens7d: 5000 }, model: 'gpt-5' });
    expect((await new Ledger(h.paths, () => NOW).state()).cooldowns.gpt).toBeUndefined();
    expect(await h.run(['set', 'gpt'])).toBe(2);
    expect(h.stderr).toMatch(/nothing to change/);
    expect(await h.run(['set', 'gpt', '--tokens-7d', '0', '--model', '-', '--enable'])).toBe(0);
    const cleared = (await loadConfig(h.paths)).accounts[1];
    expect(cleared?.budget.tokens7d).toBeUndefined();
    expect(cleared?.model).toBeUndefined();
    expect(cleared?.enabled).toBe(true);

    const profile = path.join(h.paths.profiles, 'codex-gpt');
    expect(await h.run(['unlink', 'gpt'])).toBe(0);
    expect(h.stdout).toBe('unlinked gpt\n');
    await expect(fs.stat(profile)).rejects.toThrow();
    expect(await h.run(['unlink', 'work', '--keep-profile'])).toBe(0);
    expect((await fs.stat(path.join(h.paths.profiles, 'claude-work'))).isDirectory()).toBe(true);
    expect((await loadConfig(h.paths)).accounts).toEqual([]);
  });

  it('reports login failures from check with exit 1', async () => {
    h.claude = fakeProvider('claude', { loggedIn: false, detail: 'Please run /login' });
    h.env.SUBPOOL_TOKEN = 't';
    expect(await h.run(['link', 'claude', 'work', '--token'])).toBe(0);
    expect(h.stderr).toContain('warning: work is not logged in');
    expect(await h.run(['check'])).toBe(1);
    expect(h.stdout).toMatch(/work\s+claude\s+NOT logged in\s+Please run \/login/);
    expect(await h.run(['check', 'work'])).toBe(1);
  });

  it('runs a task through the router, streaming events to stderr', async () => {
    h.claude = fakeProvider('claude', {
      events: [
        { type: 'start', at: 1 },
        { type: 'message', at: 2, text: 'working' },
        { type: 'tool', at: 3, text: 'Bash ls' },
        { type: 'end', at: 4 },
      ],
    });
    h.env.SUBPOOL_TOKEN = 't';
    expect(await h.run(['link', 'claude', 'work', '--token'])).toBe(0);
    await fs.mkdir(path.join(h.home, 'sub'));
    expect(await h.run(['run', 'say', 'hello', '--permission', 'read-only', '--timeout', '30', '-C', 'sub'])).toBe(0);
    expect(h.stdout).toBe('hello from work\n');
    expect(h.stderr).toContain('[work] started\n[work] working\n[work] > Bash ls\n[work] finished\n');
    expect(h.stderr).toContain('[work] done in 2s, 15 tokens');
    expect(h.claude.runs[0]).toMatchObject({ prompt: 'say hello', permission: 'read-only', timeoutSec: 30, cwd: path.join(h.home, 'sub') });
    const entries = await new Ledger(h.paths, () => NOW).entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ account: 'work', total: 15, ok: true });

    expect(await h.run(['run', '--json', 'again'])).toBe(0);
    const parsed = JSON.parse(h.stdout) as RoutedResult;
    expect(parsed.ok).toBe(true);
    expect(parsed.output).toBe('hello from work');
    expect(parsed.attempts).toHaveLength(1);
  });

  it('run passes the account model to the worker unless --model overrides it', async () => {
    h.env.SUBPOOL_TOKEN = 't';
    expect(await h.run(['link', 'claude', 'work', '--token', '--model', 'opus'])).toBe(0);
    expect(await h.run(['run', 'task'])).toBe(0);
    expect(h.claude.runs[0]?.model).toBe('opus');
    expect(await h.run(['run', '--model', 'haiku', 'task'])).toBe(0);
    expect(h.claude.runs[1]?.model).toBe('haiku');
  });

  it('run wires Ctrl-C to the worker and exits 1 with cancelled', async () => {
    h.claude = fakeProvider('claude', { waitForAbort: true });
    h.env.SUBPOOL_TOKEN = 't';
    expect(await h.run(['link', 'claude', 'work', '--token'])).toBe(0);
    const pending = h.run(['run', 'never', 'finishes']);
    for (let i = 0; i < 100 && h.signals.listenerCount('SIGINT') === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(h.signals.listenerCount('SIGINT')).toBe(1);
    expect(h.signals.listenerCount('SIGTERM')).toBe(1);
    h.signals.emit('SIGINT');
    expect(await pending).toBe(1);
    expect(h.stderr).toContain('error: cancelled');
    expect(h.claude.runs[0]?.signal?.aborted).toBe(true);
    expect(h.signals.listenerCount('SIGINT')).toBe(0);
    expect(h.signals.listenerCount('SIGTERM')).toBe(0);
    expect((await new Ledger(h.paths, () => NOW).state()).cooldowns).toEqual({});
    expect(await h.run(['run', '-C', 'missing-dir', 'x'])).toBe(2);
    expect(h.stderr).toMatch(/does not exist/);
  });

  it('fails a run with exit 1 when no account is eligible or the task fails', async () => {
    expect(await h.run(['run', 'nothing linked'])).toBe(1);
    expect(h.stderr).toMatch(/^error: no eligible account/);
    expect(h.stdout).toBe('');
    h.codex = fakeProvider('codex', { result: { ok: false, output: '', error: 'codex exited with code 2' } });
    expect(await h.run(['link', 'codex', 'gpt'])).toBe(0);
    expect(await h.run(['run', '--provider', 'codex', 'break'])).toBe(1);
    expect(h.stderr).toContain('error: codex exited with code 2');
    expect(await h.run(['run', '--json', 'break'])).toBe(1);
    expect((JSON.parse(h.stdout) as RoutedResult).ok).toBe(false);
    expect(await h.run(['run', '--provider', 'claude', 'x'])).toBe(1);
    expect(h.stderr).toMatch(/no eligible account/);
    expect(await h.run(['run', '--provider', 'gemini', 'x'])).toBe(2);
  });

  it('lists persisted job snapshots newest first', async () => {
    const job = (id: string, createdAt: number, status: Job['status']): Job => ({
      id,
      status,
      createdAt,
      startedAt: createdAt,
      finishedAt: status === 'running' ? undefined : createdAt + 2000,
      request: { prompt: `task ${id}`, cwd: '/tmp', permission: 'edit', timeoutSec: 60 },
      options: {},
      provider: 'claude',
      accountId: 'work',
      attempts: [],
      events: [],
    });
    await fs.mkdir(h.paths.jobs, { recursive: true });
    await fs.writeFile(path.join(h.paths.jobs, 'job_old.json'), JSON.stringify(job('job_old', NOW - 60_000, 'done')));
    await fs.writeFile(path.join(h.paths.jobs, 'job_new.json'), JSON.stringify(job('job_new', NOW - 5_000, 'running')));
    await fs.writeFile(path.join(h.paths.jobs, 'broken.json'), '{not json');
    await fs.writeFile(path.join(h.paths.jobs, 'notes.txt'), 'ignored');
    expect(await h.run(['jobs', '--json'])).toBe(0);
    expect((JSON.parse(h.stdout) as Job[]).map((j) => j.id)).toEqual(['job_new', 'job_old']);
    expect(await h.run(['jobs'])).toBe(0);
    const lines = h.stdout.trim().split('\n');
    expect(lines[0]).toMatch(/^ID\s+STATUS\s+PROVIDER\s+ACCOUNT\s+CREATED\s+DURATION\s+TASK$/);
    expect(lines[1]).toMatch(/^job_new\s+running\s+claude\s+work\s+\S+\s+5s\s+task job_new$/);
    expect(lines[2]).toMatch(/^job_old\s+done\s+claude\s+work\s+\S+\s+2s\s+task job_old$/);
  });

  it('installs and uninstalls the codex registration in CODEX_HOME', async () => {
    const codexHome = path.join(h.home, 'codex-home');
    h.env.CODEX_HOME = codexHome;
    expect(await h.run(['install', 'codex', '--tool-timeout', '600'])).toBe(0);
    const file = path.join(codexHome, 'config.toml');
    expect(h.stdout).toBe(`registered subpool in ${file}\n`);
    const toml = await fs.readFile(file, 'utf8');
    expect(toml).toContain('[mcp_servers.subpool]');
    expect(toml).toContain('"serve"');
    expect(toml).toContain('tool_timeout_sec = 600');
    expect(await h.run(['install', 'codex', '--tool-timeout', '600'])).toBe(0);
    expect(h.stdout).toBe(`subpool already registered in ${file}\n`);
    expect(await h.run(['uninstall', 'codex'])).toBe(0);
    expect(h.stdout).toBe(`removed subpool from ${file}\n`);
    expect(await fs.readFile(file, 'utf8')).not.toContain('mcp_servers.subpool');
    expect(await h.run(['uninstall', 'codex'])).toBe(0);
    expect(h.stdout).toContain('was not registered');
    expect(await h.run(['install', 'gemini'])).toBe(2);
    expect(await h.run(['install', 'claude', '--scope', 'global'])).toBe(2);
  });

  it('runs doctor and reports missing binaries with exit 1', async () => {
    expect(await h.run(['doctor'])).toBe(1);
    expect(h.stdout).toMatch(/^ok {4}node: v\d+/m);
    expect(h.stdout).toMatch(/^FAIL {2}claude binary: "claude" not found on PATH/m);
    expect(h.stdout).toMatch(/^FAIL {2}codex binary: "codex" not found on PATH/m);
    expect(h.stdout).toMatch(/^ok {4}home: .* is writable$/m);
    expect(h.stdout).toMatch(/^ok {4}config: .*0 accounts, strategy least-used/m);
    expect(h.stdout).toMatch(/^warn {2}accounts: none linked/m);
    expect(h.stdout).toContain('2 problems found');
  });

  it('doctor skips login checks when the binary is missing and flags broken config', async () => {
    h.env.SUBPOOL_TOKEN = 't';
    expect(await h.run(['link', 'claude', 'work', '--token'])).toBe(0);
    expect(await h.run(['doctor'])).toBe(1);
    expect(h.stdout).toMatch(/^warn {2}account work: skipped login check, claude binary missing$/m);
    expect(h.claude.statusCalls).toHaveLength(1);
    await fs.writeFile(h.paths.config, '{broken');
    expect(await h.run(['doctor'])).toBe(1);
    expect(h.stdout).toMatch(/^FAIL {2}config: invalid JSON/m);
    expect(await h.run(['ls'])).toBe(1);
    expect(h.stderr).toMatch(/^error: invalid JSON/);
  });
});
