import { readFileSync } from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult, ServerNotification } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Paths } from './core/paths.js';
import { ensureDirs, resolvePaths } from './core/paths.js';
import type {
  Account,
  AccountUsage,
  Attempt,
  Config,
  Job,
  JobStatus,
  Permission,
  ProviderAdapter,
  ProviderId,
  RunRequest,
  SelectOptions,
  Strategy,
  Usage,
  WindowUsage,
} from './core/types.js';
import { Ledger } from './core/ledger.js';
import { Router } from './core/router.js';
import { JobManager, isTerminal, pruneJobs } from './core/jobs.js';
import { MAX_TIMEOUT_SEC, getAccount, loadConfig, saveConfig, upsertAccount } from './core/config.js';
import { assertDirectory } from './core/exec.js';
import { providers as defaultProviders } from './providers/index.js';

export const SERVER_NAME = 'subpool';
export const PROGRESS_INTERVAL_MS = 10_000;
export const DEFAULT_JOB_WAIT_SEC = 300;
export const DRAIN_TIMEOUT_MS = 10_000;
export const TASK_PREVIEW_CHARS = 120;
export const RESOURCE_ACCOUNTS = 'subpool://accounts';
export const RESOURCE_USAGE = 'subpool://usage';

export interface ServerDeps {
  paths: Paths;
  ledger: Ledger;
  jobs: JobManager;
  loadConfig: () => Promise<Config>;
  saveConfig: (c: Config) => Promise<void>;
  providers: Record<ProviderId, ProviderAdapter>;
  now?: () => number;
  progressIntervalMs?: number;
}

export interface JobPayload {
  job_id: string;
  status: JobStatus;
  provider?: ProviderId;
  account?: string;
  output: string;
  usage?: Usage;
  attempts: Attempt[];
  duration_ms: number;
  error?: string;
}

export interface RunningPayload {
  job_id: string;
  status: 'running' | 'queued';
  hint: string;
  elapsed_ms: number;
  last_event?: string;
}

export interface QueuedPayload {
  job_id: string;
  status: 'queued';
  hint: string;
}

export interface JobSummary {
  job_id: string;
  status: JobStatus;
  provider?: ProviderId;
  account?: string;
  created_at: number;
  started_at?: number;
  finished_at?: number;
  cwd: string;
  task: string;
  error?: string;
}

export interface AccountPayload {
  id: string;
  provider: ProviderId;
  enabled: boolean;
  auth: Account['auth'];
  model?: string;
  weight: number;
  budget: Account['budget'];
  utilization: number;
  window_5h: WindowUsage;
  window_7d: WindowUsage;
  last_used_at?: number;
  cooldown_until?: number;
  cooldown_reason?: string;
  profile_dir: string;
}

export interface ProviderTotals {
  accounts: number;
  enabled: number;
  cooling_down: number;
  window_5h: WindowUsage;
  window_7d: WindowUsage;
}

export interface UsagePayload {
  strategy: Strategy;
  accounts: AccountPayload[];
  totals: Record<ProviderId, ProviderTotals>;
}

export interface AccountSetInput {
  account: string;
  enabled?: boolean;
  weight?: number;
  tokens_5h?: number;
  tokens_7d?: number;
  model?: string;
}

export interface DelegateInput {
  task: string;
  cwd?: string;
  provider?: ProviderId | 'any';
  account?: string;
  permission?: Permission;
  model?: string;
  max_turns?: number;
  system_prompt?: string;
  wait?: boolean;
  timeout_sec?: number;
  wait_sec?: number;
}

export interface ProgressSink {
  _meta?: { progressToken?: string | number };
  signal?: AbortSignal;
  sendNotification: (notification: ServerNotification) => Promise<void>;
}

