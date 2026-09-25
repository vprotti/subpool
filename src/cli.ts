#!/usr/bin/env node
import { promises as fs, constants as fsConstants, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import type { Paths } from './core/paths.js';
import { ensureDirs, profileDirFor, resolvePaths } from './core/paths.js';
import type {
  Account,
  AccountUsage,
  AuthStatus,
  Config,
  Job,
  LoginOptions,
  Permission,
  ProviderAdapter,
  ProviderId,
  RoutedResult,
  RunEvent,
  RunRequest,
  SelectOptions,
  Strategy,
  WindowUsage,
} from './core/types.js';
import { ACCOUNT_ID_RE } from './core/types.js';
import { assertAccountId, getAccount, loadConfig, newAccount, removeAccount, saveConfig, upsertAccount } from './core/config.js';
import { readJson } from './core/fsx.js';
import { Ledger } from './core/ledger.js';
import { Router, formatLocalTime } from './core/router.js';
import { assertDirectory, resolveBinary } from './core/exec.js';
import { isTerminal } from './core/jobs.js';
import { providers as defaultProviders } from './providers/index.js';
import { installCodex, serveCommand, uninstallCodex } from './install/codex.js';
import { installClaude, uninstallClaude, type ClaudeScope } from './install/claude.js';

export const STRATEGIES: Strategy[] = ['least-used', 'round-robin', 'weighted', 'priority'];
export const PERMISSIONS: Permission[] = ['read-only', 'edit', 'full'];
export const PROVIDER_IDS: ProviderId[] = ['claude', 'codex'];
const SCOPES: ClaudeScope[] = ['user', 'local', 'project'];
const TASK_PREVIEW = 40;
const MIN_NODE_MAJOR = 20;
const STALE_GRACE_MS = 5 * 60 * 1000;
const STALE_ATTEMPTS = 3;
const CANCEL_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: 1 | 2 = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export function usageError(message: string): CliError {
  return new CliError(message, 2);
}

export interface CliIo {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  paths?: Paths;
  providers?: Record<ProviderId, ProviderAdapter>;
  now?: () => number;
  readSecret?: (prompt: string) => Promise<string>;
  cwd?: string;
  signals?: NodeJS.EventEmitter;
}

interface Ctx {
  out: (text: string) => void;
  err: (text: string) => void;
  env: NodeJS.ProcessEnv;
  paths: Paths;
  providers: Record<ProviderId, ProviderAdapter>;
  now: () => number;
  readSecret: (prompt: string) => Promise<string>;
  cwd: string;
  signals: NodeJS.EventEmitter;
  exitCode: number;
}

export function readVersion(): string {
  try {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function exitCodeFor(err: unknown): number {
  if (err instanceof CliError) return err.exitCode;
  if (err instanceof CommanderError) return err.exitCode === 0 ? 0 : 2;
  return 1;
}

export function formatTable(headers: string[], rows: string[][], align: Array<'left' | 'right'> = []): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]): string =>
    cells
      .map((cell, i) => {
        const width = widths[i] ?? 0;
        return align[i] === 'right' ? cell.padStart(width) : cell.padEnd(width);
      })
      .join('  ')
      .replace(/\s+$/, '');
  const body = rows.map((r) => line(headers.map((_, i) => r[i] ?? '')));
  return [line(headers), ...body].map((l) => `${l}\n`).join('');
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  const units: Array<[number, string]> = [
    [1e9, 'G'],
    [1e6, 'M'],
    [1e3, 'k'],
  ];
  for (const [size, suffix] of units) {
    if (n >= size) {
      const value = n / size;
      return `${value < 100 ? value.toFixed(1) : String(Math.round(value))}${suffix}`;
    }
  }
  return String(Math.round(n));
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return '<1s';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio < 0) return '0%';
  return `${Math.round(ratio * 100)}%`;
}

export function formatWindow(window: WindowUsage, budget: number | undefined): string {
  const used = formatTokens(window.tokens);
  return budget !== undefined && budget > 0 ? `${used}/${formatTokens(budget)}` : used;
}

export function formatUtilization(account: Account, usage: AccountUsage | undefined): string {
  const hasBudget = (account.budget.tokens5h ?? 0) > 0 || (account.budget.tokens7d ?? 0) > 0;
  if (!hasBudget || !usage) return '-';
  return formatPercent(usage.utilization);
}

export function accountStatus(account: Account, usage: AccountUsage | undefined, now: number): string {
  if (!account.enabled) return 'disabled';
  if (usage?.cooldownUntil !== undefined && usage.cooldownUntil > now) return 'cooldown';
  return 'ready';
}

export function formatCooldown(usage: AccountUsage | undefined, now: number): string {
  if (!usage || usage.cooldownUntil === undefined || usage.cooldownUntil <= now) return '-';
  return `until ${formatLocalTime(usage.cooldownUntil, now)}`;
}

