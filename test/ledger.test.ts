import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePaths } from '../src/core/paths.js';
import { WINDOW_5H_MS, WINDOW_7D_MS } from '../src/core/types.js';
import type { Account, LedgerEntry, RunResult, WindowUsage } from '../src/core/types.js';
import {
  Ledger,
  DEFAULT_KEEP_MS,
  DAY_MS,
  summarize,
  computeUtilization,
  ledgerEntryFrom,
  parseLedgerLine,
  parseLedgerLines,
  serializeLedgerEntry,
  normalizeState,
  activeCooldown,
  emptyState,
  inWindow,
} from '../src/core/ledger.js';

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

function entry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    t: NOW,
    account: 'a1',
    provider: 'claude',
    input: 10,
    output: 5,
    cached: 2,
    total: 100,
    ok: true,
    durationMs: 1000,
    ...over,
  };
}

function win(tokens: number, runs = 1, costUsd = 0): WindowUsage {
  return { tokens, runs, costUsd };
}

describe('summarize', () => {
  it('returns empty windows and no lastUsedAt with no entries', () => {
    const s = summarize([], 'a1', NOW);
    expect(s.window5h).toEqual({ tokens: 0, runs: 0, costUsd: 0 });
    expect(s.window7d).toEqual({ tokens: 0, runs: 0, costUsd: 0 });
    expect(s.lastUsedAt).toBeUndefined();
    expect('lastUsedAt' in s).toBe(false);
  });

  it('ignores entries of other accounts', () => {
    const s = summarize([entry({ account: 'other', total: 500 })], 'a1', NOW);
    expect(s.window5h.tokens).toBe(0);
    expect(s.window7d.tokens).toBe(0);
    expect(s.lastUsedAt).toBeUndefined();
  });

  it('counts entries inside the 5h window in both windows', () => {
    const s = summarize([entry({ t: NOW - 1000, total: 100, costUsd: 0.5 })], 'a1', NOW);
    expect(s.window5h).toEqual(win(100, 1, 0.5));
    expect(s.window7d).toEqual(win(100, 1, 0.5));
    expect(s.lastUsedAt).toBe(NOW - 1000);
  });

  it('excludes an entry exactly on the 5h boundary from the 5h window but keeps it in 7d', () => {
    const s = summarize([entry({ t: NOW - WINDOW_5H_MS, total: 100 })], 'a1', NOW);
    expect(s.window5h.tokens).toBe(0);
    expect(s.window5h.runs).toBe(0);
    expect(s.window7d.tokens).toBe(100);
    expect(s.window7d.runs).toBe(1);
  });

  it('includes an entry one ms inside the 5h boundary', () => {
    const s = summarize([entry({ t: NOW - WINDOW_5H_MS + 1, total: 100 })], 'a1', NOW);
    expect(s.window5h.tokens).toBe(100);
    expect(s.window7d.tokens).toBe(100);
  });

  it('excludes an entry exactly on the 7d boundary from both windows', () => {
    const s = summarize([entry({ t: NOW - WINDOW_7D_MS, total: 100 })], 'a1', NOW);
    expect(s.window5h.tokens).toBe(0);
    expect(s.window7d.tokens).toBe(0);
    expect(s.window7d.runs).toBe(0);
    expect(s.lastUsedAt).toBe(NOW - WINDOW_7D_MS);
  });

  it('includes an entry one ms inside the 7d boundary in 7d only', () => {
    const s = summarize([entry({ t: NOW - WINDOW_7D_MS + 1, total: 100 })], 'a1', NOW);
    expect(s.window5h.tokens).toBe(0);
    expect(s.window7d.tokens).toBe(100);
  });

  it('sums tokens, runs and cost across entries and tracks the newest t as lastUsedAt', () => {
    const entries = [
      entry({ t: NOW - 60_000, total: 100, costUsd: 0.1 }),
      entry({ t: NOW - 3 * 60 * 60 * 1000, total: 200, costUsd: 0.2 }),
      entry({ t: NOW - 2 * DAY_MS, total: 300 }),
      entry({ t: NOW - 10 * DAY_MS, total: 400 }),
    ];
    const s = summarize(entries, 'a1', NOW);
    expect(s.window5h).toEqual(win(300, 2, 0.1 + 0.2));
    expect(s.window7d).toEqual(win(600, 3, 0.1 + 0.2));
    expect(s.lastUsedAt).toBe(NOW - 60_000);
  });

  it('counts failed and limited runs too', () => {
    const entries = [entry({ ok: false, limited: 'rate', total: 50 }), entry({ ok: true, total: 25 })];
    const s = summarize(entries, 'a1', NOW);
    expect(s.window5h).toEqual(win(75, 2, 0));
  });

  it('inWindow is strict at the lower bound', () => {
    expect(inWindow(NOW - 10, NOW, 10)).toBe(false);
    expect(inWindow(NOW - 9, NOW, 10)).toBe(true);
    expect(inWindow(NOW, NOW, 10)).toBe(true);
  });
});

