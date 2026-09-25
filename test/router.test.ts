import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePaths, type Paths } from '../src/core/paths.js';
import { Ledger } from '../src/core/ledger.js';
import type {
  Account,
  AccountUsage,
  Config,
  ProviderAdapter,
  ProviderId,
  RunEvent,
  RunRequest,
  RunResult,
  SelectOptions,
} from '../src/core/types.js';
import {
  Router,
  eligible,
  effectiveRequest,
  selectAccount,
  pickByStrategy,
  explainNoEligible,
  formatLocalTime,
  weightedScore,
  leastUsedScore,
  failedResult,
} from '../src/core/router.js';

const NOW = 1_800_000_000_000;

function account(over: Partial<Account> = {}): Account {
  return {
    id: 'a1',
    provider: 'claude',
    profileDir: '/tmp/x',
    weight: 1,
    budget: {},
    enabled: true,
    auth: 'profile',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function config(accounts: Account[], over: Partial<Config> = {}): Config {
  return {
    version: 1,
    strategy: 'least-used',
    defaults: { permission: 'edit', timeoutSec: 60, maxAttempts: 3, cooldownSec: 600 },
    accounts,
    ...over,
  };
}

function usage(a: Account, over: Partial<AccountUsage> = {}): AccountUsage {
  return {
    accountId: a.id,
    provider: a.provider,
    enabled: a.enabled,
    window5h: { tokens: 0, runs: 0, costUsd: 0 },
    window7d: { tokens: 0, runs: 0, costUsd: 0 },
    utilization: 0,
    ...over,
  };
}

function request(over: Partial<RunRequest> = {}): RunRequest {
  return { prompt: 'do it', cwd: '/tmp', permission: 'edit', timeoutSec: 60, ...over };
}

type Script = (account: Account, req: RunRequest, onEvent?: (e: RunEvent) => void) => Partial<RunResult> | Error;

interface FakeProvider extends ProviderAdapter {
  calls: string[];
}

function fakeProvider(id: ProviderId, script: Script, delayMs = 0): FakeProvider {
  const calls: string[] = [];
  return {
    id,
    binary: id,
    calls,
    async login() {},
    async status() {
      return { loggedIn: true };
    },
    async run(req, acc, onEvent) {
      calls.push(acc.id);
      if (delayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          req.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new Error('aborted by signal'));
            },
            { once: true },
          );
        });
      }
      const out = script(acc, req, onEvent);
      if (out instanceof Error) throw out;
      return {
        ok: true,
        output: 'ok',
        usage: { input: 10, output: 5, cached: 0, total: 15 },
        provider: acc.provider,
        accountId: acc.id,
        durationMs: 5,
        exitCode: 0,
        ...out,
      };
    },
  };
}

const A = account({ id: 'a', provider: 'claude' });
const B = account({ id: 'b', provider: 'claude' });
const C = account({ id: 'c', provider: 'codex' });
const D = account({ id: 'd', provider: 'codex', enabled: false });