export function truncate(text: string, max: number): string {
  const flat = oneLine(text);
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

export const LS_HEADERS = ['ID', 'PROVIDER', 'STATUS', '5H', '7D', 'UTIL', 'COOLDOWN', 'MODEL'];
export const LS_ALIGN: Array<'left' | 'right'> = ['left', 'left', 'left', 'right', 'right', 'right', 'left', 'left'];

export function lsRows(accounts: Account[], usages: AccountUsage[], now: number): string[][] {
  const byId = new Map(usages.map((u) => [u.accountId, u]));
  return accounts.map((account) => {
    const usage = byId.get(account.id);
    const w5 = usage?.window5h ?? { tokens: 0, runs: 0, costUsd: 0 };
    const w7 = usage?.window7d ?? { tokens: 0, runs: 0, costUsd: 0 };
    return [
      account.id,
      account.provider,
      accountStatus(account, usage, now),
      formatWindow(w5, account.budget.tokens5h),
      formatWindow(w7, account.budget.tokens7d),
      formatUtilization(account, usage),
      formatCooldown(usage, now),
      account.model ?? '-',
    ];
  });
}

export const USAGE_HEADERS = ['ID', 'PROVIDER', '5H TOKENS', '5H RUNS', '7D TOKENS', '7D RUNS', '7D COST', 'LAST USED'];
export const USAGE_ALIGN: Array<'left' | 'right'> = ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'left'];

export interface ProviderTotal {
  accounts: number;
  window5h: WindowUsage;
  window7d: WindowUsage;
}

export function providerTotals(usages: AccountUsage[]): Record<ProviderId, ProviderTotal> {
  const empty = (): ProviderTotal => ({
    accounts: 0,
    window5h: { tokens: 0, runs: 0, costUsd: 0 },
    window7d: { tokens: 0, runs: 0, costUsd: 0 },
  });
  const totals: Record<ProviderId, ProviderTotal> = { claude: empty(), codex: empty() };
  for (const u of usages) {
    const t = totals[u.provider];
    t.accounts += 1;
    for (const key of ['window5h', 'window7d'] as const) {
      t[key].tokens += u[key].tokens;
      t[key].runs += u[key].runs;
      t[key].costUsd += u[key].costUsd;
    }
  }
  return totals;
}

function formatCost(usd: number): string {
  return usd > 0 ? `$${usd.toFixed(2)}` : '-';
}

export function usageRows(usages: AccountUsage[], now: number): string[][] {
  const rows = usages.map((u) => [
    u.accountId,
    u.provider,
    formatTokens(u.window5h.tokens),
    String(u.window5h.runs),
    formatTokens(u.window7d.tokens),
    String(u.window7d.runs),
    formatCost(u.window7d.costUsd),
    u.lastUsedAt !== undefined ? formatLocalTime(u.lastUsedAt, now) : '-',
  ]);
  const totals = providerTotals(usages);
  for (const provider of PROVIDER_IDS) {
    const t = totals[provider];
    if (t.accounts === 0) continue;
    rows.push([
      `total (${provider})`,
      provider,
      formatTokens(t.window5h.tokens),
      String(t.window5h.runs),
      formatTokens(t.window7d.tokens),
      String(t.window7d.runs),
      formatCost(t.window7d.costUsd),
      '',
    ]);
  }
  return rows;
}

export const JOBS_HEADERS = ['ID', 'STATUS', 'PROVIDER', 'ACCOUNT', 'CREATED', 'DURATION', 'TASK'];

export function jobDurationMs(job: Job, now: number): number {
  const start = job.startedAt ?? job.createdAt;
  const end = job.finishedAt ?? now;
  return Math.max(0, end - start);
}

export function staleAfterMs(job: Job): number {
  const timeoutSec = job.request?.timeoutSec;
  const perRun = typeof timeoutSec === 'number' && timeoutSec > 0 ? timeoutSec * 1000 : 0;
  return perRun * STALE_ATTEMPTS + STALE_GRACE_MS;
}

export function isStaleJob(job: Job, now: number): boolean {
  if (isTerminal(job.status)) return false;
  return now - (job.startedAt ?? job.createdAt) > staleAfterMs(job);
}

export function jobDisplayStatus(job: Job, now: number): string {
  return isStaleJob(job, now) ? 'stale' : job.status;
}

export function jobsRows(jobs: Job[], now: number): string[][] {
  return jobs.map((job) => [
    job.id,
    jobDisplayStatus(job, now),
    job.provider ?? '-',
    job.accountId ?? '-',
    formatLocalTime(job.createdAt, now),
    formatDuration(jobDurationMs(job, now)),
    truncate(job.request?.prompt ?? '', TASK_PREVIEW),
  ]);
}