export function readVersion(): string {
  try {
    const raw = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof raw.version === 'string' ? raw.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function textResult(payload: unknown, isError = false): CallToolResult {
  const result: CallToolResult = { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  if (isError) result.isError = true;
  return result;
}

export function errorResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return textResult({ error: message }, true);
}

export function jobDuration(job: Job, now: number): number {
  if (job.result) return job.result.durationMs;
  const start = job.startedAt ?? job.createdAt;
  return Math.max(0, (job.finishedAt ?? now) - start);
}

export function lastEventText(job: Job): string | undefined {
  for (let i = job.events.length - 1; i >= 0; i--) {
    const text = job.events[i]?.text;
    if (text && text.trim().length > 0) return text.trim();
  }
  return undefined;
}

export function jobPayload(job: Job, now: number): JobPayload {
  const payload: JobPayload = {
    job_id: job.id,
    status: job.status,
    output: job.result?.output ?? '',
    attempts: job.attempts,
    duration_ms: jobDuration(job, now),
  };
  if (job.provider) payload.provider = job.provider;
  if (job.accountId) payload.account = job.accountId;
  if (job.result) payload.usage = job.result.usage;
  if (job.error) payload.error = job.error;
  return payload;
}

export function runningPayload(job: Job, now: number): RunningPayload {
  const payload: RunningPayload = {
    job_id: job.id,
    status: job.status === 'queued' ? 'queued' : 'running',
    hint: 'call job_wait',
    elapsed_ms: jobDuration(job, now),
  };
  const last = lastEventText(job);
  if (last) payload.last_event = last;
  return payload;
}

export function queuedPayload(job: Job): QueuedPayload {
  return { job_id: job.id, status: 'queued', hint: 'call job_wait with this job_id to collect the result' };
}

export function waitPayload(job: Job, now: number): JobPayload | RunningPayload {
  return isTerminal(job.status) ? jobPayload(job, now) : runningPayload(job, now);
}

export function taskPreview(task: string, max: number = TASK_PREVIEW_CHARS): string {
  const line = task.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function jobSummary(job: Job): JobSummary {
  const summary: JobSummary = {
    job_id: job.id,
    status: job.status,
    created_at: job.createdAt,
    cwd: job.request.cwd,
    task: taskPreview(job.request.prompt),
  };
  if (job.provider) summary.provider = job.provider;
  if (job.accountId) summary.account = job.accountId;
  if (job.startedAt !== undefined) summary.started_at = job.startedAt;
  if (job.finishedAt !== undefined) summary.finished_at = job.finishedAt;
  if (job.error) summary.error = job.error;
  return summary;
}

function copyWindow(w: WindowUsage): WindowUsage {
  return { tokens: w.tokens, runs: w.runs, costUsd: w.costUsd };
}

function emptyWindow(): WindowUsage {
  return { tokens: 0, runs: 0, costUsd: 0 };
}

export function accountPayload(account: Account, usage: AccountUsage | undefined): AccountPayload {
  const payload: AccountPayload = {
    id: account.id,
    provider: account.provider,
    enabled: account.enabled,
    auth: account.auth,
    weight: account.weight,
    budget: { ...account.budget },
    utilization: usage?.utilization ?? 0,
    window_5h: usage ? copyWindow(usage.window5h) : emptyWindow(),
    window_7d: usage ? copyWindow(usage.window7d) : emptyWindow(),
    profile_dir: account.profileDir,
  };
  if (account.model) payload.model = account.model;
  if (usage?.lastUsedAt !== undefined) payload.last_used_at = usage.lastUsedAt;
  if (usage?.cooldownUntil !== undefined) {
    payload.cooldown_until = usage.cooldownUntil;
    payload.cooldown_reason = usage.cooldownReason ?? '';
  }
  return payload;
}

export function accountsPayload(config: Config, usages: AccountUsage[]): AccountPayload[] {
  const byId = new Map(usages.map((u) => [u.accountId, u]));
  return config.accounts.map((a) => accountPayload(a, byId.get(a.id)));
}

function addWindow(target: WindowUsage, source: WindowUsage): void {
  target.tokens += source.tokens;
  target.runs += source.runs;
  target.costUsd += source.costUsd;
}

export function usagePayload(config: Config, usages: AccountUsage[], now: number): UsagePayload {
  const accounts = accountsPayload(config, usages);
  const totals: Record<ProviderId, ProviderTotals> = {
    claude: { accounts: 0, enabled: 0, cooling_down: 0, window_5h: emptyWindow(), window_7d: emptyWindow() },
    codex: { accounts: 0, enabled: 0, cooling_down: 0, window_5h: emptyWindow(), window_7d: emptyWindow() },
  };
  for (const a of accounts) {
    const t = totals[a.provider];
    t.accounts += 1;
    if (a.enabled) t.enabled += 1;
    if (a.cooldown_until !== undefined && a.cooldown_until > now) t.cooling_down += 1;
    addWindow(t.window_5h, a.window_5h);
    addWindow(t.window_7d, a.window_7d);
  }
  return { strategy: config.strategy, accounts, totals };
}

export function applyAccountSet(account: Account, input: AccountSetInput): Account {
  const next: Account = { ...account, budget: { ...account.budget } };
  if (input.enabled !== undefined) next.enabled = input.enabled;
  if (input.weight !== undefined) next.weight = input.weight;
  if (input.tokens_5h !== undefined) {
    if (input.tokens_5h > 0) next.budget.tokens5h = Math.floor(input.tokens_5h);
    else delete next.budget.tokens5h;
  }
  if (input.tokens_7d !== undefined) {
    if (input.tokens_7d > 0) next.budget.tokens7d = Math.floor(input.tokens_7d);
    else delete next.budget.tokens7d;
  }
  if (input.model !== undefined) {
    const model = input.model.trim();
    if (model.length > 0) next.model = model;
    else delete next.model;
  }
  return next;
}

export function delegateRequest(
  input: DelegateInput,
  config: Config,
): { req: Omit<RunRequest, 'signal'>; opts: SelectOptions; waitMs: number; wait: boolean } {
  const task = input.task.trim();
  if (task.length === 0) throw new Error('task must not be empty');
  const rawCwd = input.cwd === undefined || input.cwd.trim().length === 0 ? process.cwd() : input.cwd;
  if (!path.isAbsolute(rawCwd)) throw new Error(`cwd must be an absolute path, got "${rawCwd}"`);
  const cwd = path.resolve(rawCwd);
  assertDirectory(cwd);
  const timeoutSec = Math.min(input.timeout_sec ?? config.defaults.timeoutSec, MAX_TIMEOUT_SEC);
  const waitSec = Math.min(input.wait_sec ?? DEFAULT_JOB_WAIT_SEC, MAX_TIMEOUT_SEC);
  const req: Omit<RunRequest, 'signal'> = {
    prompt: task,
    cwd,
    permission: input.permission ?? config.defaults.permission,
    timeoutSec: Math.max(1, Math.ceil(timeoutSec)),
  };
  if (input.model !== undefined && input.model.trim().length > 0) req.model = input.model.trim();
  if (input.max_turns !== undefined) req.maxTurns = input.max_turns;
  if (input.system_prompt !== undefined && input.system_prompt.length > 0) req.systemPrompt = input.system_prompt;
  const opts: SelectOptions = {};
  if (input.provider !== undefined) opts.provider = input.provider;
  if (input.account !== undefined && input.account.length > 0) {
    opts.account = input.account;
    const found = getAccount(config, input.account);
    if (found && input.provider !== undefined && input.provider !== 'any' && found.provider !== input.provider) {
      throw new Error(`account "${input.account}" is a ${found.provider} account, not ${input.provider}`);
    }
  }
  return { req, opts, waitMs: waitSec * 1000, wait: input.wait ?? true };
}

export async function withDeadline(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, ms));
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function waitJob(
  jobs: JobManager,
  id: string,
  timeoutMs: number,
  extra: ProgressSink,
  now: () => number = () => Date.now(),
  intervalMs: number = PROGRESS_INTERVAL_MS,
): Promise<Job> {
  const token = extra._meta?.progressToken;
  const started = now();
  const deadline = started + Math.max(0, timeoutMs);
  if (token === undefined) return jobs.wait(id, timeoutMs);
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0 || extra.signal?.aborted) {
      const current = jobs.get(id);
      if (!current) throw new Error(`unknown job ${id}`);
      return current;
    }
    const job = await jobs.wait(id, Math.min(Math.max(1, intervalMs), remaining));
    if (isTerminal(job.status) || now() >= deadline || extra.signal?.aborted) return job;
    const elapsed = Math.round((now() - started) / 1000);
    const message = lastEventText(job) ?? `${job.status} on ${job.accountId ?? 'pending account'}`;
    await extra
      .sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: elapsed, message } })
      .catch(() => undefined);
  }
}

