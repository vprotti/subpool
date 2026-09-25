import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  Account,
  AuthStatus,
  Limit,
  LoginOptions,
  Permission,
  ProviderAdapter,
  RunEvent,
  RunRequest,
  RunResult,
  Usage,
} from '../core/types.js';
import { MAX_TIMER_MS, resolveBinary, runInteractive, runProcess, scrubEnv, type ExecResult } from '../core/exec.js';
import { detectLimit } from '../core/limits.js';
import { readText, splitLines, writeFileAtomic } from '../core/fsx.js';

export const CLAUDE_BINARY = 'claude';
export const CLAUDE_READ_ONLY_DISALLOWED = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'];
export const STATUS_TIMEOUT_MS = 30_000;
const TAIL_LINES = 20;
const TAIL_CHARS = 2000;
const TOOL_TEXT_MAX = 300;

export interface ClaudeParsed {
  text: string;
  usage: Usage;
  sessionId?: string;
  isError: boolean;
  subtype?: string;
  apiStatus?: number | null;
  errorText?: string;
  numTurns?: number;
}

type Rec = Record<string, unknown>;

function asRecord(v: unknown): Rec | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cached: 0, total: 0 };
}

export function parseJsonLine(line: string): Rec | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function tailOf(text: string, lines: number = TAIL_LINES, chars: number = TAIL_CHARS): string {
  const kept = text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(-lines)
    .join('\n');
  return kept.length > chars ? kept.slice(kept.length - chars) : kept;
}

export function timeoutMsFor(req: RunRequest): number {
  if (!(req.timeoutSec > 0) || !Number.isFinite(req.timeoutSec)) return 0;
  return Math.min(Math.round(req.timeoutSec * 1000), MAX_TIMER_MS);
}

export function tokenFile(profileDir: string): string {
  return path.join(profileDir, 'token');
}

export async function readProfileToken(profileDir: string): Promise<string | undefined> {
  const raw = await readText(tokenFile(profileDir));
  const token = raw?.trim();
  return token ? token : undefined;
}

export function claudePermissionArgs(permission: Permission): string[] {
  switch (permission) {
    case 'read-only':
      return ['--permission-mode', 'plan', '--disallowedTools', ...CLAUDE_READ_ONLY_DISALLOWED];
    case 'edit':
      return ['--permission-mode', 'acceptEdits'];
    case 'full':
      return ['--dangerously-skip-permissions'];
  }
}

export function claudeArgs(req: RunRequest): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (req.model) args.push('--model', req.model);
  if (req.maxTurns !== undefined && req.maxTurns > 0) args.push('--max-turns', String(Math.floor(req.maxTurns)));
  if (req.systemPrompt) args.push('--append-system-prompt', req.systemPrompt);
  args.push(...claudePermissionArgs(req.permission));
  return args;
}

export function claudeEnv(base: NodeJS.ProcessEnv, profileDir: string, token?: string): NodeJS.ProcessEnv {
  const env = scrubEnv(base, 'claude');
  env.CLAUDE_CONFIG_DIR = profileDir;
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return env;
}

export function claudeUsageFrom(raw: unknown, costUsd?: number): Usage {
  const u = asRecord(raw) ?? {};
  const input = num(u.input_tokens) ?? 0;
  const output = num(u.output_tokens) ?? 0;
  const cacheCreation = num(u.cache_creation_input_tokens) ?? 0;
  const cacheRead = num(u.cache_read_input_tokens) ?? 0;
  const usage: Usage = { input, output, cached: cacheRead, total: input + output + cacheCreation + cacheRead };
  if (costUsd !== undefined) usage.costUsd = costUsd;
  return usage;
}

function contentBlocks(obj: Rec): Rec[] {
  const message = asRecord(obj.message);
  const content = message?.content ?? obj.content;
  if (!Array.isArray(content)) return [];
  return content.map(asRecord).filter((b): b is Rec => b !== undefined);
}

function errorMessageOf(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  const rec = asRecord(v);
  if (!rec) return undefined;
  const message = str(rec.message) ?? str(rec.error);
  if (message) return message;
  const nested = asRecord(rec.error);
  return nested ? str(nested.message) : undefined;
}

