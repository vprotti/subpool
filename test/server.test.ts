import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolvePaths, ensureDirs, type Paths } from '../src/core/paths.js';
import { Ledger } from '../src/core/ledger.js';
import { Router } from '../src/core/router.js';
import { JobManager } from '../src/core/jobs.js';
import { loadConfig, saveConfig, defaultConfig, newAccount } from '../src/core/config.js';
import type { Account, Config, Job, ProviderAdapter, ProviderId, RunEvent, RunRequest, RunResult } from '../src/core/types.js';
import {
  createServer,
  applyAccountSet,
  delegateRequest,
  jobPayload,
  linkHelpPayload,
  taskPreview,
  usagePayload,
  waitJob,
  withDeadline,
  DEFAULT_JOB_WAIT_SEC,
  RESOURCE_ACCOUNTS,
  RESOURCE_USAGE,
} from '../src/server.js';

interface Behaviour {
  delayMs?: number;
  events?: string[];
  result?: Partial<RunResult>;
  throwError?: Error;
}

interface FakeProvider extends ProviderAdapter {
  calls: Array<{ req: RunRequest; account: Account }>;
  behaviour: Behaviour;
}

function fakeProvider(id: ProviderId, behaviour: Behaviour = {}): FakeProvider {
  const adapter: FakeProvider = {
    id,
    binary: id,
    calls: [],
    behaviour,
    async login() {},
    async status() {
      return { loggedIn: true };
    },
    async run(req: RunRequest, account: Account, onEvent?: (e: RunEvent) => void): Promise<RunResult> {
      adapter.calls.push({ req, account });
      onEvent?.({ type: 'start', at: Date.now() });
      for (const text of adapter.behaviour.events ?? []) onEvent?.({ type: 'message', at: Date.now(), text });
      if (adapter.behaviour.delayMs) {
        const delayMs = adapter.behaviour.delayMs;
        const timeoutMs = req.timeoutSec * 1000;
        const killed = await new Promise<boolean>((resolve, reject) => {
          const timer = setTimeout(() => resolve(timeoutMs < delayMs), Math.min(delayMs, timeoutMs));
          req.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new Error('killed by abort'));
            },
            { once: true },
          );
        });
        if (killed) {
          return {
            ok: false,
            output: '',
            usage: { input: 0, output: 0, cached: 0, total: 0 },
            provider: id,
            accountId: account.id,
            durationMs: timeoutMs,
            exitCode: null,
            error: `timeout after ${req.timeoutSec}s`,
          };
        }
      }
      if (adapter.behaviour.throwError) throw adapter.behaviour.throwError;
      onEvent?.({ type: 'end', at: Date.now() });
      return {
        ok: true,
        output: `${id} worker output for ${account.id}: ${req.prompt}`,
        usage: { input: 10, output: 5, cached: 2, total: 15 },
        provider: id,
        accountId: account.id,
        durationMs: 7,
        exitCode: 0,
        ...adapter.behaviour.result,
      };
    },
  };
  return adapter;
}

interface Harness {
  home: string;
  paths: Paths;
  client: Client;
  server: McpServer;
  claude: FakeProvider;
  codex: FakeProvider;
  jobs: JobManager;
  close: () => Promise<void>;
}

async function harness(opts: { accounts?: Account[]; config?: Partial<Config>; progressIntervalMs?: number } = {}): Promise<Harness> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'subpool-server-'));
  const paths = resolvePaths(home);
  ensureDirs(paths);
  const claude = fakeProvider('claude');
  const codex = fakeProvider('codex');
  const accounts =
    opts.accounts ??
    [
      newAccount({ id: 'work', provider: 'claude', profileDir: path.join(paths.profiles, 'claude-work') }),
      newAccount({ id: 'team', provider: 'codex', profileDir: path.join(paths.profiles, 'codex-team') }),
    ];
  const config: Config = { ...defaultConfig(), strategy: 'priority', ...opts.config, accounts };
  await saveConfig(paths, config);
  const ledger = new Ledger(paths);
  const load = (): Promise<Config> => loadConfig(paths);
  const providers = { claude, codex };
  const router = new Router({ paths, ledger, providers, loadConfig: load });
  const jobs = new JobManager(router, paths);
  const server = createServer({
    paths,
    ledger,
    jobs,
    loadConfig: load,
    saveConfig: (c) => saveConfig(paths, c),
    providers,
    progressIntervalMs: opts.progressIntervalMs,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'server-test', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    home,
    paths,
    client,
    server,
    claude,
    codex,
    jobs,
    close: async () => {
      for (const job of jobs.list()) jobs.cancel(job.id);
      await client.close();
      await server.close();
      await jobs.drain().catch(() => undefined);
      await fs.rm(home, { recursive: true, force: true });
    },
  };
}