describe('computeUtilization', () => {
  it('falls back to window5h.tokens / weight when no budget is set', () => {
    expect(computeUtilization(account({ weight: 1 }), win(500), win(5000))).toBe(500);
    expect(computeUtilization(account({ weight: 2 }), win(500), win(5000))).toBe(250);
    expect(computeUtilization(account({ weight: 4 }), win(500), win(5000))).toBe(125);
  });

  it('clamps weight to 0.01 when it is zero, negative or not finite', () => {
    expect(computeUtilization(account({ weight: 0 }), win(5), win(0))).toBe(500);
    expect(computeUtilization(account({ weight: -3 }), win(5), win(0))).toBe(500);
    expect(computeUtilization(account({ weight: Number.NaN }), win(5), win(0))).toBe(500);
  });

  it('uses used/budget for tokens5h only', () => {
    const a = account({ weight: 10, budget: { tokens5h: 1000 } });
    expect(computeUtilization(a, win(250), win(900_000))).toBe(0.25);
  });

  it('uses used/budget for tokens7d only', () => {
    const a = account({ weight: 10, budget: { tokens7d: 10_000 } });
    expect(computeUtilization(a, win(9_999), win(5_000))).toBe(0.5);
  });

  it('takes the max ratio when both budgets are set', () => {
    const a = account({ budget: { tokens5h: 1000, tokens7d: 10_000 } });
    expect(computeUtilization(a, win(100), win(9_000))).toBe(0.9);
    expect(computeUtilization(a, win(900), win(1_000))).toBe(0.9);
  });

  it('can exceed 1 when over budget', () => {
    const a = account({ budget: { tokens5h: 100 } });
    expect(computeUtilization(a, win(150), win(150))).toBe(1.5);
  });

  it('ignores a zero or negative budget and uses the weight fallback', () => {
    expect(computeUtilization(account({ weight: 1, budget: { tokens5h: 0 } }), win(40), win(40))).toBe(40);
    expect(computeUtilization(account({ weight: 1, budget: { tokens7d: -5 } }), win(40), win(40))).toBe(40);
  });

  it('is always >= 0 and finite', () => {
    expect(computeUtilization(account(), win(0), win(0))).toBe(0);
    expect(computeUtilization(account({ budget: { tokens5h: 100 } }), win(0), win(0))).toBe(0);
    expect(computeUtilization(account(), win(Number.NaN), win(0))).toBe(0);
    expect(computeUtilization(account(), win(-10), win(0))).toBe(0);
    expect(computeUtilization({ ...account(), budget: undefined as unknown as Account['budget'] }, win(3), win(0))).toBe(3);
  });
});

