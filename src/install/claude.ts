import { resolveBinary, runProcess, scrubEnv, type ExecResult } from '../core/exec.js';

export const SERVER_NAME = 'subpool';
export const DEFAULT_TIMEOUT_MS = 60_000;

export type ClaudeScope = 'user' | 'local' | 'project';

export interface InstallClaudeOptions {
  scope: ClaudeScope;
  command: string;
  args: string[];
  binary?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface UninstallClaudeOptions {
  binary?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export function claudeMcpAddArgs(scope: ClaudeScope, command: string, args: string[], name = SERVER_NAME): string[] {
  return ['mcp', 'add', name, '--scope', scope, '--', command, ...args];
}

export function claudeMcpRemoveArgs(name = SERVER_NAME): string[] {
  return ['mcp', 'remove', name];
}

export function execOutput(result: ExecResult): string {
  const parts = [result.stdout.trim(), result.stderr.trim()].filter((p) => p.length > 0);
  if (result.timedOut) parts.push('timed out');
  else if (result.code !== 0) parts.push(`exit code ${result.code ?? `signal ${result.signal ?? 'unknown'}`}`);
  return parts.join('\n');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runClaude(
  args: string[],
  opts: { binary?: string; cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<ExecResult> {
  return runProcess({
    cmd: resolveBinary('claude', opts.binary),
    args,
    cwd: opts.cwd ?? process.cwd(),
    env: scrubEnv(opts.env ?? process.env, 'claude'),
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
}

export async function installClaude(opts: InstallClaudeOptions): Promise<{ ok: boolean; output: string }> {
  await runClaude(claudeMcpRemoveArgs(), opts).catch(() => undefined);
  try {
    const result = await runClaude(claudeMcpAddArgs(opts.scope, opts.command, opts.args), opts);
    return { ok: result.code === 0 && !result.timedOut, output: execOutput(result) };
  } catch (err) {
    return { ok: false, output: errorText(err) };
  }
}

export async function uninstallClaude(opts: UninstallClaudeOptions = {}): Promise<{ ok: boolean; output: string }> {
  try {
    const result = await runClaude(claudeMcpRemoveArgs(), opts);
    return { ok: result.code === 0 && !result.timedOut, output: execOutput(result) };
  } catch (err) {
    return { ok: false, output: errorText(err) };
  }
}
