import { promises as fs } from 'node:fs';
import type {
  Account,
  AuthStatus,
  LoginOptions,
  Permission,
  ProviderAdapter,
  RunEvent,
  RunRequest,
  RunResult,
  Usage,
} from '../core/types.js';
import { resolveBinary, runInteractive, runProcess, scrubEnv, type ExecResult } from '../core/exec.js';
import { detectLimit } from '../core/limits.js';
import { splitLines } from '../core/fsx.js';
import {
  STATUS_TIMEOUT_MS,
  describeFailure,
  emptyUsage,
  failureResult,
  oneLine,
  parseJsonLine,
  shortJson,
  tailOf,
  timeoutMsFor,
} from './claude.js';

export const CODEX_BINARY = 'codex';

export interface CodexParsed {
  text: string;
  usage: Usage;
  threadId?: string;
  failed: boolean;
  errorText?: string;
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

export function codexSandboxArgs(permission: Permission): string[] {
  switch (permission) {
    case 'read-only':
      return ['-s', 'read-only'];
    case 'edit':
      return ['-s', 'workspace-write'];
    case 'full':
      return ['--dangerously-bypass-approvals-and-sandbox'];
  }
}

export function codexArgs(req: RunRequest): string[] {
  const args = ['exec', '--json', '--color', 'never', '--skip-git-repo-check', '-C', req.cwd];
  if (req.model) args.push('-m', req.model);
  args.push(...codexSandboxArgs(req.permission));
  args.push('-');
  return args;
}

export function codexPrompt(req: RunRequest): string {
  const system = req.systemPrompt?.trim();
  return system ? `${system}\n\n${req.prompt}` : req.prompt;
}

export function codexEnv(base: NodeJS.ProcessEnv, profileDir: string): NodeJS.ProcessEnv {
  const env = scrubEnv(base, 'codex');
  env.CODEX_HOME = profileDir;
  return env;
}

export function codexUsageFrom(raw: unknown): Usage {
  const u = asRecord(raw) ?? {};
  const input = num(u.input_tokens) ?? 0;
  const output = num(u.output_tokens) ?? 0;
  const cached = num(u.cached_input_tokens) ?? 0;
  return { input, output, cached, total: input + output };
}

function addUsage(a: Usage, b: Usage): Usage {
  return { input: a.input + b.input, output: a.output + b.output, cached: a.cached + b.cached, total: a.total + b.total };
}

function itemOf(obj: Rec): Rec | undefined {
  return asRecord(obj.item);
}

function errorMessageOf(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  const rec = asRecord(v);
  if (!rec) return undefined;
  return str(rec.message) ?? str(rec.error) ?? (asRecord(rec.error) ? str(asRecord(rec.error)?.message) : undefined);
}

export function codexEventsFor(line: string, at: number = Date.now()): RunEvent[] {
  const obj = parseJsonLine(line);
  if (!obj) return [];
  const type = str(obj.type);
  if (!type) return [];
  const item = itemOf(obj);
  if (!item) return [];
  const itemType = str(item.type);
  if (type === 'item.completed' && itemType === 'agent_message') {
    const text = str(item.text);
    return text && text.trim().length > 0 ? [{ type: 'message', at, text }] : [];
  }
  if (type === 'item.completed' && itemType === 'reasoning') {
    const text = str(item.text);
    return text && text.trim().length > 0 ? [{ type: 'text', at, text }] : [];
  }
  if (type === 'item.started' || type === 'item.completed') {
    if (itemType === 'command_execution') {
      const command = str(item.command) ?? '';
      return type === 'item.started' ? [{ type: 'tool', at, text: `$ ${shortJson(command)}`.trim() }] : [];
    }
    if (itemType === 'file_change' || itemType === 'mcp_tool_call') {
      if (type !== 'item.started') return [];
      const detail = str(item.name) ?? str(item.command) ?? str(item.text) ?? '';
      return [{ type: 'tool', at, text: `${itemType} ${shortJson(detail)}`.trim() }];
    }
  }
  return [];
}

export function parseCodexEvents(lines: string[]): CodexParsed {
  const parsed: CodexParsed = { text: '', usage: emptyUsage(), failed: false };
  const errors: string[] = [];
  let sawUsage = false;
  for (const line of lines) {
    const obj = parseJsonLine(line);
    if (!obj) continue;
    const type = str(obj.type);
    if (type === 'thread.started') {
      const id = str(obj.thread_id);
      if (id) parsed.threadId = id;
    } else if (type === 'item.completed') {
      const item = itemOf(obj);
      if (item?.type === 'agent_message') {
        const text = str(item.text);
        if (text !== undefined) parsed.text = text;
      } else if (item?.type === 'error') {
        const message = str(item.message) ?? str(item.text);
        if (message) errors.push(message);
      }
    } else if (type === 'turn.completed') {
      const usage = codexUsageFrom(obj.usage);
      parsed.usage = sawUsage ? addUsage(parsed.usage, usage) : usage;
      sawUsage = true;
    } else if (type === 'turn.failed') {
      parsed.failed = true;
      const message = errorMessageOf(obj.error) ?? errorMessageOf(obj);
      errors.push(message ?? 'turn failed');
    } else if (type === 'error') {
      const message = errorMessageOf(obj);
      if (message) errors.push(message);
    }
  }
  if (errors.length > 0) parsed.errorText = errors.join('\n');
  return parsed;
}

export function buildCodexResult(parsed: CodexParsed, exec: ExecResult, req: RunRequest, account: Account): RunResult {
  const stderrTail = tailOf(exec.stderr);
  const parts: string[] = [];
  if (parsed.errorText) parts.push(parsed.errorText);
  if (exec.code !== 0 || parsed.failed) parts.push(stderrTail);
  const limit = exec.timedOut || exec.aborted ? undefined : detectLimit('codex', parts.join('\n'));
  const ok = exec.code === 0 && !exec.timedOut && !exec.aborted && !parsed.failed && !limit;
  const result: RunResult = {
    ok,
    output: parsed.text,
    usage: parsed.usage,
    provider: 'codex',
    accountId: account.id,
    durationMs: exec.durationMs,
    exitCode: exec.code,
  };
  if (parsed.threadId) result.sessionId = parsed.threadId;
  if (limit) result.limit = limit;
  if (!ok) result.error = describeFailure(exec, req, limit, parsed.failed ? parsed.errorText : undefined, stderrTail, CODEX_BINARY);
  return result;
}

export function parseCodexLoginStatus(stdout: string, stderr: string, code: number | null): AuthStatus {
  const text = `${stdout}\n${stderr}`;
  const lower = text.toLowerCase();
  const loggedIn = lower.includes('logged in') && !lower.includes('not logged in');
  const detail = oneLine(tailOf(stdout) || tailOf(stderr));
  return { loggedIn, detail: detail || `codex login status exited with code ${code ?? 'null'}` };
}

export const codexProvider: ProviderAdapter = {
  id: 'codex',
  get binary(): string {
    return resolveBinary(CODEX_BINARY);
  },

  async login(profileDir: string, opts: LoginOptions): Promise<void> {
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    const args = ['login', ...(opts.deviceAuth ? ['--device-auth'] : [])];
    const code = await runInteractive(this.binary, args, codexEnv(process.env, profileDir));
    if (code !== 0) throw new Error(`codex login exited with code ${code}`);
  },

  async status(profileDir: string): Promise<AuthStatus> {
    try {
      const exec = await runProcess({
        cmd: this.binary,
        args: ['login', 'status'],
        cwd: process.cwd(),
        env: codexEnv(process.env, profileDir),
        timeoutMs: STATUS_TIMEOUT_MS,
      });
      return parseCodexLoginStatus(exec.stdout, exec.stderr, exec.code);
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
    const cmd = this.binary;
    const args = codexArgs(req);
    const env = codexEnv(process.env, account.profileDir);
    emit('start', `${cmd} ${args.join(' ')}`);
    let exec: ExecResult;
    try {
      exec = await runProcess({
        cmd,
        args,
        cwd: req.cwd,
        env,
        stdin: codexPrompt(req),
        timeoutMs: timeoutMsFor(req),
        signal: req.signal,
        onStdoutLine: (line) => {
          if (!onEvent) return;
          for (const e of codexEventsFor(line)) onEvent(e);
        },
        onStderrLine: (line) => emit('stderr', line),
      });
    } catch (err) {
      const result = failureResult(account, started, (err as Error).message);
      emit('end', result.error);
      return result;
    }
    const parsed = parseCodexEvents(splitLines(exec.stdout));
    const result = buildCodexResult(parsed, exec, req, account);
    emit('end', result.ok ? 'ok' : result.error);
    return result;
  },
};