export function isJobSnapshot(raw: unknown): raw is Job {
  if (typeof raw !== 'object' || raw === null) return false;
  const o = raw as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.status === 'string' && typeof o.createdAt === 'number';
}

export async function readJobs(paths: Paths): Promise<Job[]> {
  let names: string[];
  try {
    names = await fs.readdir(paths.jobs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const jobs: Job[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await readJson<unknown>(path.join(paths.jobs, name));
      if (isJobSnapshot(raw)) jobs.push(raw);
    } catch {
      void 0;
    }
  }
  return jobs.sort((a, b) => b.createdAt - a.createdAt);
}

export function formatEvent(e: RunEvent, accountId: string): string | undefined {
  const tag = `[${accountId}]`;
  switch (e.type) {
    case 'start':
      return `${tag} started`;
    case 'end':
      return `${tag} finished`;
    case 'message':
    case 'text':
      return e.text ? `${tag} ${e.text}` : undefined;
    case 'tool':
      return e.text ? `${tag} > ${e.text}` : undefined;
    case 'stderr':
      return e.text ? `${tag} ! ${e.text}` : undefined;
  }
}

export function loginHint(provider: ProviderId, profileDir: string): string {
  return provider === 'claude'
    ? `CLAUDE_CONFIG_DIR=${profileDir} claude auth login`
    : `CODEX_HOME=${profileDir} codex login`;
}

export function relativeProfile(paths: Paths, profileDir: string): string {
  const rel = path.relative(paths.home, profileDir);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : profileDir;
}

export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function parseProvider(value: string): ProviderId {
  if (value === 'claude' || value === 'codex') return value;
  throw usageError(`unknown provider "${value}": expected claude or codex`);
}

export function parseStrategy(value: string): Strategy {
  if ((STRATEGIES as string[]).includes(value)) return value as Strategy;
  throw usageError(`unknown strategy "${value}": expected one of ${STRATEGIES.join(', ')}`);
}

export function parsePermission(value: string): Permission {
  if ((PERMISSIONS as string[]).includes(value)) return value as Permission;
  throw new InvalidArgumentError(`expected one of ${PERMISSIONS.join(', ')}`);
}

export function parseScope(value: string): ClaudeScope {
  if ((SCOPES as string[]).includes(value)) return value as ClaudeScope;
  throw new InvalidArgumentError(`expected one of ${SCOPES.join(', ')}`);
}

export function parseSelectProvider(value: string): ProviderId | 'any' {
  if (value === 'any' || value === 'claude' || value === 'codex') return value;
  throw new InvalidArgumentError('expected claude, codex or any');
}

export function parsePositiveNumber(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('expected a positive number');
  return n;
}

export function parsePositiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError('expected a positive integer');
  return n;
}

export function parseNonNegativeInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError('expected a non-negative integer');
  return n;
}

export function validateAccountId(id: string): void {
  try {
    assertAccountId(id);
  } catch (err) {
    throw usageError(errorMessage(err));
  }
}

export async function findOnPath(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const isWin = process.platform === 'win32';
  const exts = isWin ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  const candidates: string[] = [];
  if (name.includes('/') || (isWin && name.includes('\\'))) {
    candidates.push(path.resolve(name));
  } else {
    const dirs = (env.PATH ?? '').split(path.delimiter).filter((d) => d.length > 0);
    for (const dir of dirs) for (const ext of exts) candidates.push(path.join(dir, name + ext));
  }
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, isWin ? fsConstants.F_OK : fsConstants.X_OK);
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      void 0;
    }
  }
  return undefined;
}