export function linkHelpPayload(): { note: string; commands: string[]; after: string[] } {
  return {
    note:
      'Linking is interactive (browser or device-code login) and must be done by the user in a terminal, not through this tool. Each account gets its own isolated profile under SUBPOOL_HOME/profiles, so existing ~/.claude and ~/.codex logins are untouched.',
    commands: [
      'subpool link claude <id>                 # Claude Code subscription: opens the Claude login in a browser',
      'subpool link claude <id> --token         # headless: paste a long-lived token from `claude setup-token`',
      'subpool link codex <id>                  # ChatGPT/Codex subscription: opens the ChatGPT login in a browser',
      'subpool link codex <id> --device-auth    # headless: device-code login',
      'subpool link <claude|codex> <id> --weight 2 --tokens-5h 400000 --tokens-7d 2500000 --model <name>',
    ],
    after: [
      'subpool ls                   # verify the account is logged in',
      'subpool check <id>           # re-check login state',
      'subpool set <id> --disable   # temporarily remove an account from the pool',
      'subpool strategy <least-used|weighted|round-robin|priority>',
    ],
  };
}

const DELEGATE_DESCRIPTION = [
  'Hand a self-contained coding task to another subscription account (a Claude Code or Codex/ChatGPT subscription linked in subpool). The task runs in a separate headless CLI worker on the account with the most remaining quota and fails over automatically when an account hits its usage limit.',
  'Use it to offload work when your own quota is low, to parallelise independent tasks, or to get a second implementation from a different model.',
  'The worker starts with NO memory of this conversation: put the full context in `task` (goal, relevant file paths, constraints, what "done" looks like, how to verify).',
  'Always pass `cwd` (absolute path of the project the worker should edit). `permission` defaults to the pool default (usually `edit`); use `read-only` for reviews/analysis and `full` only when shell commands with side effects are required.',
  'By default this call waits for the worker (`wait: true`) up to `wait_sec` (default 300); if the job is still running when that elapses you get `{status:"running", hint:"call job_wait"}` and the job keeps going. `timeout_sec` is different: it is the hard run limit after which the worker is killed, whether or not anyone is waiting (default: pool default, usually 1800). For long tasks prefer `wait: false` and then poll with `job_wait`.',
  'The result contains the worker\'s final message in `output`, the `account`/`provider` that ran it, token `usage` and the `attempts` made (including accounts skipped for rate limits).',
].join(' ');

