import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Paths } from './paths.js';
import type { Job, JobStatus, RoutedResult, RunEvent, RunRequest, SelectOptions } from './types.js';
import { newId, writeFileAtomic } from './fsx.js';
import { MAX_TIMER_MS } from './exec.js';
import { DEFAULT_KEEP_MS } from './ledger.js';
import type { Router } from './router.js';

export const MAX_EVENTS = 200;
export const MAX_KEPT_JOBS = 200;

const TERMINAL: ReadonlySet<JobStatus> = new Set<JobStatus>(['done', 'failed', 'cancelled']);

export interface JobManagerOptions {
  maxKeptJobs?: number;
}

interface Entry {
  job: Job;
  controller: AbortController;
  done: Promise<void>;
  finish: () => void;
  persistQueue: Promise<void>;
}

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.has(status);
}

export function jobFile(paths: Paths, id: string): string {
  return path.join(paths.jobs, `${id}.json`);
}

export function stripSignal(req: Omit<RunRequest, 'signal'>): Omit<RunRequest, 'signal'> {
  const copy: Record<string, unknown> = { ...req };
  delete copy.signal;
  return copy as Omit<RunRequest, 'signal'>;
}

export function pushEvent(events: RunEvent[], event: RunEvent, max: number = MAX_EVENTS): void {
  events.push(event);
  if (events.length > max) events.splice(0, events.length - max);
}

export function snapshotOf(job: Job): Job {
  return structuredClone(job);
}

export function statusFromResult(result: RoutedResult, aborted: boolean): JobStatus {
  if (aborted) return 'cancelled';
  return result.ok ? 'done' : 'failed';
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function clampWaitMs(timeoutMs: number): number {
  if (!(timeoutMs > 0)) return 0;
  return Math.min(timeoutMs, MAX_TIMER_MS);
}

export function evictable(jobs: Job[], maxKept: number): string[] {
  if (jobs.length <= maxKept) return [];
  const terminal = jobs.filter((j) => isTerminal(j.status)).sort((a, b) => a.createdAt - b.createdAt);
  return terminal.slice(0, jobs.length - maxKept).map((j) => j.id);
}

export async function pruneJobs(paths: Paths, keepMs: number = DEFAULT_KEEP_MS, now: number = Date.now()): Promise<number> {
  let names: string[];
  try {
    names = await fs.readdir(paths.jobs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  const cutoff = now - keepMs;
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(paths.jobs, name);
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
      await fs.unlink(file);
      removed += 1;
    } catch {
      void 0;
    }
  }
  return removed;
}

export class JobManager {
  private readonly router: Router;
  private readonly paths: Paths;
  private readonly now: () => number;
  private readonly maxKeptJobs: number;
  private readonly entries = new Map<string, Entry>();

  constructor(router: Router, paths: Paths, now?: () => number, opts: JobManagerOptions = {}) {
    this.router = router;
    this.paths = paths;
    this.now = now ?? (() => Date.now());
    this.maxKeptJobs = Math.max(1, Math.floor(opts.maxKeptJobs ?? MAX_KEPT_JOBS));
  }

  submit(req: Omit<RunRequest, 'signal'>, opts: SelectOptions): Job {
    const id = newId('job');
    const options: SelectOptions = { ...opts };
    if (opts.exclude) options.exclude = [...opts.exclude];
    const job: Job = {
      id,
      status: 'queued',
      createdAt: this.now(),
      request: stripSignal(req),
      options,
      attempts: [],
      events: [],
    };
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const entry: Entry = { job, controller: new AbortController(), done, finish, persistQueue: Promise.resolve() };
    this.entries.set(id, entry);
    this.persist(entry);
    const snapshot = snapshotOf(job);
    void this.start(entry);
    return snapshot;
  }

  get(id: string): Job | undefined {
    const entry = this.entries.get(id);
    return entry ? snapshotOf(entry.job) : undefined;
  }

  list(): Job[] {
    return [...this.entries.values()].map((e) => snapshotOf(e.job));
  }

  async wait(id: string, timeoutMs: number): Promise<Job> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`unknown job ${id}`);
    if (isTerminal(entry.job.status)) return snapshotOf(entry.job);
    const ms = clampWaitMs(timeoutMs);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    try {
      await Promise.race([entry.done, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return snapshotOf(entry.job);
  }

  cancel(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (isTerminal(entry.job.status)) return false;
    entry.job.status = 'cancelled';
    entry.job.error = entry.job.error ?? 'cancelled';
    this.persist(entry);
    entry.controller.abort();
    return true;
  }

  async flush(): Promise<void> {
    await Promise.all([...this.entries.values()].map((e) => e.persistQueue));
  }

  async drain(): Promise<void> {
    await Promise.all([...this.entries.values()].map((e) => e.done));
    await this.flush();
  }

  async settled(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`unknown job ${id}`);
    await entry.done;
    await entry.persistQueue;
  }

  private persist(entry: Entry): void {
    const data = `${JSON.stringify(snapshotOf(entry.job), null, 2)}\n`;
    const file = jobFile(this.paths, entry.job.id);
    entry.persistQueue = entry.persistQueue
      .then(() => writeFileAtomic(file, data, 0o600))
      .catch(() => undefined);
  }

  private async start(entry: Entry): Promise<void> {
    const job = entry.job;
    const signal = entry.controller.signal;
    if (job.status === 'queued') {
      job.status = 'running';
      job.startedAt = this.now();
      this.persist(entry);
    }
    const onEvent = (e: RunEvent, accountId: string): void => {
      pushEvent(job.events, { ...e });
      job.accountId = accountId;
    };
    try {
      const result = await this.router.run({ ...job.request, signal }, job.options, onEvent);
      job.result = result;
      job.attempts = result.attempts;
      if (result.accountId) job.accountId = result.accountId;
      job.provider = result.provider;
      if (result.error !== undefined) job.error = result.error;
      if (job.status !== 'cancelled') job.status = statusFromResult(result, signal.aborted);
    } catch (err) {
      job.error = errorMessage(err);
      if (job.status !== 'cancelled') job.status = signal.aborted ? 'cancelled' : 'failed';
    }
    job.finishedAt = this.now();
    this.persist(entry);
    entry.finish();
    this.evict();
  }

  private evict(): void {
    const ids = evictable([...this.entries.values()].map((e) => e.job), this.maxKeptJobs);
    for (const id of ids) this.entries.delete(id);
  }
}