export async function readSecretFromTerminal(prompt: string): Promise<string> {
  const stdin = process.stdin;
  const stderr = process.stderr;
  stderr.write(prompt);
  if (!stdin.isTTY) {
    return new Promise<string>((resolve) => {
      const rl = readline.createInterface({ input: stdin, terminal: false });
      let settled = false;
      rl.once('line', (line) => {
        settled = true;
        rl.close();
        resolve(line);
      });
      rl.once('close', () => {
        if (!settled) resolve('');
      });
    });
  }
  return new Promise<string>((resolve, reject) => {
    let buffer = '';
    const finish = (): void => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write('\n');
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\u0003') {
          finish();
          reject(new CliError('cancelled'));
          return;
        }
        if (ch === '\r' || ch === '\n') {
          finish();
          resolve(buffer);
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += ch;
      }
    };
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function makeCtx(io: CliIo): Ctx {
  const env = io.env ?? process.env;
  const paths = io.paths ?? resolvePaths(env.SUBPOOL_HOME);
  return {
    out: io.stdout ?? ((text) => void process.stdout.write(text)),
    err: io.stderr ?? ((text) => void process.stderr.write(text)),
    env,
    paths,
    providers: io.providers ?? defaultProviders,
    now: io.now ?? (() => Date.now()),
    readSecret: io.readSecret ?? readSecretFromTerminal,
    cwd: io.cwd ?? process.cwd(),
    signals: io.signals ?? process,
    exitCode: 0,
  };
}

function prepare(ctx: Ctx): void {
  try {
    ensureDirs(ctx.paths);
  } catch (err) {
    throw new CliError(`cannot create ${ctx.paths.home}: ${errorMessage(err)}`);
  }
}

function ledgerFor(ctx: Ctx): Ledger {
  return new Ledger(ctx.paths, ctx.now);
}

async function requireAccount(config: Config, id: string): Promise<Account> {
  const account = getAccount(config, id);
  if (!account) throw new CliError(`account "${id}" not found (run: subpool ls)`);
  return account;
}

interface LinkOpts {
  token?: boolean;
  deviceAuth?: boolean;
  weight?: number;
  tokens5h?: number;
  tokens7d?: number;
  model?: string;
}

async function cmdLink(ctx: Ctx, providerArg: string, id: string, opts: LinkOpts): Promise<void> {
  const provider = parseProvider(providerArg);
  validateAccountId(id);
  if (opts.token && provider !== 'claude') throw usageError('--token is only supported for claude accounts');
  if (opts.deviceAuth && provider !== 'codex') throw usageError('--device-auth is only supported for codex accounts');
  prepare(ctx);
  const config = await loadConfig(ctx.paths);
  if (getAccount(config, id)) throw new CliError(`account "${id}" already exists (run: subpool unlink ${id})`);
  const profileDir = profileDirFor(ctx.paths, provider, id);
  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  const rel = relativeProfile(ctx.paths, profileDir);
  const loginOpts: LoginOptions = {};
  if (opts.token) {
    let token = ctx.env.SUBPOOL_TOKEN?.trim();
    if (!token) {
      ctx.err('paste the long-lived token printed by `claude setup-token` (input is hidden)\n');
      token = (await ctx.readSecret('token: ')).trim();
    }
    if (!token) throw usageError('empty token: run `claude setup-token` and paste its output');
    loginOpts.token = token;
  } else {
    ctx.err(`starting ${provider} login for profile ${rel}\n`);
  }
  if (opts.deviceAuth) loginOpts.deviceAuth = true;
  const adapter = ctx.providers[provider];
  await adapter.login(profileDir, loginOpts);
  const budget: { tokens5h?: number; tokens7d?: number } = {};
  if (opts.tokens5h !== undefined) budget.tokens5h = opts.tokens5h;
  if (opts.tokens7d !== undefined) budget.tokens7d = opts.tokens7d;
  const input: Parameters<typeof newAccount>[0] = { id, provider, profileDir, auth: opts.token ? 'token' : 'profile', budget };
  if (opts.weight !== undefined) input.weight = opts.weight;
  if (opts.model !== undefined) input.model = opts.model;
  const account = newAccount(input);
  await saveConfig(ctx.paths, upsertAccount(config, account));
  let status: AuthStatus;
  try {
    status = await adapter.status(profileDir);
  } catch (err) {
    status = { loggedIn: false, detail: errorMessage(err) };
  }
  if (!status.loggedIn) {
    const detail = status.detail ? ` (${oneLine(status.detail)})` : '';
    ctx.err(`warning: ${id} is not logged in${detail}; the account was kept, log in with: ${loginHint(provider, profileDir)}\n`);
  }
  ctx.out(`linked ${id} (${provider}) -> ${rel}\n`);
}

async function cmdUnlink(ctx: Ctx, id: string, opts: { keepProfile?: boolean }): Promise<void> {
  prepare(ctx);
  const config = await loadConfig(ctx.paths);
  const account = await requireAccount(config, id);
  await saveConfig(ctx.paths, removeAccount(config, id));
  await ledgerFor(ctx).clearCooldown(id);
  if (!opts.keepProfile) {
    if (isInside(ctx.paths.profiles, account.profileDir)) {
      await fs.rm(account.profileDir, { recursive: true, force: true });
    } else {
      ctx.err(`warning: profile ${account.profileDir} is outside ${ctx.paths.profiles}, left untouched\n`);
    }
  }
  ctx.out(`unlinked ${id}\n`);
}

export interface LsEntry extends Account {
  status: string;
  usage: AccountUsage | undefined;
}

async function cmdLs(ctx: Ctx, opts: { json?: boolean }): Promise<void> {
  prepare(ctx);
  const config = await loadConfig(ctx.paths);
  const usages = await ledgerFor(ctx).usage(config.accounts);
  const now = ctx.now();
  if (opts.json) {
    const byId = new Map(usages.map((u) => [u.accountId, u]));
    const entries: LsEntry[] = config.accounts.map((a) => ({
      ...a,
      status: accountStatus(a, byId.get(a.id), now),
      usage: byId.get(a.id),
    }));
    ctx.out(toJson(entries));
    return;
  }
  if (config.accounts.length === 0) {
    ctx.out('no accounts linked (run: subpool link <claude|codex> <id>)\n');
    return;
  }
  ctx.out(formatTable(LS_HEADERS, lsRows(config.accounts, usages, now), LS_ALIGN));
  ctx.out(`strategy: ${config.strategy}\n`);
}

async function cmdUsage(ctx: Ctx, opts: { json?: boolean }): Promise<void> {
  prepare(ctx);
  const config = await loadConfig(ctx.paths);
  const usages = await ledgerFor(ctx).usage(config.accounts);
  if (opts.json) {
    ctx.out(toJson({ accounts: usages, totals: providerTotals(usages) }));
    return;
  }
  if (usages.length === 0) {
    ctx.out('no accounts linked (run: subpool link <claude|codex> <id>)\n');
    return;
  }
  ctx.out(formatTable(USAGE_HEADERS, usageRows(usages, ctx.now()), USAGE_ALIGN));
}

async function statusOf(ctx: Ctx, account: Account): Promise<AuthStatus> {
  try {
    return await ctx.providers[account.provider].status(account.profileDir);
  } catch (err) {
    return { loggedIn: false, detail: errorMessage(err) };
  }
}

async function cmdCheck(ctx: Ctx, id: string | undefined): Promise<void> {
  prepare(ctx);
  const config = await loadConfig(ctx.paths);
  const accounts = id === undefined ? config.accounts : [await requireAccount(config, id)];
  if (accounts.length === 0) {
    ctx.out('no accounts linked (run: subpool link <claude|codex> <id>)\n');
    return;
  }
  const rows: string[][] = [];
  for (const account of accounts) {
    const status = await statusOf(ctx, account);
    if (!status.loggedIn) ctx.exitCode = 1;
    rows.push([account.id, account.provider, status.loggedIn ? 'logged in' : 'NOT logged in', oneLine(status.detail ?? '')]);
  }
  ctx.out(formatTable(['ID', 'PROVIDER', 'LOGIN', 'DETAIL'], rows));
}

interface SetOpts {
  enable?: boolean;
  disable?: boolean;
  weight?: number;
  tokens5h?: number;
  tokens7d?: number;
  model?: string;
  clearCooldown?: boolean;
}

export function applyAccountChanges(account: Account, opts: SetOpts): { account: Account; changed: boolean } {
  const next: Account = { ...account, budget: { ...account.budget } };
  let changed = false;
  if (opts.enable) {
    next.enabled = true;
    changed = true;
  }
  if (opts.disable) {
    next.enabled = false;
    changed = true;
  }
  if (opts.weight !== undefined) {
    next.weight = opts.weight;
    changed = true;
  }
  if (opts.tokens5h !== undefined) {
    if (opts.tokens5h > 0) next.budget.tokens5h = opts.tokens5h;
    else delete next.budget.tokens5h;
    changed = true;
  }
  if (opts.tokens7d !== undefined) {
    if (opts.tokens7d > 0) next.budget.tokens7d = opts.tokens7d;
    else delete next.budget.tokens7d;
    changed = true;
  }
  if (opts.model !== undefined) {
    if (opts.model.length > 0 && opts.model !== '-') next.model = opts.model;
    else delete next.model;
    changed = true;
  }
  return { account: next, changed };
}

async function cmdSet(ctx: Ctx, id: string, opts: SetOpts): Promise<void> {
  if (opts.enable && opts.disable) throw usageError('--enable and --disable are mutually exclusive');
  prepare(ctx);
  const config = await loadConfig(ctx.paths);
  const account = await requireAccount(config, id);
  const { account: next, changed } = applyAccountChanges(account, opts);
  if (!changed && !opts.clearCooldown) throw usageError('nothing to change: pass at least one option (see: subpool set --help)');
  if (changed) await saveConfig(ctx.paths, upsertAccount(config, next));
  if (opts.clearCooldown) await ledgerFor(ctx).clearCooldown(id);
  ctx.out(`updated ${id}\n`);
}

async function cmdStrategy(ctx: Ctx, name: string | undefined): Promise<void> {
  prepare(ctx);
  const config = await loadConfig(ctx.paths);
  if (name === undefined) {
    ctx.out(`${config.strategy}\n`);
    return;
  }
  const strategy = parseStrategy(name);
  await saveConfig(ctx.paths, { ...config, strategy });
  ctx.out(`strategy set to ${strategy}\n`);
}

interface RunOpts {
  cwd?: string;
  provider?: ProviderId | 'any';
  account?: string;
  permission?: Permission;
  model?: string;
  timeout?: number;
  json?: boolean;
}

export function buildRunRequest(task: string, config: Config, opts: RunOpts, baseCwd: string): RunRequest {
  const cwd = path.resolve(baseCwd, opts.cwd ?? '.');
  try {
    assertDirectory(cwd);
  } catch (err) {
    throw usageError(errorMessage(err));
  }
  const req: RunRequest = {
    prompt: task,
    cwd,
    permission: opts.permission ?? config.defaults.permission,
    timeoutSec: opts.timeout ?? config.defaults.timeoutSec,
  };
  if (opts.model !== undefined) req.model = opts.model;
  return req;
}

export async function withCancelSignal<T>(signals: NodeJS.EventEmitter, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  for (const name of CANCEL_SIGNALS) signals.once(name, onSignal);
  try {
    return await fn(controller.signal);
  } finally {
    for (const name of CANCEL_SIGNALS) signals.off(name, onSignal);
  }
}

export function buildSelectOptions(opts: RunOpts): SelectOptions {
  const sel: SelectOptions = {};
  if (opts.provider !== undefined) sel.provider = opts.provider;
  if (opts.account !== undefined) sel.account = opts.account;
  return sel;
}

export function runSummary(result: RoutedResult): string {
  const tokens = formatTokens(result.usage.total);
  const attempts = result.attempts.length > 1 ? `, ${result.attempts.length} attempts` : '';
  return `[${result.accountId}] ${result.ok ? 'done' : 'failed'} in ${formatDuration(result.durationMs)}, ${tokens} tokens${attempts}`;
}

async function cmdRun(ctx: Ctx, taskParts: string[], opts: RunOpts): Promise<void> {
  const task = taskParts.join(' ').trim();
  if (task.length === 0) throw usageError('task must not be empty');
  prepare(ctx);
  const config = await loadConfig(ctx.paths);
  const req = buildRunRequest(task, config, opts, ctx.cwd);
  const ledger = ledgerFor(ctx);
  const router = new Router({
    paths: ctx.paths,
    ledger,
    providers: ctx.providers,
    loadConfig: () => loadConfig(ctx.paths),
    now: ctx.now,
  });
  const result = await withCancelSignal(ctx.signals, (signal) =>
    router.run({ ...req, signal }, buildSelectOptions(opts), (e, accountId) => {
      const line = formatEvent(e, accountId);
      if (line !== undefined) ctx.err(`${line}\n`);
    }),
  );
  if (opts.json) {
    ctx.out(toJson(result));
    if (!result.ok) ctx.exitCode = 1;
    return;
  }
  if (!result.ok) throw new CliError(result.error ?? 'run failed');
  ctx.err(`${runSummary(result)}\n`);
  if (result.output.length > 0) ctx.out(result.output.endsWith('\n') ? result.output : `${result.output}\n`);
}

async function cmdJobs(ctx: Ctx, opts: { json?: boolean }): Promise<void> {
  prepare(ctx);
  const jobs = await readJobs(ctx.paths);
  if (opts.json) {
    ctx.out(toJson(jobs));
    return;
  }
  if (jobs.length === 0) {
    ctx.out('no jobs recorded\n');
    return;
  }
  ctx.out(formatTable(JOBS_HEADERS, jobsRows(jobs, ctx.now())));
}

async function cmdInstall(ctx: Ctx, target: string, opts: { scope?: ClaudeScope; toolTimeout?: number }): Promise<void> {
  const provider = parseProvider(target);
  const { command, args } = serveCommand();
  if (provider === 'codex') {
    const installOpts: Parameters<typeof installCodex>[0] = { command, args };
    if (ctx.env.CODEX_HOME) installOpts.codexHome = ctx.env.CODEX_HOME;
    if (opts.toolTimeout !== undefined) installOpts.toolTimeoutSec = opts.toolTimeout;
    const result = await installCodex(installOpts);
    ctx.out(result.changed ? `registered subpool in ${result.file}\n` : `subpool already registered in ${result.file}\n`);
    return;
  }
  const scope = opts.scope ?? 'user';
  const result = await installClaude({ scope, command, args, env: ctx.env });
  if (!result.ok) throw new CliError(`claude mcp add failed: ${oneLine(result.output) || 'unknown error'}`);
  const detail = oneLine(result.output);
  ctx.out(`registered subpool with claude (scope ${scope})${detail ? `: ${detail}` : ''}\n`);
}

async function cmdUninstall(ctx: Ctx, target: string): Promise<void> {
  const provider = parseProvider(target);
  if (provider === 'codex') {
    const uninstallOpts: Parameters<typeof uninstallCodex>[0] = {};
    if (ctx.env.CODEX_HOME) uninstallOpts.codexHome = ctx.env.CODEX_HOME;
    const result = await uninstallCodex(uninstallOpts);
    ctx.out(result.changed ? `removed subpool from ${result.file}\n` : `subpool was not registered in ${result.file}\n`);
    return;
  }
  const result = await uninstallClaude({ env: ctx.env });
  if (!result.ok) throw new CliError(`claude mcp remove failed: ${oneLine(result.output) || 'unknown error'}`);
  ctx.out('removed subpool from claude\n');
}

export type DoctorLevel = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  level: DoctorLevel;
  label: string;
  detail: string;
}

