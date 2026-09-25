import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePaths, type Paths } from '../src/core/paths.js';
import { Ledger } from '../src/core/ledger.js';
import { Router } from '../src/core/router.js';
import type { Account, Config, Job, ProviderAdapter, RunEvent, RunRequest, RunResult } from '../src/core/types.js';
import {
  JobManager,
  MAX_EVENTS,
  MAX_KEPT_JOBS,
  clampWaitMs,
  evictable,
  isTerminal,
  jobFile,
  pruneJobs,
  pushEvent,
  snapshotOf,
  statusFromResult,
  stripSignal,
} from '../src/core/jobs.js';
import { MAX_TIMER_MS } from '../src/core/exec.js';
import { DEFAULT_KEEP_MS } from '../src/core/ledger.js';

const NOW = 1_800_000_000_000;

function account(over: Partial<Account> = {}): Account {
  return {
    id: 'a',
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

function config(accounts: Account[]): Config {
  return {
    version: 1,
    strategy: 'priority',
    defaults: { permission: 'edit', timeoutSec: 60, maxAttempts: 3, cooldownSec: 600 },
    accounts,
  };
}

const REQ: Omit<RunRequest, 'signal'> = { prompt: 'task', cwd: '/tmp', permission: 'edit', timeoutSec: 60 };

interface Behaviour {
  delayMs?: number;
  events?: number;
  result?: Partial<RunResult>;
  throwError?: Error;
}

function fakeProvider(behaviour: Behaviour): ProviderAdapter & { calls: number } {
  const adapter = {
    id: 'claude' as const,
    binary: 'claude',
    calls: 0,
    async login() {},
    async status() {
      return { loggedIn: true };
    },
    async run(req: RunRequest, acc: Account, onEvent?: (e: RunEvent) => void): Promise<RunResult> {
      adapter.calls += 1;
      onEvent?.({ type: 'start', at: 1 });
      for (let i = 0; i < (behaviour.events ?? 0); i++) onEvent?.({ type: 'message', at: i + 2, text: `event ${i}` });
      if (behaviour.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, behaviour.delayMs);
          req.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new Error('killed by abort'));
            },
            { once: true },
          );
        });
      }
      if (behaviour.throwError) throw behaviour.throwError;
      onEvent?.({ type: 'end', at: 99 });
      return {
        ok: true,
        output: `output for ${acc.id}`,
        usage: { input: 1, output: 1, cached: 0, total: 2 },
        provider: 'claude',
        accountId: acc.id,
        durationMs: 3,
        exitCode: 0,
        ...behaviour.result,
      };
    },
  };
  return adapter;
}

