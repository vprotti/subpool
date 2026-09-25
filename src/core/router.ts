import type { Paths } from './paths.js';
import type {
  Account,
  AccountUsage,
  Attempt,
  Config,
  ProviderAdapter,
  ProviderId,
  RoutedResult,
  RunEvent,
  RunRequest,
  RunResult,
  SelectOptions,
  Strategy,
  Usage,
} from './types.js';
import { Ledger, ledgerEntryFrom } from './ledger.js';
import { cooldownFor } from './limits.js';

const MIN_WEIGHT = 0.01;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface RouterDeps {
  paths: Paths;
  ledger: Ledger;
  providers: Record<ProviderId, ProviderAdapter>;
  loadConfig: () => Promise<Config>;
  now?: () => number;
}

export function usageMap(usages: AccountUsage[]): Map<string, AccountUsage> {
  const map = new Map<string, AccountUsage>();
  for (const u of usages) map.set(u.accountId, u);
  return map;
}

export function providerMatches(account: Account, provider: SelectOptions['provider']): boolean {
  return provider === undefined || provider === 'any' || account.provider === provider;
}

export function isCoolingDown(usage: AccountUsage | undefined, now: number): boolean {
  return usage?.cooldownUntil !== undefined && usage.cooldownUntil > now;
}

export function eligible(config: Config, usages: AccountUsage[], opts: SelectOptions, now: number): Account[] {
  const byId = usageMap(usages);
  const excluded = new Set(opts.exclude ?? []);
  return config.accounts.filter((account) => {
    if (!account.enabled) return false;
    if (excluded.has(account.id)) return false;
    if (!providerMatches(account, opts.provider)) return false;
    if (opts.account !== undefined && account.id !== opts.account) return false;
    if (isCoolingDown(byId.get(account.id), now)) return false;
    return true;
  });
}

