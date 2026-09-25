export type ProviderId = 'claude' | 'codex';

export type Permission = 'read-only' | 'edit' | 'full';

export type Strategy = 'least-used' | 'round-robin' | 'weighted' | 'priority';

export type AuthMode = 'profile' | 'token';

export interface AccountBudget {
  tokens5h?: number;
  tokens7d?: number;
}

export interface Account {
  id: string;
  provider: ProviderId;
  profileDir: string;
  weight: number;
  budget: AccountBudget;
  enabled: boolean;
  auth: AuthMode;
  model?: string;
  createdAt: string;
}

export interface Defaults {
  permission: Permission;
  timeoutSec: number;
  maxAttempts: number;
  cooldownSec: number;
}

export interface Config {
  version: 1;
  strategy: Strategy;
  defaults: Defaults;
  accounts: Account[];
}

export interface Usage {
  input: number;
  output: number;
  cached: number;
  total: number;
  costUsd?: number;
}

export type LimitKind = 'rate' | 'auth' | 'overloaded';

export interface Limit {
  kind: LimitKind;
  resetAt?: number;
  message: string;
}

export interface RunRequest {
  prompt: string;
  cwd: string;
  permission: Permission;
  timeoutSec: number;
  model?: string;
  maxTurns?: number;
  systemPrompt?: string;
  signal?: AbortSignal;
}

export type RunEventType = 'start' | 'message' | 'tool' | 'text' | 'stderr' | 'end';

export interface RunEvent {
  type: RunEventType;
  at: number;
  text?: string;
}

export interface RunResult {
  ok: boolean;
  output: string;
  usage: Usage;
  provider: ProviderId;
  accountId: string;
  sessionId?: string;
  durationMs: number;
  exitCode: number | null;
  error?: string;
  limit?: Limit;
}

export interface AuthStatus {
  loggedIn: boolean;
  detail?: string;
}

export interface LoginOptions {
  token?: string;
  deviceAuth?: boolean;
}

export interface ProviderAdapter {
  id: ProviderId;
  binary: string;
  login(profileDir: string, opts: LoginOptions): Promise<void>;
  status(profileDir: string): Promise<AuthStatus>;
  run(req: RunRequest, account: Account, onEvent?: (e: RunEvent) => void): Promise<RunResult>;
}

export interface LedgerEntry {
  t: number;
  account: string;
  provider: ProviderId;
  input: number;
  output: number;
  cached: number;
  total: number;
  costUsd?: number;
  ok: boolean;
  limited?: LimitKind;
  durationMs: number;
}

export interface WindowUsage {
  tokens: number;
  runs: number;
  costUsd: number;
}

export interface AccountUsage {
  accountId: string;
  provider: ProviderId;
  enabled: boolean;
  window5h: WindowUsage;
  window7d: WindowUsage;
  lastUsedAt?: number;
  cooldownUntil?: number;
  cooldownReason?: string;
  utilization: number;
}

export interface Cooldown {
  until: number;
  reason: string;
}

export interface State {
  cooldowns: Record<string, Cooldown>;
  rrCursor: number;
  lastUsed: Record<string, number>;
}

export interface SelectOptions {
  provider?: ProviderId | 'any';
  account?: string;
  exclude?: string[];
}

export interface Attempt {
  accountId: string;
  provider: ProviderId;
  limit?: Limit;
  error?: string;
  durationMs: number;
}

export interface RoutedResult extends RunResult {
  attempts: Attempt[];
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  request: Omit<RunRequest, 'signal'>;
  options: SelectOptions;
  provider?: ProviderId;
  accountId?: string;
  attempts: Attempt[];
  events: RunEvent[];
  result?: RoutedResult;
  error?: string;
}

export const WINDOW_5H_MS = 5 * 60 * 60 * 1000;
export const WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1000;
export const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