type ToolPayload = Record<string, any>;

async function call(client: Client, name: string, args: Record<string, unknown> = {}, options?: { onprogress?: (p: { progress: number; message?: string }) => void }): Promise<{ payload: ToolPayload; isError: boolean }> {
  const res = await client.callTool({ name, arguments: args }, undefined, options ? { onprogress: options.onprogress, timeout: 10_000 } : { timeout: 10_000 });
  const content = res.content as Array<{ type: string; text?: string }>;
  expect(content).toHaveLength(1);
  expect(content[0]?.type).toBe('text');
  return { payload: JSON.parse(content[0]?.text ?? '{}') as ToolPayload, isError: res.isError === true };
}

describe('server over MCP', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });

  afterEach(async () => {
    await h.close();
  });

  it('lists every tool with model-facing descriptions', async () => {
    const { tools } = await h.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ['account_set', 'accounts_list', 'accounts_usage', 'delegate', 'job_cancel', 'job_result', 'job_wait', 'jobs_list', 'link_help', 'set_strategy'].sort(),
    );
    const delegate = tools.find((t) => t.name === 'delegate');
    expect(delegate?.description).toMatch(/self-contained/i);
    expect(delegate?.description).toMatch(/no memory/i);
    expect(delegate?.description).toMatch(/`cwd`/);
    expect(delegate?.description).toMatch(/wait: false/);
    expect(delegate?.description).toMatch(/job_wait/);
    const schema = delegate?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    expect(schema.required).toEqual(['task']);
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining(['task', 'cwd', 'provider', 'account', 'permission', 'model', 'max_turns', 'system_prompt', 'wait', 'timeout_sec', 'wait_sec']),
    );
    const props = schema.properties as Record<string, { description?: string }>;
    expect(props.timeout_sec?.description).toMatch(/killed/);
    expect(props.wait_sec?.description).toMatch(/never kills/i);
    expect(delegate?.description).toMatch(/wait_sec/);
  });

  it('delegate with wait:true runs the task and returns the documented payload', async () => {
    const { payload, isError } = await call(h.client, 'delegate', { task: 'add a README', cwd: h.home, permission: 'read-only', model: 'fast' });
    expect(isError).toBe(false);
    expect(payload.status).toBe('done');
    expect(payload.job_id).toMatch(/^job_/);
    expect(payload.provider).toBe('claude');
    expect(payload.account).toBe('work');
    expect(payload.output).toBe('claude worker output for work: add a README');
    expect(payload.usage).toEqual({ input: 10, output: 5, cached: 2, total: 15 });
    expect(payload.attempts).toHaveLength(1);
    expect(payload.attempts[0]).toMatchObject({ accountId: 'work', provider: 'claude' });
    expect(typeof payload.duration_ms).toBe('number');
    expect(h.claude.calls).toHaveLength(1);
    expect(h.claude.calls[0]?.req).toMatchObject({ prompt: 'add a README', cwd: h.home, permission: 'read-only', model: 'fast', timeoutSec: 1800 });
    expect(h.codex.calls).toHaveLength(0);
    const ledger = await fs.readFile(h.paths.ledger, 'utf8');
    expect(ledger.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(ledger.trim())).toMatchObject({ account: 'work', total: 15, ok: true });
  });

  it('delegate routes to a specific provider and account', async () => {
    const { payload } = await call(h.client, 'delegate', { task: 'x', cwd: h.home, provider: 'codex' });
    expect(payload.provider).toBe('codex');
    expect(payload.account).toBe('team');
    const forced = await call(h.client, 'delegate', { task: 'y', cwd: h.home, account: 'team' });
    expect(forced.payload.account).toBe('team');
    const mismatch = await call(h.client, 'delegate', { task: 'y', cwd: h.home, account: 'team', provider: 'claude' });
    expect(mismatch.isError).toBe(true);
    expect(mismatch.payload.error).toMatch(/codex account, not claude/);
  });

  it('delegate with wait:false returns queued and job_wait collects the result', async () => {
    h.claude.behaviour.delayMs = 120;
    const queued = await call(h.client, 'delegate', { task: 'slow task', cwd: h.home, wait: false });
    expect(queued.payload).toMatchObject({ status: 'queued', hint: expect.stringContaining('job_wait') });
    const id = queued.payload.job_id as string;
    const listed = await call(h.client, 'jobs_list');
    expect(listed.payload.jobs).toHaveLength(1);
    expect(listed.payload.jobs[0]).toMatchObject({ job_id: id, task: 'slow task', cwd: h.home });
    const waited = await call(h.client, 'job_wait', { job_id: id, timeout_sec: 5 });
    expect(waited.payload).toMatchObject({ job_id: id, status: 'done', account: 'work', provider: 'claude' });
    expect(waited.payload.output).toContain('slow task');
    const result = await call(h.client, 'job_result', { job_id: id });
    expect(result.payload).toEqual(waited.payload);
  });

  it('delegate returns a running snapshot when wait_sec elapses and keeps the job alive', async () => {
    h.claude.behaviour.delayMs = 300;
    h.claude.behaviour.events = ['reading files', 'editing src/a.ts'];
    const running = await call(h.client, 'delegate', { task: 'long', cwd: h.home, wait_sec: 0.05, timeout_sec: 5 });
    expect(running.payload).toMatchObject({ status: 'running', hint: 'call job_wait', last_event: 'editing src/a.ts' });
    const id = running.payload.job_id as string;
    const again = await call(h.client, 'job_wait', { job_id: id, timeout_sec: 0.02 });
    expect(again.payload.status).toBe('running');
    const done = await call(h.client, 'job_wait', { job_id: id, timeout_sec: 5 });
    expect(done.payload.status).toBe('done');
    expect(h.claude.calls).toHaveLength(1);
    expect(h.claude.calls[0]?.req.timeoutSec).toBe(5);
  });

  it('timeout_sec kills the worker even when nobody is waiting', async () => {
    h.claude.behaviour.delayMs = 1500;
    const running = await call(h.client, 'delegate', { task: 'long', cwd: h.home, wait_sec: 0.05, timeout_sec: 0.5 });
    expect(running.payload.status).toBe('running');
    const done = await call(h.client, 'job_wait', { job_id: running.payload.job_id as string, timeout_sec: 5 });
    expect(done.payload.status).toBe('failed');
    expect(done.payload.error).toBe('timeout after 1s');
  });

  it('rejects a cwd that does not exist before submitting a job', async () => {
    const missing = await call(h.client, 'delegate', { task: 'x', cwd: path.join(h.home, 'nope') });
    expect(missing.isError).toBe(true);
    expect(missing.payload.error).toMatch(/does not exist/);
    const file = path.join(h.home, 'file.txt');
    await fs.writeFile(file, 'x');
    const notDir = await call(h.client, 'delegate', { task: 'x', cwd: file });
    expect(notDir.isError).toBe(true);
    expect(notDir.payload.error).toMatch(/not a directory/);
    expect(h.claude.calls).toHaveLength(0);
    expect((await call(h.client, 'jobs_list')).payload.jobs).toHaveLength(0);
    await expect(fs.stat(h.paths.ledger)).rejects.toThrow();
  });

  it('job_cancel aborts a running job', async () => {
    h.claude.behaviour.delayMs = 5000;
    const queued = await call(h.client, 'delegate', { task: 'forever', cwd: h.home, wait: false });
    const id = queued.payload.job_id as string;
    const cancelled = await call(h.client, 'job_cancel', { job_id: id });
    expect(cancelled.payload).toMatchObject({ job_id: id, cancelled: true, status: 'cancelled' });
    const done = await call(h.client, 'job_wait', { job_id: id, timeout_sec: 5 });
    expect(done.payload.status).toBe('cancelled');
    const twice = await call(h.client, 'job_cancel', { job_id: id });
    expect(twice.payload.cancelled).toBe(false);
  });

  it('reports failed jobs with the router error', async () => {
    h.claude.behaviour.throwError = new Error('spawn claude ENOENT');
    const { payload, isError } = await call(h.client, 'delegate', { task: 'boom', cwd: h.home, provider: 'claude' });
    expect(isError).toBe(false);
    expect(payload.status).toBe('failed');
    expect(payload.error).toContain('ENOENT');
    expect(payload.attempts).toHaveLength(1);
  });

  it('rejects bad input with isError payloads', async () => {
    const relative = await call(h.client, 'delegate', { task: 'x', cwd: 'relative/dir' });
    expect(relative.isError).toBe(true);
    expect(relative.payload.error).toMatch(/absolute/);
    const unknown = await call(h.client, 'job_result', { job_id: 'job_nope' });
    expect(unknown.isError).toBe(true);
    const missing = await call(h.client, 'job_wait', { job_id: 'job_nope' });
    expect(missing.isError).toBe(true);
    const noAccount = await call(h.client, 'account_set', { account: 'ghost', enabled: false });
    expect(noAccount.isError).toBe(true);
    expect(noAccount.payload.error).toMatch(/unknown account/);
  });

  it('accounts_list and accounts_usage reflect the ledger', async () => {
    const before = await call(h.client, 'accounts_list');
    expect(before.payload.accounts).toHaveLength(2);
    expect(before.payload.accounts[0]).toMatchObject({
      id: 'work',
      provider: 'claude',
      enabled: true,
      weight: 1,
      budget: {},
      utilization: 0,
      window_5h: { tokens: 0, runs: 0, costUsd: 0 },
      window_7d: { tokens: 0, runs: 0, costUsd: 0 },
    });
    await call(h.client, 'delegate', { task: 'x', cwd: h.home });
    const after = await call(h.client, 'accounts_list');
    const work = after.payload.accounts.find((a: ToolPayload) => a.id === 'work');
    expect(work.window_5h).toEqual({ tokens: 15, runs: 1, costUsd: 0 });
    expect(work.window_7d.tokens).toBe(15);
    expect(work.utilization).toBe(15);
    expect(typeof work.last_used_at).toBe('number');
    const usage = await call(h.client, 'accounts_usage');
    expect(usage.payload.strategy).toBe('priority');
    expect(usage.payload.totals.claude).toMatchObject({ accounts: 1, enabled: 1, cooling_down: 0, window_5h: { tokens: 15, runs: 1 } });
    expect(usage.payload.totals.codex).toMatchObject({ accounts: 1, window_5h: { tokens: 0, runs: 0 } });
  });

  it('account_set persists changes to config.json', async () => {
    const { payload, isError } = await call(h.client, 'account_set', { account: 'work', enabled: false, weight: 2.5, tokens_5h: 1000, tokens_7d: 5000, model: 'opus' });
    expect(isError).toBe(false);
    expect(payload.account).toMatchObject({ id: 'work', enabled: false, weight: 2.5, budget: { tokens5h: 1000, tokens7d: 5000 }, model: 'opus' });
    const saved = await loadConfig(h.paths);
    expect(saved.accounts.find((a) => a.id === 'work')).toMatchObject({ enabled: false, weight: 2.5, budget: { tokens5h: 1000, tokens7d: 5000 }, model: 'opus' });
    const cleared = await call(h.client, 'account_set', { account: 'work', tokens_5h: 0, model: '' });
    expect(cleared.payload.account.budget).toEqual({ tokens7d: 5000 });
    expect(cleared.payload.account.model).toBeUndefined();
    const routed = await call(h.client, 'delegate', { task: 'x', cwd: h.home, provider: 'claude' });
    expect(routed.payload.status).toBe('failed');
    expect(routed.payload.error).toMatch(/disabled/);
  });

  it('set_strategy updates the routing strategy', async () => {
    const { payload } = await call(h.client, 'set_strategy', { strategy: 'round-robin' });
    expect(payload).toEqual({ strategy: 'round-robin', previous: 'priority' });
    expect((await loadConfig(h.paths)).strategy).toBe('round-robin');
    const usage = await call(h.client, 'accounts_usage');
    expect(usage.payload.strategy).toBe('round-robin');
    await expect(h.client.callTool({ name: 'set_strategy', arguments: { strategy: 'random' } })).resolves.toMatchObject({ isError: true });
  });

  it('link_help returns terminal commands and the interactive note', async () => {
    const { payload } = await call(h.client, 'link_help');
    expect(payload.note).toMatch(/terminal/);
    expect(payload.commands.join('\n')).toContain('subpool link claude <id>');
    expect(payload.commands.join('\n')).toContain('subpool link codex <id> --device-auth');
    expect(payload.commands.join('\n')).toContain('--token');
  });

  it('exposes subpool://accounts and subpool://usage resources', async () => {
    const { resources } = await h.client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual([RESOURCE_ACCOUNTS, RESOURCE_USAGE].sort());
    const accounts = await h.client.readResource({ uri: RESOURCE_ACCOUNTS });
    const first = accounts.contents[0] as { uri: string; mimeType?: string; text?: string };
    expect(first.uri).toBe(RESOURCE_ACCOUNTS);
    expect(first.mimeType).toBe('application/json');
    const parsed = JSON.parse(first.text ?? '') as ToolPayload;
    expect(parsed.accounts.map((a: ToolPayload) => a.id)).toEqual(['work', 'team']);
    const usage = await h.client.readResource({ uri: RESOURCE_USAGE });
    const usageDoc = JSON.parse((usage.contents[0] as { text?: string }).text ?? '') as ToolPayload;
    expect(usageDoc.totals.claude.accounts).toBe(1);
    expect(usageDoc.totals.codex.accounts).toBe(1);
  });
});