export function formatDoctor(checks: DoctorCheck[]): string {
  const tag: Record<DoctorLevel, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };
  return checks.map((c) => `${tag[c.level]}  ${c.label}: ${c.detail}\n`).join('');
}

export function nodeVersionCheck(version: string): DoctorCheck {
  const major = Number(version.split('.')[0]);
  return {
    level: Number.isFinite(major) && major >= MIN_NODE_MAJOR ? 'ok' : 'fail',
    label: 'node',
    detail: Number.isFinite(major) && major >= MIN_NODE_MAJOR ? `v${version}` : `v${version} (need >= ${MIN_NODE_MAJOR})`,
  };
}

export async function runDoctor(ctx: Ctx): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [nodeVersionCheck(process.versions.node)];
  const binaries: Partial<Record<ProviderId, boolean>> = {};
  for (const id of PROVIDER_IDS) {
    const name = resolveBinary(ctx.providers[id].binary);
    const found = await findOnPath(name, ctx.env);
    binaries[id] = found !== undefined;
    checks.push({
      level: found ? 'ok' : 'fail',
      label: `${id} binary`,
      detail: found ?? `"${name}" not found on PATH (install it or set SUBPOOL_${id.toUpperCase()}_BIN)`,
    });
  }
  try {
    ensureDirs(ctx.paths);
    const probe = path.join(ctx.paths.home, `.doctor-${process.pid}`);
    await fs.writeFile(probe, 'ok', { mode: 0o600 });
    await fs.rm(probe, { force: true });
    checks.push({ level: 'ok', label: 'home', detail: `${ctx.paths.home} is writable` });
  } catch (err) {
    checks.push({ level: 'fail', label: 'home', detail: `${ctx.paths.home}: ${errorMessage(err)}` });
    return checks;
  }
  let config: Config;
  try {
    config = await loadConfig(ctx.paths);
    checks.push({
      level: 'ok',
      label: 'config',
      detail: `${ctx.paths.config} (${config.accounts.length} account${config.accounts.length === 1 ? '' : 's'}, strategy ${config.strategy})`,
    });
  } catch (err) {
    checks.push({ level: 'fail', label: 'config', detail: errorMessage(err) });
    return checks;
  }
  if (config.accounts.length === 0) {
    checks.push({ level: 'warn', label: 'accounts', detail: 'none linked (run: subpool link <claude|codex> <id>)' });
  }
  for (const account of config.accounts) {
    const label = `account ${account.id}`;
    try {
      const stat = await fs.stat(account.profileDir);
      if (!stat.isDirectory()) throw new Error('not a directory');
    } catch {
      checks.push({ level: 'fail', label, detail: `profile dir ${account.profileDir} missing` });
      continue;
    }
    if (!binaries[account.provider]) {
      checks.push({ level: 'warn', label, detail: `skipped login check, ${account.provider} binary missing` });
      continue;
    }
    const status = await statusOf(ctx, account);
    const detail = status.detail ? ` (${oneLine(status.detail)})` : '';
    checks.push({
      level: status.loggedIn ? 'ok' : 'fail',
      label,
      detail: status.loggedIn
        ? `logged in${detail}${account.enabled ? '' : ', disabled'}`
        : `not logged in${detail}; run: ${loginHint(account.provider, account.profileDir)}`,
    });
  }
  return checks;
}