const JOB_WAIT_DESCRIPTION =
  'Wait for a delegated job to finish (up to `timeout_sec`, default 300) and return the same payload as `delegate`: output, account, provider, usage, attempts. If it is still running you get `{status:"running", hint:"call job_wait"}`; call again. Never cancels the job.';

const JOB_RESULT_DESCRIPTION =
  'Return the current snapshot of a delegated job without waiting: status, full output (when finished), account, usage, attempts, error.';

const JOB_CANCEL_DESCRIPTION = 'Cancel a running delegated job (kills the worker CLI). Returns whether anything was cancelled.';

const JOBS_LIST_DESCRIPTION = 'Compact list of delegated jobs in this server session with status, account and a preview of the task.';

const ACCOUNTS_LIST_DESCRIPTION =
  'List the linked subscription accounts with their 5-hour and 7-day token windows, utilization (used/budget, or tokens per weight when no budget is set), cooldown (rate-limited until), enabled flag, provider, model, weight and budget. Use it to see which subscription still has quota before delegating.';

const ACCOUNTS_USAGE_DESCRIPTION =
  'Same per-account numbers as accounts_list plus totals per provider (claude, codex) and the active routing strategy.';

const ACCOUNT_SET_DESCRIPTION =
  'Update one account: enable/disable it, change its weight, set soft budgets for the 5-hour (`tokens_5h`) and 7-day (`tokens_7d`) windows (0 clears a budget), or pin a model (empty string clears it). Returns the updated account.';

const SET_STRATEGY_DESCRIPTION =
  'Choose how the next delegated task picks an account: least-used (lowest utilization first, default), weighted (tokens / weight), round-robin, priority (config order, next one on limit).';

const LINK_HELP_DESCRIPTION =
  'Return the exact shell commands the user must run in a terminal to link another Claude Code or Codex (ChatGPT) subscription account. Linking is interactive (browser/device login) and cannot be done from this tool; show these commands to the user.';

const providerSchema = z.enum(['claude', 'codex', 'any']);
const permissionSchema = z.enum(['read-only', 'edit', 'full']);
const strategySchema = z.enum(['least-used', 'round-robin', 'weighted', 'priority']);

