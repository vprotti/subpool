import type { Paths } from './paths.js';
import type { Account, AccountUsage, LedgerEntry, RunResult, State, WindowUsage } from './types.js';
import { WINDOW_5H_MS, WINDOW_7D_MS } from './types.js';
import { appendLine, readJsonOr, readLines, withLock, writeFileAtomic } from './fsx.js';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_KEEP_MS = WINDOW_7D_MS + DAY_MS;
const MIN_WEIGHT = 0.01;

export function emptyWindow(): WindowUsage {
  return { tokens: 0, runs: 0, costUsd: 0 };
}

export function emptyState(): State {
  return { cooldowns: {}, rrCursor: 0, lastUsed: {} };
}

function finite(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function nonNegative(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function parseLedgerLine(line: string): LedgerEntry | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.t !== 'number' || !Number.isFinite(o.t)) return undefined;
  if (typeof o.account !== 'string' || o.account.length === 0) return undefined;
  if (o.provider !== 'claude' && o.provider !== 'codex') return undefined;
  const entry: LedgerEntry = {
    t: o.t,
    account: o.account,
    provider: o.provider,
    input: finite(o.input),
    output: finite(o.output),
    cached: finite(o.cached),
    total: finite(o.total),
    ok: o.ok === true,
    durationMs: finite(o.durationMs),
  };
  if (typeof o.costUsd === 'number' && Number.isFinite(o.costUsd)) entry.costUsd = o.costUsd;
  if (o.limited === 'rate' || o.limited === 'auth' || o.limited === 'overloaded') entry.limited = o.limited;
  return entry;
}

export function parseLedgerLines(lines: string[]): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const line of lines) {
    const entry = parseLedgerLine(line);
    if (entry) out.push(entry);
  }
  return out;
}

export function serializeLedgerEntry(entry: LedgerEntry): string {
  return JSON.stringify(entry);
}

export function inWindow(t: number, now: number, windowMs: number): boolean {
  return t > now - windowMs;
}

export function summarize(
  entries: LedgerEntry[],
  accountId: string,
  now: number,
): { window5h: WindowUsage; window7d: WindowUsage; lastUsedAt?: number } {
  const window5h = emptyWindow();
  const window7d = emptyWindow();
  let lastUsedAt: number | undefined;
  for (const e of entries) {
    if (e.account !== accountId) continue;
    if (lastUsedAt === undefined || e.t > lastUsedAt) lastUsedAt = e.t;
    if (inWindow(e.t, now, WINDOW_7D_MS)) {
      window7d.tokens += finite(e.total);
      window7d.runs += 1;
      window7d.costUsd += finite(e.costUsd);
      if (inWindow(e.t, now, WINDOW_5H_MS)) {
        window5h.tokens += finite(e.total);
        window5h.runs += 1;
        window5h.costUsd += finite(e.costUsd);
      }
    }
  }
  return lastUsedAt === undefined ? { window5h, window7d } : { window5h, window7d, lastUsedAt };
}

export function computeUtilization(account: Account, window5h: WindowUsage, window7d: WindowUsage): number {
  const budget = account.budget ?? {};
  const ratios: number[] = [];
  if (typeof budget.tokens5h === 'number' && budget.tokens5h > 0) ratios.push(finite(window5h.tokens) / budget.tokens5h);
  if (typeof budget.tokens7d === 'number' && budget.tokens7d > 0) ratios.push(finite(window7d.tokens) / budget.tokens7d);
  if (ratios.length > 0) return nonNegative(Math.max(...ratios));
  const weight = Math.max(finite(account.weight), MIN_WEIGHT);
  return nonNegative(finite(window5h.tokens) / weight);
}

export function ledgerEntryFrom(result: RunResult, now: number): LedgerEntry {
  const entry: LedgerEntry = {
    t: now,
    account: result.accountId,
    provider: result.provider,
    input: finite(result.usage?.input),
    output: finite(result.usage?.output),
    cached: finite(result.usage?.cached),
    total: finite(result.usage?.total),
    ok: result.ok,
    durationMs: finite(result.durationMs),
  };
  if (typeof result.usage?.costUsd === 'number' && Number.isFinite(result.usage.costUsd)) entry.costUsd = result.usage.costUsd;
  if (result.limit) entry.limited = result.limit.kind;
  return entry;
}

export function activeCooldown(state: State, accountId: string, now: number): { until: number; reason: string } | undefined {
  const c = state.cooldowns[accountId];
  if (!c || typeof c.until !== 'number' || c.until <= now) return undefined;
  return { until: c.until, reason: c.reason };
}