export function leastUsedScore(usage: AccountUsage | undefined): number {
  const value = usage?.utilization;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function weightedScore(account: Account, usage: AccountUsage | undefined): number {
  const tokens = usage?.window5h.tokens ?? 0;
  const weight = Math.max(Number.isFinite(account.weight) ? account.weight : MIN_WEIGHT, MIN_WEIGHT);
  return (tokens + 1) / weight;
}

function compareLastUsed(a: AccountUsage | undefined, b: AccountUsage | undefined): number {
  const la = a?.lastUsedAt;
  const lb = b?.lastUsedAt;
  if (la === undefined && lb === undefined) return 0;
  if (la === undefined) return -1;
  if (lb === undefined) return 1;
  return la - lb;
}

export function pickByStrategy(
  strategy: Strategy,
  candidates: Account[],
  usages: AccountUsage[],
  rrCursor: number,
): Account | undefined {
  if (candidates.length === 0) return undefined;
  const byId = usageMap(usages);
  switch (strategy) {
    case 'priority':
      return candidates[0];
    case 'round-robin': {
      const cursor = Number.isFinite(rrCursor) && rrCursor >= 0 ? Math.floor(rrCursor) : 0;
      return candidates[cursor % candidates.length];
    }
    case 'weighted': {
      let best: Account | undefined;
      let bestScore = Number.POSITIVE_INFINITY;
      for (const account of candidates) {
        const score = weightedScore(account, byId.get(account.id));
        if (score < bestScore) {
          best = account;
          bestScore = score;
        }
      }
      return best;
    }
    case 'least-used': {
      let best: Account | undefined;
      let bestScore = Number.POSITIVE_INFINITY;
      let bestUsage: AccountUsage | undefined;
      for (const account of candidates) {
        const usage = byId.get(account.id);
        const score = leastUsedScore(usage);
        if (score < bestScore || (score === bestScore && compareLastUsed(usage, bestUsage) < 0)) {
          best = account;
          bestScore = score;
          bestUsage = usage;
        }
      }
      return best;
    }
  }
}

export function selectAccount(
  config: Config,
  usages: AccountUsage[],
  opts: SelectOptions,
  now: number,
  rrCursor: number,
): Account | undefined {
  return pickByStrategy(config.strategy, eligible(config, usages, opts, now), usages, rrCursor);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function formatLocalTime(at: number, now: number): string {
  const d = new Date(at);
  const ref = new Date(now);
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const sameDay =
    d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth() && d.getDate() === ref.getDate();
  if (sameDay) return time;
  return `${MONTHS[d.getMonth()] ?? ''} ${d.getDate()} ${time}`;
}

export function explainNoEligible(config: Config, usages: AccountUsage[], opts: SelectOptions, now: number): string {
  if (config.accounts.length === 0) return 'no eligible account: no accounts linked (run: subpool link <claude|codex> <id>)';
  if (opts.account !== undefined && !config.accounts.some((a) => a.id === opts.account)) {
    return `no eligible account: account "${opts.account}" not found`;
  }
  const byId = usageMap(usages);
  const excluded = new Set(opts.exclude ?? []);
  const cooling: string[] = [];
  const disabled: string[] = [];
  const tried: string[] = [];
  const otherProvider: string[] = [];
  const otherAccount: string[] = [];
  for (const account of config.accounts) {
    if (opts.account !== undefined && account.id !== opts.account) {
      otherAccount.push(account.id);
      continue;
    }
    if (!providerMatches(account, opts.provider)) {
      otherProvider.push(account.id);
      continue;
    }
    if (!account.enabled) {
      disabled.push(account.id);
      continue;
    }
    const usage = byId.get(account.id);
    if (isCoolingDown(usage, now) && usage?.cooldownUntil !== undefined) {
      cooling.push(`${account.id} until ${formatLocalTime(usage.cooldownUntil, now)}`);
      continue;
    }
    if (excluded.has(account.id)) {
      tried.push(account.id);
      continue;
    }
  }
  const parts: string[] = [];
  if (cooling.length > 0) parts.push(`${cooling.length} cooling down (${cooling.join(', ')})`);
  if (tried.length > 0) parts.push(`${tried.length} already tried (${tried.join(', ')})`);
  if (disabled.length > 0) parts.push(`${disabled.length} disabled (${disabled.join(', ')})`);
  if (otherProvider.length > 0) parts.push(`${otherProvider.length} other provider (${otherProvider.join(', ')})`);
  if (otherAccount.length > 0 && parts.length === 0) parts.push(`${otherAccount.length} not matching "${opts.account}"`);
  if (parts.length === 0) parts.push('none matched');
  return `no eligible account: ${parts.join(', ')}`;
}

export function zeroUsage(): Usage {
  return { input: 0, output: 0, cached: 0, total: 0 };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function attemptFrom(result: RunResult): Attempt {
  const attempt: Attempt = { accountId: result.accountId, provider: result.provider, durationMs: result.durationMs };
  if (result.limit) attempt.limit = result.limit;
  if (result.error) attempt.error = result.error;
  return attempt;
}

function fallbackProvider(opts: SelectOptions, attempts: Attempt[]): ProviderId {
  const last = attempts[attempts.length - 1];
  if (last) return last.provider;
  if (opts.provider === 'claude' || opts.provider === 'codex') return opts.provider;
  return 'claude';
}

export function effectiveRequest(req: RunRequest, account: Account): RunRequest {
  if (req.model !== undefined || account.model === undefined || account.model.length === 0) return req;
  return { ...req, model: account.model };
}

export function failedResult(error: string, opts: SelectOptions, attempts: Attempt[], durationMs: number): RoutedResult {
  const last = attempts[attempts.length - 1];
  return {
    ok: false,
    output: '',
    usage: zeroUsage(),
    provider: fallbackProvider(opts, attempts),
    accountId: last?.accountId ?? '',
    durationMs,
    exitCode: null,
    error,
    attempts,
  };
}

export class Router {
  private readonly deps: RouterDeps;
  private readonly now: () => number;

  constructor(deps: RouterDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  async run(
    req: RunRequest,
    opts: SelectOptions,
    onEvent?: (e: RunEvent, accountId: string) => void,
  ): Promise<RoutedResult> {
    const startedAt = this.now();
    const config = await this.deps.loadConfig();
    const attempts: Attempt[] = [];
    const exclude = new Set(opts.exclude ?? []);
    const maxAttempts = Math.max(1, Math.floor(config.defaults.maxAttempts));
    const ledger = this.deps.ledger;

    for (let i = 0; i < maxAttempts; i++) {
      if (req.signal?.aborted) {
        return failedResult('cancelled', opts, attempts, this.now() - startedAt);
      }
      const now = this.now();
      const selectOpts: SelectOptions = { ...opts, exclude: [...exclude] };
      const usages = await ledger.usage(config.accounts);
      const candidates = eligible(config, usages, selectOpts, now);
      if (candidates.length === 0) {
        return failedResult(explainNoEligible(config, usages, selectOpts, now), opts, attempts, this.now() - startedAt);
      }
      const cursor = config.strategy === 'round-robin' ? await ledger.bumpCursor() : (await ledger.state()).rrCursor;
      const account = pickByStrategy(config.strategy, candidates, usages, cursor) ?? candidates[0];
      if (!account) {
        return failedResult(explainNoEligible(config, usages, selectOpts, now), opts, attempts, this.now() - startedAt);
      }
      const provider = this.deps.providers[account.provider];
      await ledger.touch(account.id);

      const attemptStart = this.now();
      const effectiveReq = effectiveRequest(req, account);
      let result: RunResult;
      try {
        result = await provider.run(effectiveReq, account, onEvent ? (e) => onEvent(e, account.id) : undefined);
      } catch (err) {
        result = {
          ok: false,
          output: '',
          usage: zeroUsage(),
          provider: account.provider,
          accountId: account.id,
          durationMs: this.now() - attemptStart,
          exitCode: null,
          error: errorMessage(err),
        };
      }
      if (result.accountId !== account.id || result.provider !== account.provider) {
        result = { ...result, accountId: account.id, provider: account.provider };
      }
      await ledger.append(ledgerEntryFrom(result, this.now()));
      attempts.push(attemptFrom(result));

      if (result.limit && !req.signal?.aborted) {
        const until = cooldownFor(result.limit, this.now(), config.defaults.cooldownSec);
        await ledger.setCooldown(account.id, until, result.limit.message);
        exclude.add(account.id);
        continue;
      }
      return { ...result, attempts };
    }

    const last = attempts[attempts.length - 1];
    const tail = last?.limit ? `: ${last.limit.message}` : '';
    return failedResult(
      `gave up after ${attempts.length} attempt${attempts.length === 1 ? '' : 's'} (limits on ${attempts
        .map((a) => a.accountId)
        .join(', ')})${tail}`,
      opts,
      attempts,
      this.now() - startedAt,
    );
  }
}