describe('ledgerEntryFrom', () => {
  const base: RunResult = {
    ok: true,
    output: 'done',
    usage: { input: 10, output: 20, cached: 5, total: 35, costUsd: 0.12 },
    provider: 'codex',
    accountId: 'gpt-1',
    sessionId: 's',
    durationMs: 4321,
    exitCode: 0,
  };

  it('copies usage, identity and timing', () => {
    expect(ledgerEntryFrom(base, NOW)).toEqual({
      t: NOW,
      account: 'gpt-1',
      provider: 'codex',
      input: 10,
      output: 20,
      cached: 5,
      total: 35,
      costUsd: 0.12,
      ok: true,
      durationMs: 4321,
    });
  });

  it('omits costUsd when absent and records the limit kind', () => {
    const r: RunResult = {
      ...base,
      ok: false,
      usage: { input: 0, output: 0, cached: 0, total: 0 },
      error: 'usage limit reached',
      limit: { kind: 'rate', message: 'usage limit reached', resetAt: NOW + 1000 },
    };
    const e = ledgerEntryFrom(r, NOW);
    expect(e.ok).toBe(false);
    expect(e.limited).toBe('rate');
    expect('costUsd' in e).toBe(false);
    expect('limited' in ledgerEntryFrom(base, NOW)).toBe(false);
  });

  it('round-trips through serialize/parse', () => {
    const e = ledgerEntryFrom(base, NOW);
    expect(parseLedgerLine(serializeLedgerEntry(e))).toEqual(e);
  });
});

describe('parseLedgerLine', () => {
  it('rejects malformed or incomplete lines', () => {
    expect(parseLedgerLine('')).toBeUndefined();
    expect(parseLedgerLine('   ')).toBeUndefined();
    expect(parseLedgerLine('{not json')).toBeUndefined();
    expect(parseLedgerLine('42')).toBeUndefined();
    expect(parseLedgerLine('null')).toBeUndefined();
    expect(parseLedgerLine('{"account":"a","provider":"claude"}')).toBeUndefined();
    expect(parseLedgerLine('{"t":1,"provider":"claude"}')).toBeUndefined();
    expect(parseLedgerLine('{"t":1,"account":"a","provider":"gemini"}')).toBeUndefined();
  });

  it('fills missing numeric fields with 0 and drops unknown limit kinds', () => {
    const e = parseLedgerLine('{"t":5,"account":"a","provider":"codex","limited":"weird","costUsd":"x"}');
    expect(e).toEqual({ t: 5, account: 'a', provider: 'codex', input: 0, output: 0, cached: 0, total: 0, ok: false, durationMs: 0 });
  });

  it('parseLedgerLines skips bad lines and keeps order', () => {
    const lines = [serializeLedgerEntry(entry({ t: 1 })), 'garbage', serializeLedgerEntry(entry({ t: 2 }))];
    expect(parseLedgerLines(lines).map((e) => e.t)).toEqual([1, 2]);
  });
});

describe('normalizeState / activeCooldown', () => {
  it('returns the empty state for anything that is not an object', () => {
    expect(normalizeState(undefined)).toEqual(emptyState());
    expect(normalizeState(null)).toEqual(emptyState());
    expect(normalizeState('x')).toEqual(emptyState());
  });

  it('drops invalid cooldowns, cursors and lastUsed values', () => {
    const s = normalizeState({
      cooldowns: { a: { until: 10, reason: 'r' }, b: { until: 'no' }, c: 5, d: { until: 7 } },
      rrCursor: -1,
      lastUsed: { a: 3, b: 'x' },
    });
    expect(s).toEqual({ cooldowns: { a: { until: 10, reason: 'r' }, d: { until: 7, reason: '' } }, rrCursor: 0, lastUsed: { a: 3 } });
    expect(normalizeState({ rrCursor: 4.7 }).rrCursor).toBe(4);
  });

  it('activeCooldown reports only cooldowns in the future', () => {
    const s = { ...emptyState(), cooldowns: { a: { until: NOW, reason: 'x' }, b: { until: NOW + 1, reason: 'y' } } };
    expect(activeCooldown(s, 'a', NOW)).toBeUndefined();
    expect(activeCooldown(s, 'b', NOW)).toEqual({ until: NOW + 1, reason: 'y' });
    expect(activeCooldown(s, 'missing', NOW)).toBeUndefined();
  });
});