export function createServer(deps: ServerDeps): McpServer {
  const now = deps.now ?? (() => Date.now());
  const intervalMs = deps.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
  const server = new McpServer({ name: SERVER_NAME, version: readVersion() });

  const accountsJson = async (): Promise<AccountPayload[]> => {
    const config = await deps.loadConfig();
    return accountsPayload(config, await deps.ledger.usage(config.accounts));
  };

  const usageJson = async (): Promise<UsagePayload> => {
    const config = await deps.loadConfig();
    return usagePayload(config, await deps.ledger.usage(config.accounts), now());
  };

  server.registerTool(
    'delegate',
    {
      title: 'Delegate a coding task to another subscription',
      description: DELEGATE_DESCRIPTION,
      inputSchema: {
        task: z.string().min(1).describe('Complete, self-contained instructions for the worker. Include all context: it has no memory of this conversation.'),
        cwd: z.string().optional().describe('Absolute path of the working directory for the worker. Defaults to the server process cwd.'),
        provider: providerSchema.optional().describe('Restrict to one provider, or "any" (default).'),
        account: z.string().optional().describe('Force a specific linked account id.'),
        permission: permissionSchema.optional().describe('read-only (no edits/shell), edit (file edits allowed), full (skip all approvals). Default: pool default.'),
        model: z.string().optional().describe('Model name passed to the CLI; overrides the account model.'),
        max_turns: z.number().int().positive().optional().describe('Max agent turns (claude only).'),
        system_prompt: z.string().optional().describe('Extra system prompt appended for the worker (claude only).'),
        wait: z.boolean().optional().describe('Wait for completion (default true). Use false and then job_wait for long tasks.'),
        wait_sec: z.number().positive().max(MAX_TIMEOUT_SEC).optional().describe('Seconds to wait for the result when wait=true before returning a running snapshot (default 300). Never kills the worker.'),
        timeout_sec: z.number().positive().max(MAX_TIMEOUT_SEC).optional().describe('Hard run limit in seconds: the worker is killed when it elapses, regardless of waiting. Default: pool default (1800).'),
      },
      annotations: { title: 'Delegate task', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args, extra) => {
      try {
        const config = await deps.loadConfig();
        const { req, opts, waitMs, wait } = delegateRequest(args, config);
        const job = deps.jobs.submit(req, opts);
        if (!wait) return textResult(queuedPayload(job));
        const done = await waitJob(deps.jobs, job.id, waitMs, extra, now, intervalMs);
        return textResult(waitPayload(done, now()));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'job_wait',
    {
      title: 'Wait for a delegated job',
      description: JOB_WAIT_DESCRIPTION,
      inputSchema: {
        job_id: z.string().min(1),
        timeout_sec: z.number().positive().max(MAX_TIMEOUT_SEC).optional().describe('Seconds to wait before returning a running snapshot. Default 300.'),
      },
      annotations: { title: 'Wait for job', readOnlyHint: true },
    },
    async (args, extra) => {
      try {
        const waitMs = (args.timeout_sec ?? DEFAULT_JOB_WAIT_SEC) * 1000;
        const job = await waitJob(deps.jobs, args.job_id, waitMs, extra, now, intervalMs);
        return textResult(waitPayload(job, now()));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'job_result',
    {
      title: 'Job result',
      description: JOB_RESULT_DESCRIPTION,
      inputSchema: { job_id: z.string().min(1) },
      annotations: { title: 'Job result', readOnlyHint: true },
    },
    async (args) => {
      const job = deps.jobs.get(args.job_id);
      if (!job) return errorResult(new Error(`unknown job ${args.job_id}`));
      return textResult(jobPayload(job, now()));
    },
  );

  server.registerTool(
    'job_cancel',
    {
      title: 'Cancel job',
      description: JOB_CANCEL_DESCRIPTION,
      inputSchema: { job_id: z.string().min(1) },
      annotations: { title: 'Cancel job', destructiveHint: true },
    },
    async (args) => {
      const job = deps.jobs.get(args.job_id);
      if (!job) return errorResult(new Error(`unknown job ${args.job_id}`));
      const cancelled = deps.jobs.cancel(args.job_id);
      const after = deps.jobs.get(args.job_id) ?? job;
      return textResult({ job_id: args.job_id, cancelled, status: after.status });
    },
  );

  server.registerTool(
    'jobs_list',
    {
      title: 'List jobs',
      description: JOBS_LIST_DESCRIPTION,
      inputSchema: {},
      annotations: { title: 'List jobs', readOnlyHint: true },
    },
    async () => textResult({ jobs: deps.jobs.list().map(jobSummary) }),
  );

  server.registerTool(
    'accounts_list',
    {
      title: 'List accounts',
      description: ACCOUNTS_LIST_DESCRIPTION,
      inputSchema: {},
      annotations: { title: 'List accounts', readOnlyHint: true },
    },
    async () => {
      try {
        return textResult({ accounts: await accountsJson() });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'accounts_usage',
    {
      title: 'Usage per account and provider',
      description: ACCOUNTS_USAGE_DESCRIPTION,
      inputSchema: {},
      annotations: { title: 'Usage', readOnlyHint: true },
    },
    async () => {
      try {
        return textResult(await usageJson());
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'account_set',
    {
      title: 'Update an account',
      description: ACCOUNT_SET_DESCRIPTION,
      inputSchema: {
        account: z.string().min(1).describe('Account id as shown by accounts_list.'),
        enabled: z.boolean().optional(),
        weight: z.number().positive().optional().describe('Relative share for weighted/least-used routing (default 1).'),
        tokens_5h: z.number().nonnegative().optional().describe('Soft budget of tokens per rolling 5 hours; 0 clears it.'),
        tokens_7d: z.number().nonnegative().optional().describe('Soft budget of tokens per rolling 7 days; 0 clears it.'),
        model: z.string().optional().describe('Model to pass to the CLI for this account; empty string clears it.'),
      },
      annotations: { title: 'Update account', idempotentHint: true },
    },
    async (args) => {
      try {
        const config = await deps.loadConfig();
        const account = getAccount(config, args.account);
        if (!account) return errorResult(new Error(`unknown account "${args.account}"`));
        const updated = applyAccountSet(account, args);
        await deps.saveConfig(upsertAccount(config, updated));
        const usages = await deps.ledger.usage([updated]);
        return textResult({ account: accountPayload(updated, usages[0]) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'set_strategy',
    {
      title: 'Set routing strategy',
      description: SET_STRATEGY_DESCRIPTION,
      inputSchema: { strategy: strategySchema },
      annotations: { title: 'Set strategy', idempotentHint: true },
    },
    async (args) => {
      try {
        const config = await deps.loadConfig();
        const previous = config.strategy;
        await deps.saveConfig({ ...config, strategy: args.strategy });
        return textResult({ strategy: args.strategy, previous });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'link_help',
    {
      title: 'How to link another account',
      description: LINK_HELP_DESCRIPTION,
      inputSchema: {},
      annotations: { title: 'Link help', readOnlyHint: true },
    },
    async () => textResult(linkHelpPayload()),
  );

  server.registerResource(
    'accounts',
    RESOURCE_ACCOUNTS,
    { title: 'Linked accounts', description: 'Accounts with usage windows, utilization and cooldowns (same as accounts_list).', mimeType: 'application/json' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ accounts: await accountsJson() }, null, 2) }],
    }),
  );

  server.registerResource(
    'usage',
    RESOURCE_USAGE,
    { title: 'Usage', description: 'Per-account usage plus totals per provider (same as accounts_usage).', mimeType: 'application/json' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await usageJson(), null, 2) }],
    }),
  );

  return server;
}

export async function serve(paths: Paths = resolvePaths()): Promise<void> {
  ensureDirs(paths);
  const ledger = new Ledger(paths);
  await ledger.compact();
  await pruneJobs(paths).catch(() => 0);
  const load = (): Promise<Config> => loadConfig(paths);
  const router = new Router({ paths, ledger, providers: defaultProviders, loadConfig: load });
  const jobs = new JobManager(router, paths);
  const server = createServer({
    paths,
    ledger,
    jobs,
    loadConfig: load,
    saveConfig: (c) => saveConfig(paths, c),
    providers: defaultProviders,
  });
  const transport = new StdioServerTransport();
  let closing = false;
  const cancelAll = (): void => {
    for (const job of jobs.list()) {
      if (!isTerminal(job.status)) jobs.cancel(job.id);
    }
  };
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    cancelAll();
    void server.close().catch(() => undefined);
  };
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = () => {
      shutdown();
      resolve();
    };
  });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.stdin.once('end', shutdown);
  process.stdin.once('close', shutdown);
  await server.connect(transport);
  await closed;
  process.off('SIGINT', shutdown);
  process.off('SIGTERM', shutdown);
  process.stdin.off('end', shutdown);
  process.stdin.off('close', shutdown);
  cancelAll();
  await withDeadline(jobs.drain(), DRAIN_TIMEOUT_MS);
  await jobs.flush();
}