describe('progress notifications', () => {
  it('sends notifications/progress while waiting when the client passes a progressToken', async () => {
    const h = await harness({ progressIntervalMs: 20 });
    try {
      h.claude.behaviour.delayMs = 150;
      h.claude.behaviour.events = ['step one'];
      const seen: Array<{ progress: number; message?: string }> = [];
      const { payload } = await call(h.client, 'delegate', { task: 'x', cwd: h.home, timeout_sec: 5 }, { onprogress: (p) => seen.push(p) });
      expect(payload.status).toBe('done');
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]?.message).toBe('step one');
      expect(typeof seen[0]?.progress).toBe('number');
    } finally {
      await h.close();
    }
  });

  it('waitJob falls back to a single wait without a token and honours the deadline', async () => {
    const h = await harness();
    try {
      h.claude.behaviour.delayMs = 200;
      const job = h.jobs.submit({ prompt: 'p', cwd: h.home, permission: 'edit', timeoutSec: 5 }, {});
      const sent: unknown[] = [];
      const sink = { sendNotification: async (n: unknown) => void sent.push(n) };
      const snapshot = await waitJob(h.jobs, job.id, 30, sink);
      expect(snapshot.status).toBe('running');
      expect(sent).toHaveLength(0);
      const withToken = await waitJob(h.jobs, job.id, 60, { ...sink, _meta: { progressToken: 'tok' } }, undefined, 10);
      expect(withToken.status).toBe('running');
      expect(sent.length).toBeGreaterThan(0);
      expect(sent[0]).toMatchObject({ method: 'notifications/progress', params: { progressToken: 'tok' } });
      const done = await waitJob(h.jobs, job.id, 5000, sink);
      expect(done.status).toBe('done');
    } finally {
      await h.close();
    }
  });
});