export function shortJson(v: unknown, max: number = TOOL_TEXT_MAX): string {
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v) ?? '';
  } catch {
    s = String(v);
  }
  s = oneLine(s);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function claudeEventsFor(line: string, at: number = Date.now()): RunEvent[] {
  const obj = parseJsonLine(line);
  if (!obj || obj.type !== 'assistant') return [];
  const events: RunEvent[] = [];
  for (const block of contentBlocks(obj)) {
    if (block.type === 'text') {
      const text = str(block.text);
      if (text && text.trim().length > 0) events.push({ type: 'message', at, text });
    } else if (block.type === 'tool_use') {
      const name = str(block.name) ?? 'tool';
      events.push({ type: 'tool', at, text: `${name} ${shortJson(block.input ?? {})}`.trim() });
    }
  }
  return events;
}

export function parseClaudeStream(lines: string[]): ClaudeParsed {
  const parsed: ClaudeParsed = { text: '', usage: emptyUsage(), isError: false };
  const assistantText: string[] = [];
  const errors: string[] = [];
  let sawResult = false;
  for (const line of lines) {
    const obj = parseJsonLine(line);
    if (!obj) continue;
    const sessionId = str(obj.session_id);
    if (sessionId && parsed.sessionId === undefined) parsed.sessionId = sessionId;
    const type = obj.type;
    if (type === 'assistant') {
      for (const block of contentBlocks(obj)) {
        if (block.type === 'text') {
          const text = str(block.text);
          if (text) assistantText.push(text);
        }
      }
    } else if (type === 'result') {
      sawResult = true;
      parsed.text = str(obj.result) ?? '';
      parsed.isError = obj.is_error === true;
      parsed.subtype = str(obj.subtype) ?? 'unknown';
      parsed.apiStatus = obj.api_error_status === null ? null : num(obj.api_error_status);
      const turns = num(obj.num_turns);
      if (turns !== undefined) parsed.numTurns = turns;
      parsed.usage = claudeUsageFrom(obj.usage, num(obj.total_cost_usd));
      if (parsed.isError) errors.push(parsed.text || `claude result ${parsed.subtype}`);
    }
    if ('error' in obj && type !== 'result') {
      const message = errorMessageOf(obj.error);
      if (message) errors.push(message);
    } else if (type === 'error') {
      const message = errorMessageOf(obj);
      if (message) errors.push(message);
    }
  }
  if (!sawResult) parsed.text = assistantText.join('\n');
  if (errors.length > 0) parsed.errorText = errors.join('\n');
  return parsed;
}

export function describeFailure(
  exec: ExecResult,
  req: RunRequest,
  limit: Limit | undefined,
  errorText: string | undefined,
  stderrTail: string,
  binary: string,
): string {
  if (exec.timedOut) return `timeout after ${req.timeoutSec}s`;
  if (exec.aborted) return 'cancelled';
  if (limit) return `${limit.kind} limit: ${oneLine(limit.message)}`;
  if (errorText) return oneLine(errorText);
  if (exec.code === null && exec.signal) return `${binary} killed by ${exec.signal}`;
  const tail = oneLine(stderrTail);
  return `${binary} exited with code ${exec.code ?? 'null'}${tail ? `: ${tail}` : ''}`;
}

export function buildClaudeResult(parsed: ClaudeParsed, exec: ExecResult, req: RunRequest, account: Account): RunResult {
  const stderrTail = tailOf(exec.stderr);
  const noResult = parsed.subtype === undefined;
  const parts: string[] = [];
  if (parsed.errorText) parts.push(parsed.errorText);
  if (exec.code !== 0 || parsed.isError || noResult) parts.push(stderrTail);
  const limit = exec.timedOut || exec.aborted ? undefined : detectLimit('claude', parts.join('\n'), parsed.apiStatus);
  const ok = exec.code === 0 && !exec.timedOut && !exec.aborted && !parsed.isError && !limit;
  const result: RunResult = {
    ok,
    output: parsed.text,
    usage: parsed.usage,
    provider: 'claude',
    accountId: account.id,
    durationMs: exec.durationMs,
    exitCode: exec.code,
  };
  if (parsed.sessionId) result.sessionId = parsed.sessionId;
  if (limit) result.limit = limit;
  if (!ok) result.error = describeFailure(exec, req, limit, parsed.errorText, stderrTail, CLAUDE_BINARY);
  return result;
}