export function normalizeState(raw: unknown): State {
  const base = emptyState();
  if (typeof raw !== 'object' || raw === null) return base;
  const o = raw as Record<string, unknown>;
  if (typeof o.cooldowns === 'object' && o.cooldowns !== null) {
    for (const [id, value] of Object.entries(o.cooldowns as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const c = value as Record<string, unknown>;
      if (typeof c.until !== 'number' || !Number.isFinite(c.until)) continue;
      base.cooldowns[id] = { until: c.until, reason: typeof c.reason === 'string' ? c.reason : '' };
    }
  }
  if (typeof o.rrCursor === 'number' && Number.isFinite(o.rrCursor) && o.rrCursor >= 0) base.rrCursor = Math.floor(o.rrCursor);
  if (typeof o.lastUsed === 'object' && o.lastUsed !== null) {
    for (const [id, value] of Object.entries(o.lastUsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) base.lastUsed[id] = value;
    }
  }
  return base;
}

export class Ledger {
  private readonly paths: Paths;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(paths: Paths, now?: () => number) {
    this.paths = paths;
    this.now = now ?? (() => Date.now());
  }

  async append(entry: LedgerEntry): Promise<void> {
    await this.locked(() => appendLine(this.paths.ledger, serializeLedgerEntry(entry)));
  }

  async entries(sinceMs?: number): Promise<LedgerEntry[]> {
    const all = parseLedgerLines(await readLines(this.paths.ledger));
    if (sinceMs === undefined) return all;
    return all.filter((e) => e.t >= sinceMs);
  }

  async compact(keepMs: number = DEFAULT_KEEP_MS): Promise<number> {
    return this.locked(async () => {
      const lines = await readLines(this.paths.ledger);
      if (lines.length === 0) return 0;
      const cutoff = this.now() - keepMs;
      const kept: LedgerEntry[] = [];
      for (const line of lines) {
        const entry = parseLedgerLine(line);
        if (entry && entry.t > cutoff) kept.push(entry);
      }
      const dropped = lines.length - kept.length;
      if (dropped === 0) return 0;
      const body = kept.map(serializeLedgerEntry).join('\n');
      await writeFileAtomic(this.paths.ledger, body.length > 0 ? `${body}\n` : '', 0o600);
      return dropped;
    });
  }

  async state(): Promise<State> {
    return normalizeState(await readJsonOr<unknown>(this.paths.state, undefined));
  }

  async setCooldown(accountId: string, until: number, reason: string): Promise<void> {
    await this.mutate((s) => {
      s.cooldowns[accountId] = { until, reason };
    });
  }

  async clearCooldown(accountId: string): Promise<void> {
    await this.mutate((s) => {
      delete s.cooldowns[accountId];
    });
  }

  async touch(accountId: string): Promise<void> {
    const at = this.now();
    await this.mutate((s) => {
      s.lastUsed[accountId] = at;
    });
  }

  async bumpCursor(): Promise<number> {
    let previous = 0;
    await this.mutate((s) => {
      previous = s.rrCursor;
      s.rrCursor = previous + 1;
    });
    return previous;
  }

  async usage(accounts: Account[]): Promise<AccountUsage[]> {
    const now = this.now();
    const [entries, state] = await Promise.all([this.entries(), this.state()]);
    return accounts.map((account) => {
      const summary = summarize(entries, account.id, now);
      const touched = state.lastUsed[account.id];
      let lastUsedAt = summary.lastUsedAt;
      if (typeof touched === 'number' && (lastUsedAt === undefined || touched > lastUsedAt)) lastUsedAt = touched;
      const usage: AccountUsage = {
        accountId: account.id,
        provider: account.provider,
        enabled: account.enabled,
        window5h: summary.window5h,
        window7d: summary.window7d,
        utilization: computeUtilization(account, summary.window5h, summary.window7d),
      };
      if (lastUsedAt !== undefined) usage.lastUsedAt = lastUsedAt;
      const cooldown = activeCooldown(state, account.id, now);
      if (cooldown) {
        usage.cooldownUntil = cooldown.until;
        usage.cooldownReason = cooldown.reason;
      }
      return usage;
    });
  }

  private async mutate(fn: (state: State) => void): Promise<void> {
    await this.locked(async () => {
      const state = await this.state();
      fn(state);
      await writeFileAtomic(this.paths.state, `${JSON.stringify(state, null, 2)}\n`, 0o600);
    });
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    return this.serialized(() => withLock(this.paths.home, fn));
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