async function cmdDoctor(ctx: Ctx): Promise<void> {
  const checks = await runDoctor(ctx);
  ctx.out(formatDoctor(checks));
  const failed = checks.filter((c) => c.level === 'fail').length;
  if (failed > 0) {
    ctx.out(`${failed} problem${failed === 1 ? '' : 's'} found\n`);
    ctx.exitCode = 1;
  } else {
    ctx.out('all checks passed\n');
  }
}

async function cmdServe(ctx: Ctx): Promise<void> {
  prepare(ctx);
  const mod = await import('./server.js');
  await mod.serve(ctx.paths);
}

export function buildProgram(ctx: Ctx): Command {
  const program = new Command();
  program
    .name('subpool')
    .description('Pool several Claude Code and Codex subscriptions and route coding tasks across them')
    .version(readVersion(), '-V, --version', 'print the version')
    .exitOverride()
    .configureOutput({
      writeOut: (text) => ctx.out(text),
      writeErr: (text) => ctx.err(text),
      outputError: (text, write) => write(`${oneLine(text)}\n`),
    });

  program
    .command('serve')
    .description('start the MCP server on stdio')
    .action(() => cmdServe(ctx));

  program
    .command('link')
    .description('link a subscription account (interactive login in an isolated profile)')
    .argument('<provider>', 'claude or codex')
    .argument('<id>', 'account id (a-z, 0-9, ".", "_", "-")')
    .option('--token', 'claude only: store a long-lived token from `claude setup-token` instead of logging in')
    .option('--device-auth', 'codex only: use device-code login (headless)')
    .option('--weight <n>', 'relative weight for the weighted strategy', parsePositiveNumber)
    .option('--tokens-5h <n>', '5-hour token budget', parsePositiveInt)
    .option('--tokens-7d <n>', '7-day token budget', parsePositiveInt)
    .option('--model <name>', 'default model for this account')
    .action((provider: string, id: string, opts: LinkOpts) => cmdLink(ctx, provider, id, opts));

  program
    .command('unlink')
    .description('remove an account and its profile directory')
    .argument('<id>', 'account id')
    .option('--keep-profile', 'keep the profile directory on disk')
    .action((id: string, opts: { keepProfile?: boolean }) => cmdUnlink(ctx, id, opts));

  program
    .command('ls')
    .description('list linked accounts with usage and status')
    .option('--json', 'print JSON')
    .action((opts: { json?: boolean }) => cmdLs(ctx, opts));

  program
    .command('usage')
    .description('show token usage per account and provider')
    .option('--json', 'print JSON')
    .action((opts: { json?: boolean }) => cmdUsage(ctx, opts));

  program
    .command('check')
    .description('check the login state of one or all accounts')
    .argument('[id]', 'account id')
    .action((id: string | undefined) => cmdCheck(ctx, id));

  program
    .command('set')
    .description('change account settings')
    .argument('<id>', 'account id')
    .option('--enable', 'enable the account')
    .option('--disable', 'disable the account')
    .option('--weight <n>', 'relative weight', parsePositiveNumber)
    .option('--tokens-5h <n>', '5-hour token budget (0 clears)', parseNonNegativeInt)
    .option('--tokens-7d <n>', '7-day token budget (0 clears)', parseNonNegativeInt)
    .option('--model <name>', 'default model ("-" clears)')
    .option('--clear-cooldown', 'clear an active cooldown')
    .action((id: string, opts: SetOpts) => cmdSet(ctx, id, opts));

  program
    .command('strategy')
    .description(`get or set the routing strategy (${STRATEGIES.join(', ')})`)
    .argument('[name]', 'strategy name')
    .action((name: string | undefined) => cmdStrategy(ctx, name));

  program
    .command('run')
    .description('run a task through the pool, streaming progress to stderr and printing the result')
    .argument('<task...>', 'task text')
    .option('-C, --cwd <dir>', 'working directory for the task')
    .option('--provider <p>', 'claude, codex or any', parseSelectProvider)
    .option('--account <id>', 'pin a specific account')
    .option('--permission <p>', PERMISSIONS.join(', '), parsePermission)
    .option('--model <name>', 'model override')
    .option('--timeout <sec>', 'timeout in seconds', parsePositiveInt)
    .option('--json', 'print the full result as JSON')
    .action((task: string[], opts: RunOpts) => cmdRun(ctx, task, opts));

  program
    .command('jobs')
    .description('list recorded jobs')
    .option('--json', 'print JSON')
    .action((opts: { json?: boolean }) => cmdJobs(ctx, opts));

  program
    .command('install')
    .description('register subpool as an MCP server in codex or claude')
    .argument('<target>', 'codex or claude')
    .option('--scope <scope>', 'claude only: user, local or project', parseScope)
    .option('--tool-timeout <sec>', 'codex only: tool timeout in seconds', parsePositiveInt)
    .action((target: string, opts: { scope?: ClaudeScope; toolTimeout?: number }) => cmdInstall(ctx, target, opts));

  program
    .command('uninstall')
    .description('remove the subpool MCP server registration from codex or claude')
    .argument('<target>', 'codex or claude')
    .action((target: string) => cmdUninstall(ctx, target));

  program
    .command('doctor')
    .description('check binaries, storage, config and account logins')
    .action(() => cmdDoctor(ctx));

  return program;
}

export async function runCli(argv: string[], io: CliIo = {}): Promise<number> {
  const ctx = makeCtx(io);
  const program = buildProgram(ctx);
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (err) {
    const code = exitCodeFor(err);
    if (!(err instanceof CommanderError)) ctx.err(`error: ${oneLine(errorMessage(err)) || 'unknown error'}\n`);
    return code;
  }
  return ctx.exitCode;
}

export function isMain(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isMain(process.argv[1], import.meta.url)) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`error: ${oneLine(errorMessage(err))}\n`);
      process.exitCode = 1;
    },
  );
}