describe('pure helpers', () => {
  const account: Account = {
    id: 'a',
    provider: 'claude',
    profileDir: '/p',
    weight: 1,
    budget: { tokens5h: 10, tokens7d: 20 },
    enabled: true,
    auth: 'profile',
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('applyAccountSet updates, clears and never mutates the input', () => {
    const next = applyAccountSet(account, { account: 'a', enabled: false, weight: 3, tokens_5h: 0, tokens_7d: 99.9, model: ' m ' });
    expect(next).toMatchObject({ enabled: false, weight: 3, budget: { tokens7d: 99 }, model: 'm' });
    expect(next.budget.tokens5h).toBeUndefined();
    expect(account.budget).toEqual({ tokens5h: 10, tokens7d: 20 });
    expect(account.enabled).toBe(true);
    const cleared = applyAccountSet({ ...next }, { account: 'a', model: '' });
    expect(cleared.model).toBeUndefined();
  });

  it('delegateRequest applies config defaults, decouples wait_sec from timeout_sec and validates cwd', async () => {
    const config: Config = { ...defaultConfig(), defaults: { permission: 'read-only', timeoutSec: 42, maxAttempts: 1, cooldownSec: 1 } };
    const { req, opts, waitMs, wait } = delegateRequest({ task: '  do it  ' }, config);
    expect(req).toEqual({ prompt: 'do it', cwd: process.cwd(), permission: 'read-only', timeoutSec: 42 });
    expect(opts).toEqual({});
    expect(waitMs).toBe(DEFAULT_JOB_WAIT_SEC * 1000);
    expect(wait).toBe(true);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'subpool-delegate-'));
    try {
      const full = delegateRequest(
        {
          task: 't',
          cwd: path.join(dir, 'sub', '..'),
          provider: 'codex',
          account: 'x',
          permission: 'full',
          model: 'm',
          max_turns: 3,
          system_prompt: 's',
          wait: false,
          timeout_sec: 0.5,
          wait_sec: 0.25,
        },
        config,
      );
      expect(full.req).toEqual({ prompt: 't', cwd: dir, permission: 'full', timeoutSec: 1, model: 'm', maxTurns: 3, systemPrompt: 's' });
      expect(full.opts).toEqual({ provider: 'codex', account: 'x' });
      expect(full.waitMs).toBe(250);
      expect(full.wait).toBe(false);
      const capped = delegateRequest({ task: 't', cwd: dir, timeout_sec: 3_000_000, wait_sec: 3_000_000 }, config);
      expect(capped.req.timeoutSec).toBe(86_400);
      expect(capped.waitMs).toBe(86_400_000);
      expect(() => delegateRequest({ task: 't', cwd: path.join(dir, 'missing') }, config)).toThrow(/does not exist/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
    expect(() => delegateRequest({ task: '   ' }, config)).toThrow(/empty/);
    expect(() => delegateRequest({ task: 't', cwd: 'rel' }, config)).toThrow(/absolute/);
  });

  it('withDeadline reports whether the promise settled in time and clears its timer', async () => {
    expect(await withDeadline(Promise.resolve(), 1000)).toBe(true);
    const slow = new Promise<void>((resolve) => setTimeout(resolve, 200));
    const started = Date.now();
    expect(await withDeadline(slow, 20)).toBe(false);
    expect(Date.now() - started).toBeLessThan(150);
    await slow;
  });

  it('jobPayload and taskPreview shape output for the model', () => {
    const job: Job = {
      id: 'job_1',
      status: 'done',
      createdAt: 1000,
      startedAt: 1100,
      finishedAt: 1500,
      request: { prompt: 'p', cwd: '/c', permission: 'edit', timeoutSec: 1 },
      options: {},
      provider: 'codex',
      accountId: 'team',
      attempts: [{ accountId: 'team', provider: 'codex', durationMs: 5 }],
      events: [{ type: 'message', at: 1, text: 'hi' }],
      result: { ok: true, output: 'out', usage: { input: 1, output: 1, cached: 0, total: 2 }, provider: 'codex', accountId: 'team', durationMs: 5, exitCode: 0, attempts: [] },
    };
    expect(jobPayload(job, 2000)).toEqual({
      job_id: 'job_1',
      status: 'done',
      provider: 'codex',
      account: 'team',
      output: 'out',
      usage: { input: 1, output: 1, cached: 0, total: 2 },
      attempts: [{ accountId: 'team', provider: 'codex', durationMs: 5 }],
      duration_ms: 5,
    });
    const running: Job = { ...job, status: 'running', result: undefined, finishedAt: undefined };
    expect(jobPayload(running, 1400).duration_ms).toBe(300);
    expect(taskPreview('  many\n\nlines   here ')).toBe('many lines here');
    expect(taskPreview('x'.repeat(200), 10)).toHaveLength(10);
  });

  it('usagePayload totals per provider and counts cooldowns', () => {
    const config: Config = { ...defaultConfig(), accounts: [account, { ...account, id: 'b', provider: 'codex', enabled: false }] };
    const payload = usagePayload(
      config,
      [
        { accountId: 'a', provider: 'claude', enabled: true, window5h: { tokens: 5, runs: 1, costUsd: 0.1 }, window7d: { tokens: 7, runs: 2, costUsd: 0.2 }, utilization: 0.5, cooldownUntil: 5000, cooldownReason: 'limit' },
        { accountId: 'b', provider: 'codex', enabled: false, window5h: { tokens: 1, runs: 1, costUsd: 0 }, window7d: { tokens: 1, runs: 1, costUsd: 0 }, utilization: 0.05 },
      ],
      1000,
    );
    expect(payload.totals.claude).toEqual({ accounts: 1, enabled: 1, cooling_down: 1, window_5h: { tokens: 5, runs: 1, costUsd: 0.1 }, window_7d: { tokens: 7, runs: 2, costUsd: 0.2 } });
    expect(payload.totals.codex).toMatchObject({ accounts: 1, enabled: 0, cooling_down: 0 });
    expect(payload.accounts[0]).toMatchObject({ cooldown_until: 5000, cooldown_reason: 'limit', utilization: 0.5 });
    expect(linkHelpPayload().commands.length).toBeGreaterThan(3);
  });
});