describe('eligible', () => {
  const cfg = config([A, B, C, D]);
  const usages = [usage(A), usage(B), usage(C), usage(D)];

  it('drops disabled accounts', () => {
    expect(eligible(cfg, usages, {}, NOW).map((a) => a.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops excluded accounts', () => {
    expect(eligible(cfg, usages, { exclude: ['a', 'c'] }, NOW).map((a) => a.id)).toEqual(['b']);
  });

  it('filters by provider, any means all', () => {
    expect(eligible(cfg, usages, { provider: 'codex' }, NOW).map((a) => a.id)).toEqual(['c']);
    expect(eligible(cfg, usages, { provider: 'claude' }, NOW).map((a) => a.id)).toEqual(['a', 'b']);
    expect(eligible(cfg, usages, { provider: 'any' }, NOW).map((a) => a.id)).toEqual(['a', 'b', 'c']);
  });

  it('restricts to opts.account but still honours cooldown and enabled', () => {
    expect(eligible(cfg, usages, { account: 'b' }, NOW).map((a) => a.id)).toEqual(['b']);
    expect(eligible(cfg, usages, { account: 'd' }, NOW)).toEqual([]);
    const cooling = [usage(A), usage(B, { cooldownUntil: NOW + 1000, cooldownReason: 'x' }), usage(C), usage(D)];
    expect(eligible(cfg, cooling, { account: 'b' }, NOW)).toEqual([]);
  });

  it('drops accounts whose cooldown is in the future, keeps expired ones', () => {
    const u = [usage(A, { cooldownUntil: NOW + 1 }), usage(B, { cooldownUntil: NOW }), usage(C, { cooldownUntil: NOW - 1 })];
    expect(eligible(cfg, u, {}, NOW).map((a) => a.id)).toEqual(['b', 'c']);
  });

  it('treats a missing usage entry as eligible', () => {
    expect(eligible(cfg, [], {}, NOW).map((a) => a.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('selectAccount', () => {
  it('least-used picks the lowest utilization', () => {
    const cfg = config([A, B, C]);
    const u = [usage(A, { utilization: 0.5 }), usage(B, { utilization: 0.1 }), usage(C, { utilization: 0.3 })];
    expect(selectAccount(cfg, u, {}, NOW, 0)?.id).toBe('b');
  });

  it('least-used breaks ties by oldest lastUsedAt with undefined first, then config order', () => {
    const cfg = config([A, B, C]);
    const tieOnLastUsed = [
      usage(A, { utilization: 0.2, lastUsedAt: NOW - 10 }),
      usage(B, { utilization: 0.2, lastUsedAt: NOW - 500 }),
      usage(C, { utilization: 0.2, lastUsedAt: NOW - 100 }),
    ];
    expect(selectAccount(cfg, tieOnLastUsed, {}, NOW, 0)?.id).toBe('b');
    const undefinedFirst = [
      usage(A, { utilization: 0.2, lastUsedAt: NOW - 10 }),
      usage(B, { utilization: 0.2, lastUsedAt: NOW - 500 }),
      usage(C, { utilization: 0.2 }),
    ];
    expect(selectAccount(cfg, undefinedFirst, {}, NOW, 0)?.id).toBe('c');
    const fullTie = [usage(A, { utilization: 0.2 }), usage(B, { utilization: 0.2 }), usage(C, { utilization: 0.2 })];
    expect(selectAccount(cfg, fullTie, {}, NOW, 0)?.id).toBe('a');
    const sameLastUsed = [
      usage(A, { utilization: 0.2, lastUsedAt: NOW - 5 }),
      usage(B, { utilization: 0.2, lastUsedAt: NOW - 5 }),
    ];
    expect(selectAccount(config([B, A]), sameLastUsed, {}, NOW, 0)?.id).toBe('b');
  });

  it('weighted picks min (tokens5h + 1) / weight, ties in config order', () => {
    const heavy = account({ id: 'heavy', weight: 4 });
    const light = account({ id: 'light', weight: 1 });
    const cfg = config([light, heavy], { strategy: 'weighted' });
    const u = [usage(light, { window5h: { tokens: 100, runs: 1, costUsd: 0 } }), usage(heavy, { window5h: { tokens: 300, runs: 1, costUsd: 0 } })];
    expect(weightedScore(light, u[0])).toBe(101);
    expect(weightedScore(heavy, u[1])).toBe(75.25);
    expect(selectAccount(cfg, u, {}, NOW, 0)?.id).toBe('heavy');
    const tie = [usage(light, { window5h: { tokens: 3, runs: 1, costUsd: 0 } }), usage(heavy, { window5h: { tokens: 15, runs: 1, costUsd: 0 } })];
    expect(selectAccount(cfg, tie, {}, NOW, 0)?.id).toBe('light');
    expect(selectAccount(cfg, [], {}, NOW, 0)?.id).toBe('heavy');
  });

  it('round-robin walks eligible accounts by cursor modulo length', () => {
    const cfg = config([A, B, C], { strategy: 'round-robin' });
    const u = [usage(A), usage(B), usage(C)];
    expect(selectAccount(cfg, u, {}, NOW, 0)?.id).toBe('a');
    expect(selectAccount(cfg, u, {}, NOW, 1)?.id).toBe('b');
    expect(selectAccount(cfg, u, {}, NOW, 2)?.id).toBe('c');
    expect(selectAccount(cfg, u, {}, NOW, 3)?.id).toBe('a');
    expect(selectAccount(cfg, u, { exclude: ['b'] }, NOW, 1)?.id).toBe('c');
    expect(selectAccount(cfg, u, {}, NOW, -4)?.id).toBe('a');
  });

  it('priority picks the first eligible in config order', () => {
    const cfg = config([D, A, B], { strategy: 'priority' });
    const u = [usage(D), usage(A, { utilization: 9, cooldownUntil: NOW + 5 }), usage(B, { utilization: 10 })];
    expect(selectAccount(cfg, u, {}, NOW, 0)?.id).toBe('b');
  });

  it('returns undefined when nothing is eligible', () => {
    expect(selectAccount(config([D]), [usage(D)], {}, NOW, 0)).toBeUndefined();
    expect(pickByStrategy('least-used', [], [], 0)).toBeUndefined();
  });

  it('leastUsedScore clamps non-finite or negative values to 0', () => {
    expect(leastUsedScore(undefined)).toBe(0);
    expect(leastUsedScore(usage(A, { utilization: Number.NaN }))).toBe(0);
    expect(leastUsedScore(usage(A, { utilization: -3 }))).toBe(0);
    expect(leastUsedScore(usage(A, { utilization: 2.5 }))).toBe(2.5);
  });
});

describe('explainNoEligible', () => {
  it('lists cooldowns with local reset times, disabled and tried accounts', () => {
    const cfg = config([A, B, C, D]);
    const until = NOW + 10 * 60 * 1000;
    const u = [usage(A, { cooldownUntil: until, cooldownReason: 'r' }), usage(B), usage(C, { cooldownUntil: until + 60_000 }), usage(D)];
    const text = explainNoEligible(cfg, u, { exclude: ['b'] }, NOW);
    expect(text.startsWith('no eligible account: ')).toBe(true);
    expect(text).toContain(`2 cooling down (a until ${formatLocalTime(until, NOW)}, c until ${formatLocalTime(until + 60_000, NOW)})`);
    expect(text).toContain('1 already tried (b)');
    expect(text).toContain('1 disabled (d)');
  });

  it('explains empty pools, unknown accounts and provider mismatches', () => {
    expect(explainNoEligible(config([]), [], {}, NOW)).toContain('no accounts linked');
    expect(explainNoEligible(config([A]), [usage(A)], { account: 'zz' }, NOW)).toContain('account "zz" not found');
    expect(explainNoEligible(config([A]), [usage(A)], { provider: 'codex' }, NOW)).toContain('1 other provider (a)');
  });

  it('formatLocalTime gives HH:MM for the same day and adds the date otherwise', () => {
    const base = new Date(2026, 3, 10, 9, 5, 0, 0).getTime();
    expect(formatLocalTime(base + 60 * 60 * 1000, base)).toBe('10:05');
    expect(formatLocalTime(base + 2 * 24 * 60 * 60 * 1000, base)).toBe('Apr 12 09:05');
  });

  it('failedResult falls back to the last attempt or the requested provider', () => {
    const r = failedResult('x', { provider: 'codex' }, [], 3);
    expect(r).toMatchObject({ ok: false, provider: 'codex', accountId: '', error: 'x', attempts: [], durationMs: 3 });
    const r2 = failedResult('y', {}, [{ accountId: 'q', provider: 'claude', durationMs: 1 }], 0);
    expect(r2.accountId).toBe('q');
    expect(r2.provider).toBe('claude');
  });
});

describe('Router.run', () => {
  let home: string;
  let paths: Paths;
  let ledger: Ledger;
  let clock = NOW;
  const now = () => clock;

  beforeEach(async () => {
    clock = NOW;
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'subpool-router-'));
    paths = resolvePaths(home);
    ledger = new Ledger(paths, now);
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  function makeRouter(cfg: Config, providers: Partial<Record<ProviderId, ProviderAdapter>>) {
    const fallback = fakeProvider('claude', () => new Error('unexpected provider'));
    return new Router({
      paths,
      ledger,
      providers: { claude: providers.claude ?? fallback, codex: providers.codex ?? { ...fallback, id: 'codex' } },
      loadConfig: async () => cfg,
      now,
    });
  }

  it('runs on the selected account, appends the ledger, touches lastUsed and records one attempt', async () => {
    const claude = fakeProvider('claude', (acc, _req, onEvent) => {
      onEvent?.({ type: 'message', at: NOW, text: `hi from ${acc.id}` });
      return { output: `done by ${acc.id}` };
    });
    const router = makeRouter(config([A, B]), { claude });
    const events: Array<[string, string]> = [];
    const res = await router.run(request(), {}, (e, id) => events.push([id, e.text ?? '']));
    expect(res.ok).toBe(true);
    expect(res.output).toBe('done by a');
    expect(res.attempts).toEqual([{ accountId: 'a', provider: 'claude', durationMs: 5 }]);
    expect(events).toEqual([['a', 'hi from a']]);
    const entries = await ledger.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ account: 'a', provider: 'claude', total: 15, ok: true });
    const state = await ledger.state();
    expect(state.lastUsed.a).toBe(NOW);
  });

  it('fails over on a limit: sets cooldown with reason, excludes the account and retries on the next one', async () => {
    const claude = fakeProvider('claude', (acc) =>
      acc.id === 'a'
        ? { ok: false, error: 'usage limit reached', limit: { kind: 'rate', message: 'usage limit reached' }, usage: { input: 1, output: 0, cached: 0, total: 1 } }
        : { output: 'b did it' },
    );
    const router = makeRouter(config([A, B]), { claude });
    const res = await router.run(request(), {});
    expect(res.ok).toBe(true);
    expect(res.accountId).toBe('b');
    expect(claude.calls).toEqual(['a', 'b']);
    expect(res.attempts.map((a) => a.accountId)).toEqual(['a', 'b']);
    expect(res.attempts[0]?.limit?.kind).toBe('rate');
    expect(res.attempts[0]?.error).toBe('usage limit reached');
    const state = await ledger.state();
    expect(state.cooldowns.a).toEqual({ until: NOW + 600 * 1000, reason: 'usage limit reached' });
    expect(state.cooldowns.b).toBeUndefined();
    const entries = await ledger.entries();
    expect(entries.map((e) => [e.account, e.ok, e.limited])).toEqual([
      ['a', false, 'rate'],
      ['b', true, undefined],
    ]);
  });

  it('uses the limit resetAt for the cooldown when present', async () => {
    const resetAt = NOW + 3 * 60 * 60 * 1000;
    const claude = fakeProvider('claude', () => ({ ok: false, limit: { kind: 'rate', message: 'weekly', resetAt } }));
    const router = makeRouter(config([A]), { claude });
    const res = await router.run(request(), {});
    expect(res.ok).toBe(false);
    expect((await ledger.state()).cooldowns.a?.until).toBe(resetAt);
  });

  it('does not fail over on an ordinary failure', async () => {
    const claude = fakeProvider('claude', () => ({ ok: false, output: 'partial', error: 'exit 1: boom', exitCode: 1 }));
    const router = makeRouter(config([A, B]), { claude });
    const res = await router.run(request(), {});
    expect(res.ok).toBe(false);
    expect(res.error).toBe('exit 1: boom');
    expect(res.accountId).toBe('a');
    expect(claude.calls).toEqual(['a']);
    expect(res.attempts).toEqual([{ accountId: 'a', provider: 'claude', durationMs: 5, error: 'exit 1: boom' }]);
    expect((await ledger.state()).cooldowns).toEqual({});
    expect(await ledger.entries()).toHaveLength(1);
  });

  it('returns a readable error listing cooldowns when nothing is eligible', async () => {
    const until = NOW + 20 * 60 * 1000;
    await ledger.setCooldown('a', until, 'usage limit reached');
    const claude = fakeProvider('claude', () => ({}));
    const router = makeRouter(config([A, D]), { claude });
    const res = await router.run(request(), {});
    expect(res.ok).toBe(false);
    expect(res.attempts).toEqual([]);
    expect(res.error).toContain('no eligible account');
    expect(res.error).toContain(`1 cooling down (a until ${formatLocalTime(until, NOW)})`);
    expect(res.error).toContain('1 disabled (d)');
    expect(claude.calls).toEqual([]);
    expect(await ledger.entries()).toHaveLength(0);
  });

  it('after all accounts hit limits the error lists them with their reset times', async () => {
    const claude = fakeProvider('claude', () => ({ ok: false, limit: { kind: 'rate', message: 'usage limit reached' } }));
    const router = makeRouter(config([A, B]), { claude });
    const res = await router.run(request(), {});
    expect(res.ok).toBe(false);
    expect(res.attempts.map((a) => a.accountId)).toEqual(['a', 'b']);
    expect(res.error).toContain('2 cooling down');
    expect(res.error).toContain(`a until ${formatLocalTime(NOW + 600_000, NOW)}`);
    expect(res.accountId).toBe('b');
  });

  it('stops at maxAttempts even when more accounts remain', async () => {
    const claude = fakeProvider('claude', () => ({ ok: false, limit: { kind: 'overloaded', message: 'overloaded_error' } }));
    const cfg = config([A, B, account({ id: 'e' })], { defaults: { permission: 'edit', timeoutSec: 1, maxAttempts: 2, cooldownSec: 1 } });
    const router = makeRouter(cfg, { claude });
    const res = await router.run(request(), {});
    expect(res.ok).toBe(false);
    expect(claude.calls).toEqual(['a', 'b']);
    expect(res.attempts).toHaveLength(2);
    expect(res.error).toContain('gave up after 2 attempts');
    expect(res.error).toContain('overloaded_error');
    const state = await ledger.state();
    expect(state.cooldowns.a?.until).toBe(NOW + 120_000);
    expect(state.cooldowns.e).toBeUndefined();
  });

  it('honours opts.account and opts.provider', async () => {
    const claude = fakeProvider('claude', () => ({}));
    const codex = fakeProvider('codex', () => ({ output: 'codex out' }));
    const router = makeRouter(config([A, B, C]), { claude, codex });
    const byAccount = await router.run(request(), { account: 'b' });
    expect(byAccount.accountId).toBe('b');
    const byProvider = await router.run(request(), { provider: 'codex' });
    expect(byProvider.accountId).toBe('c');
    expect(byProvider.output).toBe('codex out');
    const unknown = await router.run(request(), { account: 'nope' });
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain('"nope" not found');
  });

  it('treats a thrown adapter error as an ordinary failure and still appends the ledger', async () => {
    const claude = fakeProvider('claude', () => new Error('spawn claude ENOENT'));
    const router = makeRouter(config([A, B]), { claude });
    const res = await router.run(request(), {});
    expect(res.ok).toBe(false);
    expect(res.error).toBe('spawn claude ENOENT');
    expect(res.attempts).toHaveLength(1);
    expect(res.attempts[0]?.accountId).toBe('a');
    expect(claude.calls).toEqual(['a']);
    const entries = await ledger.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.ok).toBe(false);
  });

  it('round-robin bumps the cursor on every run', async () => {
    const claude = fakeProvider('claude', () => ({}));
    const router = makeRouter(config([A, B], { strategy: 'round-robin' }), { claude });
    await router.run(request(), {});
    await router.run(request(), {});
    await router.run(request(), {});
    expect(claude.calls).toEqual(['a', 'b', 'a']);
    expect((await ledger.state()).rrCursor).toBe(3);
  });

  it('least-used prefers the account with fewer tokens in the ledger', async () => {
    await ledger.append({ t: NOW - 1000, account: 'a', provider: 'claude', input: 0, output: 0, cached: 0, total: 5000, ok: true, durationMs: 1 });
    const claude = fakeProvider('claude', () => ({}));
    const router = makeRouter(config([A, B]), { claude });
    await router.run(request(), {});
    expect(claude.calls).toEqual(['b']);
  });

  it('returns cancelled without running when the signal is already aborted', async () => {
    const claude = fakeProvider('claude', () => ({}));
    const router = makeRouter(config([A]), { claude });
    const controller = new AbortController();
    controller.abort();
    const res = await router.run(request({ signal: controller.signal }), {});
    expect(res.ok).toBe(false);
    expect(res.error).toBe('cancelled');
    expect(claude.calls).toEqual([]);
  });

  it('does not retry after an abort during a run', async () => {
    const claude = fakeProvider('claude', () => ({}), 200);
    const router = makeRouter(config([A, B]), { claude });
    const controller = new AbortController();
    const pending = router.run(request({ signal: controller.signal }), {});
    setTimeout(() => controller.abort(), 20);
    const res = await pending;
    expect(res.ok).toBe(false);
    expect(res.error).toBe('aborted by signal');
    expect(claude.calls).toEqual(['a']);
    expect(res.attempts).toHaveLength(1);
  });

  it('ledger entries carry the router clock, not the adapter clock', async () => {
    const claude = fakeProvider('claude', () => ({}));
    const router = makeRouter(config([A]), { claude });
    clock = NOW + 42;
    await router.run(request(), {});
    expect((await ledger.entries())[0]?.t).toBe(NOW + 42);
  });

  it('forces the result accountId/provider to the selected account', async () => {
    const claude = fakeProvider('claude', () => ({ accountId: 'lying', provider: 'codex' }));
    const router = makeRouter(config([A]), { claude });
    const res = await router.run(request(), {} satisfies SelectOptions);
    expect(res.accountId).toBe('a');
    expect(res.provider).toBe('claude');
    expect((await ledger.entries())[0]?.account).toBe('a');
  });

  it('passes the account model to the provider unless the request pins one', async () => {
    const seen: Array<string | undefined> = [];
    const claude = fakeProvider('claude', (_acc, req) => {
      seen.push(req.model);
      return {};
    });
    const pinned = account({ id: 'p', model: 'opus' });
    const router = makeRouter(config([pinned]), { claude });
    const base = request();
    await router.run(base, {});
    await router.run(request({ model: 'haiku' }), {});
    expect(seen).toEqual(['opus', 'haiku']);
    expect(base.model).toBeUndefined();
    const plain = makeRouter(config([A]), { claude });
    await plain.run(request(), {});
    expect(seen[2]).toBeUndefined();
    expect(effectiveRequest(base, pinned)).toEqual({ ...base, model: 'opus' });
    expect(effectiveRequest(base, A)).toBe(base);
    expect(effectiveRequest(request({ model: 'x' }), pinned).model).toBe('x');
    expect(effectiveRequest(base, account({ model: '' })).model).toBeUndefined();
  });

  it('does not set a cooldown for a limit reported after the caller aborted', async () => {
    const claude = fakeProvider('claude', (_acc, req) =>
      req.signal?.aborted ? { ok: false, error: 'cancelled', limit: { kind: 'rate', message: 'rate limited' } } : {},
    );
    const router = makeRouter(config([A, B]), { claude });
    const controller = new AbortController();
    const original = claude.run.bind(claude);
    claude.run = async (req, acc, onEvent) => {
      controller.abort();
      return original(req, acc, onEvent);
    };
    const res = await router.run(request({ signal: controller.signal }), {});
    expect(res.ok).toBe(false);
    expect(res.error).toBe('cancelled');
    expect(claude.calls).toEqual(['a']);
    expect((await ledger.state()).cooldowns).toEqual({});
  });
});