describe('Ledger', () => {
  let dir: string;
  let ledger: Ledger;
  let clock: number;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'subpool-ledger-'));
    clock = NOW;
    ledger = new Ledger(resolvePaths(dir), () => clock);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('state() returns the default state when the file is missing', async () => {
    expect(await ledger.state()).toEqual({ cooldowns: {}, rrCursor: 0, lastUsed: {} });
  });

  it('entries() returns [] when the ledger file is missing', async () => {
    expect(await ledger.entries()).toEqual([]);
  });

  it('append writes one JSON line per entry and entries() reads them back', async () => {
    await ledger.append(entry({ t: 1, total: 10 }));
    await ledger.append(entry({ t: 2, total: 20, costUsd: 0.3, limited: 'auth', ok: false }));
    const raw = await fs.readFile(path.join(dir, 'usage.jsonl'), 'utf8');
    expect(raw.split('\n').filter(Boolean)).toHaveLength(2);
    const got = await ledger.entries();
    expect(got).toEqual([entry({ t: 1, total: 10 }), entry({ t: 2, total: 20, costUsd: 0.3, limited: 'auth', ok: false })]);
  });

  it('entries(sinceMs) filters inclusively and skips malformed lines', async () => {
    await ledger.append(entry({ t: 10 }));
    await fs.appendFile(path.join(dir, 'usage.jsonl'), 'broken line\n');
    await ledger.append(entry({ t: 20 }));
    await ledger.append(entry({ t: 30 }));
    expect((await ledger.entries(20)).map((e) => e.t)).toEqual([20, 30]);
    expect((await ledger.entries(31)).map((e) => e.t)).toEqual([]);
    expect((await ledger.entries()).map((e) => e.t)).toEqual([10, 20, 30]);
  });

  it('compact drops old and malformed entries, rewrites atomically and returns the dropped count', async () => {
    const file = path.join(dir, 'usage.jsonl');
    await ledger.append(entry({ t: NOW - DEFAULT_KEEP_MS - 1 }));
    await ledger.append(entry({ t: NOW - DEFAULT_KEEP_MS }));
    await fs.appendFile(file, '{bad\n');
    await ledger.append(entry({ t: NOW - DEFAULT_KEEP_MS + 1 }));
    await ledger.append(entry({ t: NOW - 1000 }));
    const dropped = await ledger.compact();
    expect(dropped).toBe(3);
    expect((await ledger.entries()).map((e) => e.t)).toEqual([NOW - DEFAULT_KEEP_MS + 1, NOW - 1000]);
    const raw = await fs.readFile(file, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.split('\n').filter(Boolean)).toHaveLength(2);
    expect((await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('compact honours a custom keepMs and returns 0 when nothing is dropped', async () => {
    const file = path.join(dir, 'usage.jsonl');
    await ledger.append(entry({ t: NOW - 5000 }));
    await ledger.append(entry({ t: NOW - 500 }));
    const before = await fs.stat(file);
    expect(await ledger.compact(10_000)).toBe(0);
    expect((await fs.stat(file)).ino).toBe(before.ino);
    expect(await ledger.compact(1000)).toBe(1);
    expect((await ledger.entries()).map((e) => e.t)).toEqual([NOW - 500]);
    expect(await ledger.compact(100)).toBe(1);
    expect(await ledger.entries()).toEqual([]);
    expect(await fs.readFile(file, 'utf8')).toBe('');
  });

  it('compact on a missing file returns 0 and does not create it', async () => {
    expect(await ledger.compact()).toBe(0);
    await expect(fs.stat(path.join(dir, 'usage.jsonl'))).rejects.toThrow();
  });

  it('setCooldown / clearCooldown persist to state.json with mode 0600', async () => {
    await ledger.setCooldown('a1', NOW + 60_000, 'usage limit reached');
    const s1 = await ledger.state();
    expect(s1.cooldowns).toEqual({ a1: { until: NOW + 60_000, reason: 'usage limit reached' } });
    const stat = await fs.stat(path.join(dir, 'state.json'));
    expect(stat.mode & 0o777).toBe(0o600);
    await ledger.setCooldown('a1', NOW + 90_000, 'again');
    expect((await ledger.state()).cooldowns.a1).toEqual({ until: NOW + 90_000, reason: 'again' });
    await ledger.clearCooldown('a1');
    expect((await ledger.state()).cooldowns).toEqual({});
    await ledger.clearCooldown('never-set');
    expect((await ledger.state()).cooldowns).toEqual({});
  });

  it('touch records the clock for the account and preserves other state', async () => {
    await ledger.setCooldown('b', NOW + 1, 'x');
    await ledger.touch('a1');
    clock = NOW + 5;
    await ledger.touch('a2');
    const s = await ledger.state();
    expect(s.lastUsed).toEqual({ a1: NOW, a2: NOW + 5 });
    expect(s.cooldowns).toEqual({ b: { until: NOW + 1, reason: 'x' } });
  });

  it('bumpCursor returns the previous value and increments', async () => {
    expect(await ledger.bumpCursor()).toBe(0);
    expect(await ledger.bumpCursor()).toBe(1);
    expect(await ledger.bumpCursor()).toBe(2);
    expect((await ledger.state()).rrCursor).toBe(3);
  });

  it('serializes concurrent state mutations so none are lost', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => ledger.bumpCursor()));
    expect([...results].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await Promise.all([ledger.touch('x'), ledger.setCooldown('y', NOW + 10, 'r'), ledger.touch('z')]);
    const s = await ledger.state();
    expect(s.rrCursor).toBe(10);
    expect(s.lastUsed).toEqual({ x: NOW, z: NOW });
    expect(s.cooldowns).toEqual({ y: { until: NOW + 10, reason: 'r' } });
    expect((await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('two Ledger instances on the same home never lose each other\'s updates', async () => {
    const other = new Ledger(resolvePaths(dir), () => clock);
    await Promise.all([
      ledger.setCooldown('a', NOW + 10_000, 'limit'),
      other.touch('a'),
      ledger.touch('b'),
      other.setCooldown('c', NOW + 20_000, 'limit'),
      ledger.bumpCursor(),
      other.bumpCursor(),
      other.clearCooldown('never'),
    ]);
    const s = await ledger.state();
    expect(s.cooldowns).toEqual({ a: { until: NOW + 10_000, reason: 'limit' }, c: { until: NOW + 20_000, reason: 'limit' } });
    expect(s.lastUsed).toEqual({ a: NOW, b: NOW });
    expect(s.rrCursor).toBe(2);
    await Promise.all([
      ledger.append(entry({ t: NOW - 3 })),
      other.append(entry({ t: NOW - 2 })),
      ledger.compact(),
      other.append(entry({ t: NOW - 1 })),
      other.compact(),
    ]);
    expect((await other.entries()).map((e) => e.t).sort((a, b) => a - b)).toEqual([NOW - 3, NOW - 2, NOW - 1]);
    expect((await fs.readdir(dir)).filter((f) => f.startsWith('.lock'))).toEqual([]);
  });

  it('a corrupted state file is normalized instead of crashing on fields', async () => {
    await fs.writeFile(path.join(dir, 'state.json'), '{"rrCursor":"abc","cooldowns":[],"lastUsed":null}');
    expect(await ledger.state()).toEqual(emptyState());
  });

  it('usage() reports one entry per account with windows, utilization, lastUsedAt and active cooldowns', async () => {
    const a1 = account({ id: 'a1', weight: 2 });
    const a2 = account({ id: 'a2', provider: 'codex', budget: { tokens5h: 1000, tokens7d: 5000 }, enabled: false });
    const a3 = account({ id: 'a3' });
    await ledger.append(entry({ account: 'a1', t: NOW - 1000, total: 100, costUsd: 0.5 }));
    await ledger.append(entry({ account: 'a1', t: NOW - 2 * DAY_MS, total: 300 }));
    await ledger.append(entry({ account: 'a2', provider: 'codex', t: NOW - 10, total: 400 }));
    await ledger.append(entry({ account: 'a2', provider: 'codex', t: NOW - DAY_MS, total: 2000 }));
    await ledger.setCooldown('a1', NOW + 30_000, 'rate limited');
    await ledger.setCooldown('a2', NOW, 'expired exactly now');
    await ledger.setCooldown('a3', NOW - 1, 'expired');
    const usages = await ledger.usage([a1, a2, a3]);
    expect(usages.map((u) => u.accountId)).toEqual(['a1', 'a2', 'a3']);

    const u1 = usages[0]!;
    expect(u1.provider).toBe('claude');
    expect(u1.enabled).toBe(true);
    expect(u1.window5h).toEqual(win(100, 1, 0.5));
    expect(u1.window7d).toEqual(win(400, 2, 0.5));
    expect(u1.utilization).toBe(50);
    expect(u1.lastUsedAt).toBe(NOW - 1000);
    expect(u1.cooldownUntil).toBe(NOW + 30_000);
    expect(u1.cooldownReason).toBe('rate limited');

    const u2 = usages[1]!;
    expect(u2.provider).toBe('codex');
    expect(u2.enabled).toBe(false);
    expect(u2.window5h.tokens).toBe(400);
    expect(u2.window7d.tokens).toBe(2400);
    expect(u2.utilization).toBeCloseTo(0.48, 10);
    expect(u2.cooldownUntil).toBeUndefined();
    expect(u2.cooldownReason).toBeUndefined();
    expect('cooldownUntil' in u2).toBe(false);

    const u3 = usages[2]!;
    expect(u3.window5h).toEqual(win(0, 0, 0));
    expect(u3.utilization).toBe(0);
    expect(u3.lastUsedAt).toBeUndefined();
    expect('lastUsedAt' in u3).toBe(false);
    expect(u3.cooldownUntil).toBeUndefined();
  });

  it('usage() prefers the newer of state.lastUsed and the ledger for lastUsedAt', async () => {
    await ledger.append(entry({ account: 'a1', t: NOW - 5000 }));
    clock = NOW - 100;
    await ledger.touch('a1');
    clock = NOW;
    let [u] = await ledger.usage([account({ id: 'a1' })]);
    expect(u!.lastUsedAt).toBe(NOW - 100);
    await ledger.append(entry({ account: 'a1', t: NOW - 50 }));
    [u] = await ledger.usage([account({ id: 'a1' })]);
    expect(u!.lastUsedAt).toBe(NOW - 50);
    [u] = await ledger.usage([account({ id: 'untouched' })]);
    expect(u!.lastUsedAt).toBeUndefined();
  });

  it('usage() works with no files at all', async () => {
    const usages = await ledger.usage([account({ id: 'a1' }), account({ id: 'a2', provider: 'codex' })]);
    expect(usages).toEqual([
      { accountId: 'a1', provider: 'claude', enabled: true, window5h: win(0, 0), window7d: win(0, 0), utilization: 0 },
      { accountId: 'a2', provider: 'codex', enabled: true, window5h: win(0, 0), window7d: win(0, 0), utilization: 0 },
    ]);
  });

  it('uses Date.now when no clock is given', async () => {
    const real = new Ledger(resolvePaths(dir));
    const before = Date.now();
    await real.touch('a1');
    const after = Date.now();
    const t = (await real.state()).lastUsed.a1!;
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });
});
