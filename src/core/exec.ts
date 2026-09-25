import { spawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import type { ProviderId } from './types.js';

export interface ExecOptions {
  cmd: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  stdio?: 'pipe' | 'inherit';
  killGraceMs?: number;
  maxBuffer?: number;
}

export interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

export const MAX_BUFFER = 8 * 1024 * 1024;
export const KILL_GRACE_MS = 5000;
export const MAX_TIMER_MS = 2 ** 31 - 1;

export const SCRUB_KEYS: Record<ProviderId, string[]> = {
  claude: [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
  ],
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'],
};

export function splitLines(pending: string, chunk: string): { lines: string[]; rest: string } {
  const data = pending + chunk;
  const parts = data.split('\n');
  const rest = parts.pop() ?? '';
  const lines = parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  return { lines, rest };
}

export class LineSplitter {
  private pending = '';

  push(chunk: string): string[] {
    const { lines, rest } = splitLines(this.pending, chunk);
    this.pending = rest;
    return lines;
  }

  flush(): string[] {
    if (this.pending.length === 0) return [];
    const last = this.pending.endsWith('\r') ? this.pending.slice(0, -1) : this.pending;
    this.pending = '';
    return last.length > 0 ? [last] : [];
  }
}

export class TailBuffer {
  private chunks: string[] = [];
  private size = 0;
  private dropped = false;

  constructor(private readonly max: number = MAX_BUFFER) {}

  append(chunk: string): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.chunks.length > 1 && this.size - (this.chunks[0]?.length ?? 0) >= this.max) {
      this.size -= this.chunks.shift()?.length ?? 0;
      this.dropped = true;
    }
  }

  get truncated(): boolean {
    return this.dropped || this.size > this.max;
  }

  toString(): string {
    const s = this.chunks.join('');
    return s.length > this.max ? s.slice(s.length - this.max) : s;
  }
}

export const SCRUB_ALWAYS = ['SUBPOOL_TOKEN'];

export function scrubEnv(base: NodeJS.ProcessEnv, provider: ProviderId): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  for (const keys of Object.values(SCRUB_KEYS)) for (const key of keys) delete out[key];
  for (const key of SCRUB_ALWAYS) delete out[key];
  return out;
}

export function binaryEnvVar(name: string): string {
  return `SUBPOOL_${name.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase()}_BIN`;
}

export function resolveBinary(name: string, override?: string): string {
  if (override && override.length > 0) return override;
  const fromEnv = process.env[binaryEnvVar(name)];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return name;
}

export function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function assertDirectory(dir: string, label = 'cwd'): void {
  if (!isDirectory(dir)) throw new Error(`${label} "${dir}" does not exist or is not a directory`);
}

export function hasPathSeparator(cmd: string): boolean {
  return cmd.includes('/') || cmd.includes('\\');
}

export function spawnErrorMessage(cmd: string, err: NodeJS.ErrnoException, cwd?: string): string {
  if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
    if (cwd !== undefined && !isDirectory(cwd)) return `working directory "${cwd}" does not exist or is not a directory`;
    if (err.code === 'ENOENT') {
      const hint = hasPathSeparator(cmd) ? '' : `; install it or set ${binaryEnvVar(cmd)}`;
      return `cannot run "${cmd}": binary not found (ENOENT)${hint}`;
    }
  }
  if (err.code === 'EACCES') return `cannot run "${cmd}": permission denied (EACCES)`;
  return `cannot run "${cmd}": ${err.message}`;
}

function killTree(child: ChildProcess, sig: NodeJS.Signals, grouped: boolean): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (grouped) {
    try {
      process.kill(-pid, sig);
      return;
    } catch {
      void 0;
    }
  }
  try {
    child.kill(sig);
  } catch {
    void 0;
  }
}

function safeCall(fn: ((line: string) => void) | undefined, line: string): void {
  if (!fn) return;
  try {
    fn(line);
  } catch {
    void 0;
  }
}

export function runProcess(opts: ExecOptions): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    const start = Date.now();
    const piped = (opts.stdio ?? 'pipe') === 'pipe';
    const grouped = piped && process.platform !== 'win32';
    const graceMs = opts.killGraceMs ?? KILL_GRACE_MS;
    const max = opts.maxBuffer ?? MAX_BUFFER;

    let child: ChildProcess;
    try {
      child = spawn(opts.cmd, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: piped ? ['pipe', 'pipe', 'pipe'] : 'inherit',
        detached: grouped,
        windowsHide: true,
      });
    } catch (e) {
      reject(new Error(spawnErrorMessage(opts.cmd, e as NodeJS.ErrnoException, opts.cwd)));
      return;
    }

    const out = new TailBuffer(max);
    const err = new TailBuffer(max);
    const outLines = new LineSplitter();
    const errLines = new LineSplitter();
    let settled = false;
    let spawned = false;
    let timedOut = false;
    let aborted = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let closeTimer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (closeTimer) clearTimeout(closeTimer);
      opts.signal?.removeEventListener('abort', onAbort);
    };

    const destroyStdio = (): void => {
      for (const stream of [child.stdout, child.stderr, child.stdin]) {
        try {
          stream?.destroy();
        } catch {
          void 0;
        }
      }
    };

    const terminate = (): void => {
      if (killTimer) return;
      killTree(child, 'SIGTERM', grouped);
      killTimer = setTimeout(() => killTree(child, 'SIGKILL', grouped), graceMs);
    };

    const onAbort = (): void => {
      if (settled) return;
      aborted = true;
      terminate();
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      for (const line of outLines.flush()) safeCall(opts.onStdoutLine, line);
      for (const line of errLines.flush()) safeCall(opts.onStderrLine, line);
      resolve({
        code: exitCode,
        signal: exitSignal,
        stdout: out.toString(),
        stderr: err.toString(),
        timedOut,
        aborted,
        durationMs: Date.now() - start,
      });
    };

    child.once('spawn', () => {
      spawned = true;
    });

    child.on('error', (e: NodeJS.ErrnoException) => {
      if (settled) return;
      if (!spawned) {
        settled = true;
        cleanup();
        reject(new Error(spawnErrorMessage(opts.cmd, e, opts.cwd)));
        return;
      }
      err.append(`\n${e.message}\n`);
    });

    child.once('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      if (settled) return;
      closeTimer = setTimeout(() => {
        if (settled) return;
        destroyStdio();
        finish();
      }, graceMs);
    });

    child.once('close', (code, signal) => {
      if (exitCode === null && exitSignal === null) {
        exitCode = code;
        exitSignal = signal;
      }
      finish();
    });

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        out.append(chunk);
        for (const line of outLines.push(chunk)) safeCall(opts.onStdoutLine, line);
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        err.append(chunk);
        for (const line of errLines.push(chunk)) safeCall(opts.onStderrLine, line);
      });
    }
    if (child.stdin) {
      child.stdin.on('error', () => undefined);
      if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
      else child.stdin.end();
    }

    if (opts.timeoutMs > 0 && Number.isFinite(opts.timeoutMs)) {
      timeoutTimer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        terminate();
      }, opts.timeoutMs);
    }

    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export function runInteractive(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { cwd: cwd ?? process.cwd(), env, stdio: 'inherit' });
    } catch (e) {
      reject(new Error(spawnErrorMessage(cmd, e as NodeJS.ErrnoException, cwd)));
      return;
    }
    let spawned = false;
    let settled = false;
    child.once('spawn', () => {
      spawned = true;
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (settled || spawned) return;
      settled = true;
      reject(new Error(spawnErrorMessage(cmd, e, cwd)));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}