export function failureResult(account: Account, started: number, error: string, limit?: Limit): RunResult {
  const result: RunResult = {
    ok: false,
    output: '',
    usage: emptyUsage(),
    provider: account.provider,
    accountId: account.id,
    durationMs: Date.now() - started,
    exitCode: null,
    error,
  };
  if (limit) result.limit = limit;
  return result;
}

function authStatusFrom(obj: Rec | undefined): AuthStatus | undefined {
  if (!obj || typeof obj.loggedIn !== 'boolean') return undefined;
  const status: AuthStatus = { loggedIn: obj.loggedIn };
  const method = str(obj.authMethod);
  if (method) status.detail = method;
  return status;
}

export function parseClaudeAuthStatus(stdout: string, stderr: string, code: number | null): AuthStatus {
  const whole = authStatusFrom(parseJsonLine(stdout));
  if (whole) return whole;
  for (const line of splitLines(stdout)) {
    const status = authStatusFrom(parseJsonLine(line));
    if (status) return status;
  }
  const detail = oneLine(tailOf(stderr) || tailOf(stdout));
  return { loggedIn: false, detail: detail || `claude auth status exited with code ${code ?? 'null'}` };
}

export const claudeProvider: ProviderAdapter = {
  id: 'claude',
  get binary(): string {
    return resolveBinary(CLAUDE_BINARY);
  },

  async login(profileDir: string, opts: LoginOptions): Promise<void> {
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    if (opts.token !== undefined) {
      const token = opts.token.trim();
      if (!token) throw new Error('empty token; run `claude setup-token` and paste its output');
      await writeFileAtomic(tokenFile(profileDir), `${token}\n`, 0o600);
      return;
    }
    const code = await runInteractive(this.binary, ['auth', 'login'], claudeEnv(process.env, profileDir));
    if (code !== 0) throw new Error(`claude auth login exited with code ${code}`);
  },

  async status(profileDir: string): Promise<AuthStatus> {
    const token = await readProfileToken(profileDir);
    const env = claudeEnv(process.env, profileDir, token);
    try {
      const exec = await runProcess({
        cmd: this.binary,
        args: ['auth', 'status', '--json'],
        cwd: process.cwd(),
        env,
        timeoutMs: STATUS_TIMEOUT_MS,
      });
      return parseClaudeAuthStatus(exec.stdout, exec.stderr, exec.code);
    } catch (err) {
      return { loggedIn: false, detail: (err as Error).message };
    }
  },

  async run(req: RunRequest, account: Account, onEvent?: (e: RunEvent) => void): Promise<RunResult> {
    const started = Date.now();
    const emit = (type: RunEvent['type'], text?: string): void => {
      if (!onEvent) return;
      const event: RunEvent = { type, at: Date.now() };
      if (text !== undefined) event.text = text;
      onEvent(event);
    };
    let token: string | undefined;
    if (account.auth === 'token') {
      token = await readProfileToken(account.profileDir);
      if (!token) {
        const message = `token file missing or empty: ${tokenFile(account.profileDir)}`;
        const result = failureResult(account, started, message, { kind: 'auth', message });
        emit('end', result.error);
        return result;
      }
    }
    const cmd = this.binary;
    const args = claudeArgs(req);
    const env = claudeEnv(process.env, account.profileDir, token);
    emit('start', `${cmd} ${args.join(' ')}`);
    let exec: ExecResult;
    try {
      exec = await runProcess({
        cmd,
        args,
        cwd: req.cwd,
        env,
        stdin: req.prompt,
        timeoutMs: timeoutMsFor(req),
        signal: req.signal,
        onStdoutLine: (line) => {
          if (!onEvent) return;
          for (const e of claudeEventsFor(line)) onEvent(e);
        },
        onStderrLine: (line) => emit('stderr', line),
      });
    } catch (err) {
      const result = failureResult(account, started, (err as Error).message);
      emit('end', result.error);
      return result;
    }
    const parsed = parseClaudeStream(splitLines(exec.stdout));
    const result = buildClaudeResult(parsed, exec, req, account);
    emit('end', result.ok ? 'ok' : result.error);
    return result;
  },
};