describe('pure helpers', () => {
  it('pushEvent keeps only the last MAX_EVENTS entries', () => {
    const events: RunEvent[] = [];
    for (let i = 0; i < MAX_EVENTS + 25; i++) pushEvent(events, { type: 'message', at: i });
    expect(events).toHaveLength(MAX_EVENTS);
    expect(events[0]?.at).toBe(25);
    expect(events[events.length - 1]?.at).toBe(MAX_EVENTS + 24);
    const small: RunEvent[] = [];
    pushEvent(small, { type: 'start', at: 1 }, 1);
    pushEvent(small, { type: 'end', at: 2 }, 1);
    expect(small).toEqual([{ type: 'end', at: 2 }]);
  });

  it('stripSignal drops a runtime signal property', () => {
    const withSignal = { ...REQ, signal: new AbortController().signal } as unknown as Omit<RunRequest, 'signal'>;
    const stripped = stripSignal(withSignal);
    expect('signal' in stripped).toBe(false);
    expect(stripped).toEqual(REQ);
    expect(() => structuredClone(stripped)).not.toThrow();
  });

  it('isTerminal and statusFromResult', () => {
    expect(isTerminal('queued')).toBe(false);
    expect(isTerminal('running')).toBe(false);
    expect(isTerminal('done')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    const base: RunResult = { ok: true, output: '', usage: { input: 0, output: 0, cached: 0, total: 0 }, provider: 'claude', accountId: 'a', durationMs: 0, exitCode: 0 };
    expect(statusFromResult({ ...base, attempts: [] }, false)).toBe('done');
    expect(statusFromResult({ ...base, ok: false, attempts: [] }, false)).toBe('failed');
    expect(statusFromResult({ ...base, attempts: [] }, true)).toBe('cancelled');
  });

  it('jobFile lives under paths.jobs', () => {
    const paths = resolvePaths('/x');
    expect(jobFile(paths, 'job_1')).toBe(path.join('/x', 'jobs', 'job_1.json'));
  });

  it('snapshotOf returns a deep copy', () => {
    const job: Job = { id: 'j', status: 'queued', createdAt: 1, request: { ...REQ }, options: {}, attempts: [], events: [] };
    const snap = snapshotOf(job);
    snap.events.push({ type: 'start', at: 1 });
    snap.request.prompt = 'changed';
    expect(job.events).toEqual([]);
    expect(job.request.prompt).toBe('task');
  });

  it('clampWaitMs keeps timers inside the Node limit', () => {
    expect(clampWaitMs(500)).toBe(500);
    expect(clampWaitMs(0)).toBe(0);
    expect(clampWaitMs(-5)).toBe(0);
    expect(clampWaitMs(Number.NaN)).toBe(0);
    expect(clampWaitMs(3_000_000_000)).toBe(MAX_TIMER_MS);
    expect(clampWaitMs(Number.POSITIVE_INFINITY)).toBe(MAX_TIMER_MS);
  });

  it('evictable picks the oldest terminal jobs beyond the cap and never running ones', () => {
    const job = (id: string, createdAt: number, status: Job['status']): Job => ({ id, status, createdAt, request: { ...REQ }, options: {}, attempts: [], events: [] });
    const jobs = [job('a', 1, 'done'), job('b', 2, 'running'), job('c', 3, 'failed'), job('d', 4, 'cancelled'), job('e', 5, 'queued')];
    expect(evictable(jobs, 5)).toEqual([]);
    expect(evictable(jobs, 3)).toEqual(['a', 'c']);
    expect(evictable(jobs, 1)).toEqual(['a', 'c', 'd']);
    expect(MAX_KEPT_JOBS).toBe(200);
  });
});

describe('pruneJobs', () => {
  it('removes job files older than keepMs and leaves the rest', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'subpool-prune-'));
    try {
      const paths = resolvePaths(home);
      await fs.mkdir(paths.jobs, { recursive: true });
      const old = path.join(paths.jobs, 'job_old.json');
      const fresh = path.join(paths.jobs, 'job_new.json');
      const other = path.join(paths.jobs, 'notes.txt');
      for (const f of [old, fresh, other]) await fs.writeFile(f, '{}');
      const real = Date.now();
      const ancient = new Date(real - DEFAULT_KEEP_MS - 60_000);
      await fs.utimes(old, ancient, ancient);
      await fs.utimes(other, ancient, ancient);
      expect(await pruneJobs(paths, DEFAULT_KEEP_MS, real)).toBe(1);
      expect((await fs.readdir(paths.jobs)).sort()).toEqual(['job_new.json', 'notes.txt']);
      expect(await pruneJobs(paths, DEFAULT_KEEP_MS, real)).toBe(0);
      expect(await pruneJobs(resolvePaths(path.join(home, 'missing')))).toBe(0);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

describe('JobManager', () => {
  let home: string;
  let paths: Paths;
  let ledger: Ledger;
  let clock = NOW;
  const now = () => clock;

  beforeEach(async () => {
    clock = NOW;
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'subpool-jobs-'));
    paths = resolvePaths(home);
    ledger = new Ledger(paths, now);
  });

  const managers: JobManager[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.drain()));
    await fs.rm(home, { recursive: true, force: true });
  });

  function track(m: JobManager): JobManager {
    managers.push(m);
    return m;
  }

  function manager(provider: ProviderAdapter, accounts: Account[] = [account()], maxKeptJobs?: number): JobManager {
    const router = new Router({
      paths,
      ledger,
      providers: { claude: provider, codex: { ...provider, id: 'codex' } },
      loadConfig: async () => config(accounts),
      now,
    });
    return track(new JobManager(router, paths, now, maxKeptJobs === undefined ? {} : { maxKeptJobs }));
  }

  async function readJobFile(id: string): Promise<Job> {
    return JSON.parse(await fs.readFile(jobFile(paths, id), 'utf8')) as Job;
  }

  it('submit returns a queued snapshot and the job finishes as done', async () => {
    const jobs = manager(fakeProvider({ events: 2 }));
    const snap = jobs.submit(REQ, { provider: 'claude' });
    expect(snap.status).toBe('queued');
    expect(snap.id.startsWith('job_')).toBe(true);
    expect(snap.createdAt).toBe(NOW);
    expect(snap.request).toEqual(REQ);
    expect(snap.options).toEqual({ provider: 'claude' });
    expect(Object.keys(snap)).not.toContain('controller');
    expect(() => structuredClone(snap)).not.toThrow();
    const finished = await jobs.wait(snap.id, 5000);
    expect(finished.status).toBe('done');
    expect(finished.result?.output).toBe('output for a');
    expect(finished.accountId).toBe('a');
    expect(finished.provider).toBe('claude');
    expect(finished.attempts).toEqual([{ accountId: 'a', provider: 'claude', durationMs: 3 }]);
    expect(finished.events.map((e) => e.type)).toEqual(['start', 'message', 'message', 'end']);
    expect(finished.startedAt).toBe(NOW);
    expect(finished.finishedAt).toBe(NOW);
    expect(finished.error).toBeUndefined();
    expect(() => structuredClone(finished)).not.toThrow();
  });

  it('persists jobs/<id>.json on each status change', async () => {
    const jobs = manager(fakeProvider({ delayMs: 30 }));
    const snap = jobs.submit(REQ, {});
    await jobs.flush();
    const running = await readJobFile(snap.id);
    expect(running.status).toBe('running');
    expect(running.startedAt).toBe(NOW);
    await jobs.wait(snap.id, 5000);
    await jobs.flush();
    const done = await readJobFile(snap.id);
    expect(done.status).toBe('done');
    expect(done.result?.ok).toBe(true);
    expect(done.finishedAt).toBe(NOW);
    expect(Object.keys(done)).not.toContain('controller');
    const files = await fs.readdir(paths.jobs);
    expect(files).toEqual([`${snap.id}.json`]);
  });

  it('wait returns the running snapshot after the timeout without cancelling', async () => {
    const provider = fakeProvider({ delayMs: 150 });
    const jobs = manager(provider);
    const snap = jobs.submit(REQ, {});
    const started = Date.now();
    const partial = await jobs.wait(snap.id, 20);
    expect(Date.now() - started).toBeLessThan(140);
    expect(partial.status).toBe('running');
    expect(partial.events.map((e) => e.type)).toEqual(['start']);
    const finished = await jobs.wait(snap.id, 5000);
    expect(finished.status).toBe('done');
    expect(provider.calls).toBe(1);
  });

  it('wait resolves immediately for a finished job and rejects unknown ids', async () => {
    const jobs = manager(fakeProvider({}));
    const snap = jobs.submit(REQ, {});
    await jobs.wait(snap.id, 5000);
    const started = Date.now();
    const again = await jobs.wait(snap.id, 10_000);
    expect(again.status).toBe('done');
    expect(Date.now() - started).toBeLessThan(1000);
    await expect(jobs.wait('job_missing', 10)).rejects.toThrow('unknown job job_missing');
  });

  it('cancel aborts the run, marks cancelled and persists', async () => {
    const provider = fakeProvider({ delayMs: 500 });
    const jobs = manager(provider, [account({ id: 'a' }), account({ id: 'b' })]);
    const snap = jobs.submit(REQ, {});
    await new Promise((r) => setTimeout(r, 10));
    expect(jobs.cancel(snap.id)).toBe(true);
    expect(jobs.get(snap.id)?.status).toBe('cancelled');
    const early = await jobs.wait(snap.id, 5000);
    expect(early.status).toBe('cancelled');
    expect(early.error).toBeTruthy();
    await jobs.settled(snap.id);
    const finished = jobs.get(snap.id)!;
    expect(finished.status).toBe('cancelled');
    expect(finished.finishedAt).toBe(NOW);
    expect(finished.error).toBe('killed by abort');
    expect(provider.calls).toBe(1);
    expect(jobs.cancel(snap.id)).toBe(false);
    expect(jobs.cancel('job_nope')).toBe(false);
    const persisted = await readJobFile(snap.id);
    expect(persisted.status).toBe('cancelled');
    expect(persisted.attempts).toHaveLength(1);
  });

  it('marks failed when the routed result is not ok', async () => {
    const jobs = manager(fakeProvider({ result: { ok: false, error: 'exit 1: nope', exitCode: 1 } }));
    const snap = jobs.submit(REQ, {});
    const finished = await jobs.wait(snap.id, 5000);
    expect(finished.status).toBe('failed');
    expect(finished.error).toBe('exit 1: nope');
    expect(finished.result?.ok).toBe(false);
  });

  it('marks failed when no account is eligible', async () => {
    const jobs = manager(fakeProvider({}), [account({ enabled: false })]);
    const snap = jobs.submit(REQ, {});
    const finished = await jobs.wait(snap.id, 5000);
    expect(finished.status).toBe('failed');
    expect(finished.error).toContain('no eligible account');
    expect(finished.attempts).toEqual([]);
  });

  it('marks failed when the router throws', async () => {
    const router = { run: async () => { throw new Error('config broken'); } } as unknown as Router;
    const jobs = track(new JobManager(router, paths, now));
    const snap = jobs.submit(REQ, {});
    const finished = await jobs.wait(snap.id, 5000);
    expect(finished.status).toBe('failed');
    expect(finished.error).toBe('config broken');
    await jobs.flush();
    expect((await readJobFile(snap.id)).status).toBe('failed');
  });

  it('keeps only the last 200 events', async () => {
    const jobs = manager(fakeProvider({ events: 300 }));
    const snap = jobs.submit(REQ, {});
    const finished = await jobs.wait(snap.id, 5000);
    expect(finished.events).toHaveLength(MAX_EVENTS);
    expect(finished.events[finished.events.length - 1]?.type).toBe('end');
    expect(finished.events[0]?.text).toBe(`event ${300 - MAX_EVENTS + 1}`);
  });

  it('get and list return independent snapshots', async () => {
    const jobs = manager(fakeProvider({ delayMs: 40 }));
    const first = jobs.submit(REQ, {});
    const second = jobs.submit({ ...REQ, prompt: 'other' }, { account: 'a' });
    expect(jobs.list().map((j) => j.id)).toEqual([first.id, second.id]);
    const got = jobs.get(first.id);
    expect(got).toBeDefined();
    got!.events.push({ type: 'text', at: 0, text: 'tamper' });
    got!.status = 'done';
    expect(jobs.get(first.id)?.events.some((e) => e.text === 'tamper')).toBe(false);
    expect(jobs.get(first.id)?.status).toBe('running');
    expect(jobs.get('job_missing')).toBeUndefined();
    for (const j of jobs.list()) expect(() => structuredClone(j)).not.toThrow();
    await Promise.all([jobs.wait(first.id, 5000), jobs.wait(second.id, 5000)]);
    expect(jobs.list().map((j) => j.status)).toEqual(['done', 'done']);
  });

  it('wait with a huge timeout still resolves when the job finishes', async () => {
    const jobs = manager(fakeProvider({ delayMs: 40 }));
    const snap = jobs.submit(REQ, {});
    const finished = await jobs.wait(snap.id, Number.MAX_SAFE_INTEGER);
    expect(finished.status).toBe('done');
  });

  it('evicts the oldest finished jobs beyond maxKeptJobs but keeps their files', async () => {
    const jobs = manager(fakeProvider({}), [account()], 2);
    const first = jobs.submit(REQ, {});
    await jobs.settled(first.id);
    clock = NOW + 1;
    const second = jobs.submit(REQ, {});
    await jobs.settled(second.id);
    expect(jobs.list().map((j) => j.id)).toEqual([first.id, second.id]);
    clock = NOW + 2;
    const third = jobs.submit(REQ, {});
    await jobs.settled(third.id);
    await jobs.flush();
    const ids = jobs.list().map((j) => j.id);
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain(first.id);
    expect(ids).toEqual([second.id, third.id]);
    expect(jobs.get(first.id)).toBeUndefined();
    expect((await fs.readdir(paths.jobs)).sort()).toEqual([first.id, second.id, third.id].map((id) => `${id}.json`).sort());
  });

  it('does not let a caller-supplied signal or exclude array leak into the job', async () => {
    const jobs = manager(fakeProvider({}));
    const exclude = ['zzz'];
    const reqWithSignal = { ...REQ, signal: new AbortController().signal } as unknown as Omit<RunRequest, 'signal'>;
    const snap = jobs.submit(reqWithSignal, { exclude });
    exclude.push('mutated');
    expect('signal' in snap.request).toBe(false);
    expect(jobs.get(snap.id)?.options.exclude).toEqual(['zzz']);
    const finished = await jobs.wait(snap.id, 5000);
    expect(finished.status).toBe('done');
  });
});
