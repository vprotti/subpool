import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Account, RunEvent, RunRequest } from '../src/core/types.js';
import {
  buildClaudeResult,
  claudeArgs,
  claudeEnv,
  claudeEventsFor,
  claudeProvider,
  claudeUsageFrom,
  describeFailure,
  parseClaudeAuthStatus,
  parseClaudeStream,
  readProfileToken,
  tailOf,
  timeoutMsFor,
} from '../src/providers/claude.js';
import {
  buildCodexResult,
  codexArgs,
  codexEnv,
  codexEventsFor,
  codexPrompt,
  codexProvider,
  parseCodexEvents,
  parseCodexLoginStatus,
} from '../src/providers/codex.js';
import { getProvider, isProviderId, providers } from '../src/providers/index.js';
import { MAX_TIMER_MS, type ExecResult } from '../src/core/exec.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function scenario(file: string, name: string): string[] {
  const text = fs.readFileSync(path.join(fixtures, file), 'utf8');
  const out: string[] = [];
  let current: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const m = /^#\s*scenario:\s*(\S+)/.exec(line);
    if (m) {
      current = m[1];
      continue;
    }
    if (line.trim().length > 0 && current === name) out.push(line);
  }
  return out;
}

function writeWrapper(dir: string, name: string, script: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  return file;
}

interface Dump {
  fake: string;
  argv: string[];
  env: Record<string, string | undefined>;
  stdin: string;
  cwd: string;
}

function dumpFrom(events: RunEvent[]): Dump {
  const line = events.find((e) => e.type === 'stderr' && e.text?.startsWith('{"fake":'))?.text;
  if (!line) throw new Error('fake did not dump its environment');
  return JSON.parse(line) as Dump;
}

function account(provider: 'claude' | 'codex', profileDir: string, auth: 'profile' | 'token' = 'profile'): Account {
  return {
    id: `${provider}-test`,
    provider,
    profileDir,
    weight: 1,
    budget: {},
    enabled: true,
    auth,
    createdAt: new Date(0).toISOString(),
  };
}

function request(cwd: string, extra: Partial<RunRequest> = {}): RunRequest {
  return { prompt: 'add a sum helper', cwd, permission: 'edit', timeoutSec: 15, ...extra };
}

function execResult(extra: Partial<ExecResult> = {}): ExecResult {
  return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, durationMs: 10, ...extra };
}

const savedEnv: Record<string, string | undefined> = {};
const managedKeys = [
  'SUBPOOL_CLAUDE_BIN',
  'SUBPOOL_CODEX_BIN',
  'FAKE_FIXTURE',
  'FAKE_EXIT',
  'FAKE_SLEEP_MS',
  'FAKE_DUMP_ENV',
  'FAKE_LOGGED_IN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CONFIG_DIR',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'OPENAI_BASE_URL',
  'CODEX_HOME',
];

let binDir: string;
let claudeBin: string;
let codexBin: string;
let home: string;

beforeAll(() => {
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subpool-fakebin-'));
  claudeBin = writeWrapper(binDir, 'claude', path.join(fixtures, 'fake-claude.mjs'));
  codexBin = writeWrapper(binDir, 'codex', path.join(fixtures, 'fake-codex.mjs'));
});

afterAll(() => {
  fs.rmSync(binDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const key of managedKeys) savedEnv[key] = process.env[key];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'subpool-home-'));
  process.env.SUBPOOL_CLAUDE_BIN = claudeBin;
  process.env.SUBPOOL_CODEX_BIN = codexBin;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-should-be-scrubbed';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'outer-oauth-token';
  process.env.CLAUDECODE = '1';
  process.env.OPENAI_API_KEY = 'sk-openai-should-be-scrubbed';
  process.env.OPENAI_BASE_URL = 'https://example.invalid';
  delete process.env.FAKE_FIXTURE;
  delete process.env.FAKE_EXIT;
  delete process.env.FAKE_SLEEP_MS;
  delete process.env.FAKE_DUMP_ENV;
  delete process.env.FAKE_LOGGED_IN;
});

afterEach(() => {
  for (const key of managedKeys) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

function profile(provider: 'claude' | 'codex', id = 'a'): string {
  const dir = path.join(home, 'profiles', `${provider}-${id}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

describe('claudeArgs', () => {
  const base = request('/work');

  it('maps read-only to plan mode with the mutating tools disallowed', () => {
    expect(claudeArgs({ ...base, permission: 'read-only' })).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'plan',
      '--disallowedTools',
      'Edit',
      'Write',
      'MultiEdit',
      'NotebookEdit',
      'Bash',
    ]);
  });

  it('maps edit and full', () => {
    expect(claudeArgs({ ...base, permission: 'edit' })).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits']);
    expect(claudeArgs({ ...base, permission: 'full' })).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions']);
  });

  it('adds model, max turns and system prompt before the permission flags and never a positional prompt', () => {
    const args = claudeArgs({ ...base, model: 'opus', maxTurns: 7, systemPrompt: 'be brief', permission: 'full' });
    expect(args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'opus',
      '--max-turns',
      '7',
      '--append-system-prompt',
      'be brief',
      '--dangerously-skip-permissions',
    ]);
    expect(args).not.toContain(base.prompt);
    expect(args).not.toContain('--permission-prompts');
  });
});

describe('codexArgs', () => {
  const base = request('/work/repo');

  it('maps sandbox flags and ends with - for stdin', () => {
    expect(codexArgs({ ...base, permission: 'read-only' })).toEqual([
      'exec',
      '--json',
      '--color',
      'never',
      '--skip-git-repo-check',
      '-C',
      '/work/repo',
      '-s',
      'read-only',
      '-',
    ]);
    expect(codexArgs({ ...base, permission: 'edit' }).slice(-3)).toEqual(['-s', 'workspace-write', '-']);
    expect(codexArgs({ ...base, permission: 'full' }).slice(-2)).toEqual(['--dangerously-bypass-approvals-and-sandbox', '-']);
  });

  it('adds -m for the model and folds the system prompt into stdin', () => {
    const args = codexArgs({ ...base, model: 'gpt-5-codex' });
    expect(args).toContain('-m');
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5-codex');
    expect(args).not.toContain(base.prompt);
    expect(codexPrompt(base)).toBe(base.prompt);
    expect(codexPrompt({ ...base, systemPrompt: ' rules ' })).toBe(`rules\n\n${base.prompt}`);
  });
});

describe('env construction', () => {
  it('claudeEnv scrubs api keys and nesting vars and sets CLAUDE_CONFIG_DIR', () => {
    const env = claudeEnv(
      { ANTHROPIC_API_KEY: 'x', ANTHROPIC_AUTH_TOKEN: 'y', CLAUDE_CODE_OAUTH_TOKEN: 'z', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', PATH: '/bin' },
      '/p/claude-a',
    );
    expect(env).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/p/claude-a' });
    expect(claudeEnv({}, '/p', 'tok').CLAUDE_CODE_OAUTH_TOKEN).toBe('tok');
  });

  it('codexEnv scrubs openai vars and sets CODEX_HOME', () => {
    const env = codexEnv({ OPENAI_API_KEY: 'x', CODEX_API_KEY: 'y', OPENAI_BASE_URL: 'z', HOME: '/h' }, '/p/codex-a');
    expect(env).toEqual({ HOME: '/h', CODEX_HOME: '/p/codex-a' });
  });

  it('timeoutMsFor converts seconds and disables the timer for non-positive values', () => {
    expect(timeoutMsFor(request('/w', { timeoutSec: 2.5 }))).toBe(2500);
    expect(timeoutMsFor(request('/w', { timeoutSec: 0 }))).toBe(0);
    expect(timeoutMsFor(request('/w', { timeoutSec: Number.POSITIVE_INFINITY }))).toBe(0);
  });

  it('timeoutMsFor clamps huge values below the Node timer limit', () => {
    expect(timeoutMsFor(request('/w', { timeoutSec: 3_000_000 }))).toBe(MAX_TIMER_MS);
    expect(timeoutMsFor(request('/w', { timeoutSec: 1e308 }))).toBe(MAX_TIMER_MS);
    expect(timeoutMsFor(request('/w', { timeoutSec: 86_400 }))).toBe(86_400_000);
  });
});

describe('parseClaudeStream', () => {
  it('parses a successful stream-json run', () => {
    const parsed = parseClaudeStream(scenario('claude-stream.jsonl', 'success'));
    expect(parsed.text).toBe('Done: added src/sum.ts with a typed sum helper.');
    expect(parsed.sessionId).toBe('3f1c2a9e-5b7d-4c1e-9a0b-2d4e6f8a1b3c');
    expect(parsed.isError).toBe(false);
    expect(parsed.subtype).toBe('success');
    expect(parsed.apiStatus).toBeNull();
    expect(parsed.numTurns).toBe(1);
    expect(parsed.errorText).toBeUndefined();
    expect(parsed.usage).toEqual({ input: 2, output: 4, cached: 31472, total: 2 + 4 + 7951 + 31472, costUsd: 0.038 });
  });

  it('parses a rate-limited result', () => {
    const parsed = parseClaudeStream(scenario('claude-stream.jsonl', 'rate-limited'));
    expect(parsed.isError).toBe(true);
    expect(parsed.subtype).toBe('error_during_execution');
    expect(parsed.apiStatus).toBe(429);
    expect(parsed.text).toBe('Claude AI usage limit reached|4102444800');
    expect(parsed.errorText).toContain('usage limit reached');
    expect(parsed.usage.total).toBe(0);
  });

  it('falls back to assistant text when no result line arrived and skips junk lines', () => {
    const parsed = parseClaudeStream(['not json', '', ...scenario('claude-stream.jsonl', 'no-result'), '{"type":"error","error":{"message":"stream closed"}}']);
    expect(parsed.text).toBe('Partial answer before the process died.');
    expect(parsed.subtype).toBeUndefined();
    expect(parsed.isError).toBe(false);
    expect(parsed.errorText).toBe('stream closed');
    expect(parsed.sessionId).toBe('aaaa1111-0000-4000-8000-000000000000');
  });

  it('claudeUsageFrom tolerates missing fields', () => {
    expect(claudeUsageFrom(undefined)).toEqual({ input: 0, output: 0, cached: 0, total: 0 });
    expect(claudeUsageFrom({ input_tokens: 10, output_tokens: 5 })).toEqual({ input: 10, output: 5, cached: 0, total: 15 });
  });

  it('claudeEventsFor emits message and tool events for assistant lines only', () => {
    const lines = scenario('claude-stream.jsonl', 'success');
    const events = lines.flatMap((l) => claudeEventsFor(l, 1));
    expect(events.map((e) => e.type)).toEqual(['message', 'tool', 'message']);
    expect(events[1]?.text?.startsWith('Write {"file_path":"/work/repo/src/sum.ts"')).toBe(true);
    expect(claudeEventsFor(lines[0] ?? '')).toEqual([]);
  });
});

describe('parseCodexEvents', () => {
  it('takes the last agent_message and the turn usage', () => {
    const parsed = parseCodexEvents(scenario('codex-events.jsonl', 'success'));
    expect(parsed.text).toBe('Added a `sum` helper in src/sum.ts and exported it from index.ts.');
    expect(parsed.threadId).toBe('019a1c2d-3e4f-7a8b-9c0d-1e2f3a4b5c6d');
    expect(parsed.failed).toBe(false);
    expect(parsed.errorText).toBeUndefined();
    expect(parsed.usage).toEqual({ input: 5120, output: 310, cached: 4096, total: 5430 });
  });

  it('collects error and turn.failed messages', () => {
    const parsed = parseCodexEvents(scenario('codex-events.jsonl', 'rate-limited'));
    expect(parsed.failed).toBe(true);
    expect(parsed.text).toBe('');
    expect(parsed.errorText).toBe("You've hit your usage limit. Try again in 2 hours 5 minutes.\nusage_limit_exceeded");
    expect(parsed.usage.total).toBe(0);
  });

  it('codexEventsFor maps items to message, tool and text events', () => {
    const events = scenario('codex-events.jsonl', 'success').flatMap((l) => codexEventsFor(l, 1));
    expect(events.map((e) => e.type)).toEqual(['text', 'tool', 'message', 'tool', 'message']);
    expect(events[1]?.text).toBe("$ /bin/bash -lc 'ls src'");
    expect(events[3]?.text).toBe('file_change');
    expect(codexEventsFor('{"type":"turn.completed","usage":{}}')).toEqual([]);
  });
});

describe('result construction (pure)', () => {
  const req = request('/w', { timeoutSec: 30 });
  const acct = account('claude', '/p');

  it('detects limits over stderr only when the run did not succeed', () => {
    const parsed = parseClaudeStream(scenario('claude-stream.jsonl', 'success'));
    const okResult = buildClaudeResult(parsed, execResult({ stderr: 'warning: rate limited, retrying' }), req, acct);
    expect(okResult.ok).toBe(true);
    expect(okResult.limit).toBeUndefined();
    const failed = buildClaudeResult(parsed, execResult({ code: 1, stderr: 'API Error: rate limited\n' }), req, acct);
    expect(failed.ok).toBe(false);
    expect(failed.limit?.kind).toBe('rate');
    expect(failed.error).toBe('rate limit: API Error: rate limited');
  });

  it('does not run limit detection on runs we killed by timeout or abort', () => {
    const parsed = parseClaudeStream(scenario('claude-stream.jsonl', 'no-result'));
    const timedOut = buildClaudeResult(parsed, execResult({ code: null, signal: 'SIGTERM', timedOut: true, stderr: 'API Error: rate limited\n' }), req, acct);
    expect(timedOut.ok).toBe(false);
    expect(timedOut.limit).toBeUndefined();
    expect(timedOut.error).toBe('timeout after 30s');
    const aborted = buildClaudeResult(parsed, execResult({ code: null, signal: 'SIGTERM', aborted: true, stderr: 'API Error (429) rate_limit_error\n' }), req, acct);
    expect(aborted.ok).toBe(false);
    expect(aborted.limit).toBeUndefined();
    expect(aborted.error).toBe('cancelled');
    const codexParsed = parseCodexEvents(scenario('codex-events.jsonl', 'rate-limited'));
    const codexTimedOut = buildCodexResult(codexParsed, execResult({ code: null, signal: 'SIGKILL', timedOut: true, stderr: 'usage_limit_exceeded' }), req, account('codex', '/p'));
    expect(codexTimedOut.limit).toBeUndefined();
    expect(codexTimedOut.error).toBe('timeout after 30s');
    const codexAborted = buildCodexResult(codexParsed, execResult({ code: null, signal: 'SIGTERM', aborted: true }), req, account('codex', '/p'));
    expect(codexAborted.limit).toBeUndefined();
    expect(codexAborted.error).toBe('cancelled');
  });

  it('reports non-zero exit with the stderr tail on one line', () => {
    const parsed = parseClaudeStream(scenario('claude-stream.jsonl', 'no-result'));
    const r = buildClaudeResult(parsed, execResult({ code: 2, stderr: 'line one\nboom\n  crashed  \n' }), req, acct);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(2);
    expect(r.output).toBe('Partial answer before the process died.');
    expect(r.error).toBe('claude exited with code 2: line one boom crashed');
    expect(r.error?.includes('\n')).toBe(false);
  });

  it('describes timeouts, aborts and signals', () => {
    expect(describeFailure(execResult({ code: null, signal: 'SIGTERM', timedOut: true }), req, undefined, undefined, '', 'claude')).toBe('timeout after 30s');
    expect(describeFailure(execResult({ code: null, signal: 'SIGTERM', aborted: true }), req, undefined, undefined, '', 'claude')).toBe('cancelled');
    expect(describeFailure(execResult({ code: null, signal: 'SIGKILL' }), req, undefined, undefined, '', 'codex')).toBe('codex killed by SIGKILL');
  });

  it('buildCodexResult flags auth failures as auth limits', () => {
    const parsed = parseCodexEvents(scenario('codex-events.jsonl', 'auth-failed'));
    const r = buildCodexResult(parsed, execResult({ code: 1 }), req, account('codex', '/p'));
    expect(r.ok).toBe(false);
    expect(r.limit?.kind).toBe('auth');
    expect(r.sessionId).toBe('019a1c2d-bbbb-7a8b-9c0d-1e2f3a4b5c6d');
    expect(r.error?.startsWith('auth limit: ')).toBe(true);
  });

  it('tailOf keeps the last lines within the char cap', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const tail = tailOf(text, 3);
    expect(tail).toBe('line 47\nline 48\nline 49');
    expect(tailOf('abcdef', 5, 3)).toBe('def');
  });
});

describe('auth status parsing', () => {
  it('parseClaudeAuthStatus reads loggedIn from the json line', () => {
    expect(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","configDirectory":"/x"}\n', '', 0)).toEqual({ loggedIn: true, detail: 'claude.ai' });
    expect(parseClaudeAuthStatus('{\n  "loggedIn": true,\n  "authMethod": "oauth_token",\n  "apiProvider": "firstParty",\n  "configDirectory": "/x"\n}\n', '', 0)).toEqual({ loggedIn: true, detail: 'oauth_token' });
    expect(parseClaudeAuthStatus('{\n  "loggedIn": false\n}\n', '', 0)).toEqual({ loggedIn: false });
    expect(parseClaudeAuthStatus('', 'Not logged in\n', 1)).toEqual({ loggedIn: false, detail: 'Not logged in' });
    expect(parseClaudeAuthStatus('', '', 1).loggedIn).toBe(false);
  });

  it('parseCodexLoginStatus distinguishes Logged in from Not logged in', () => {
    expect(parseCodexLoginStatus('Logged in using ChatGPT\n', '', 0)).toEqual({ loggedIn: true, detail: 'Logged in using ChatGPT' });
    expect(parseCodexLoginStatus('Not logged in\n', '', 0).loggedIn).toBe(false);
    expect(parseCodexLoginStatus('', '', 0).loggedIn).toBe(false);
  });
});

describe('claudeProvider.run (fake binary)', () => {
  it('runs a successful task with the prompt on stdin, scrubbed env and isolation var', async () => {
    process.env.FAKE_FIXTURE = 'claude-stream.jsonl#success';
    process.env.FAKE_DUMP_ENV = '1';
    const profileDir = profile('claude');
    const events: RunEvent[] = [];
    const req = request(home, { permission: 'read-only', model: 'sonnet' });
    const result = await claudeProvider.run(req, account('claude', profileDir), (e) => events.push(e));

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.limit).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.provider).toBe('claude');
    expect(result.accountId).toBe('claude-test');
    expect(result.output).toBe('Done: added src/sum.ts with a typed sum helper.');
    expect(result.sessionId).toBe('3f1c2a9e-5b7d-4c1e-9a0b-2d4e6f8a1b3c');
    expect(result.usage).toEqual({ input: 2, output: 4, cached: 31472, total: 39429, costUsd: 0.038 });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const dump = dumpFrom(events);
    expect(dump.fake).toBe('claude');
    expect(dump.argv).toEqual(claudeArgs(req));
    expect(dump.stdin).toBe(req.prompt);
    expect(dump.cwd).toBe(fs.realpathSync(home));
    expect(dump.env.CLAUDE_CONFIG_DIR).toBe(profileDir);
    expect(dump.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(dump.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(dump.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(dump.env.CLAUDECODE).toBeUndefined();
    expect(dump.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('start');
    expect(types[types.length - 1]).toBe('end');
    expect(events.filter((e) => e.type === 'message').map((e) => e.text)).toEqual([
      "I'll add the helper and its test.",
      'Done: added src/sum.ts with a typed sum helper.',
    ]);
    expect(events.filter((e) => e.type === 'tool')).toHaveLength(1);
    expect(events[events.length - 1]?.text).toBe('ok');
  });

  it('sets CLAUDE_CODE_OAUTH_TOKEN from the profile token file in token mode', async () => {
    process.env.FAKE_FIXTURE = 'claude-stream.jsonl#success';
    process.env.FAKE_DUMP_ENV = '1';
    const profileDir = profile('claude', 'tok');
    fs.writeFileSync(path.join(profileDir, 'token'), '  sk-ant-oat01-long-lived-token \n', { mode: 0o600 });
    expect(await readProfileToken(profileDir)).toBe('sk-ant-oat01-long-lived-token');
    const events: RunEvent[] = [];
    const result = await claudeProvider.run(request(home), account('claude', profileDir, 'token'), (e) => events.push(e));
    expect(result.ok).toBe(true);
    const dump = dumpFrom(events);
    expect(dump.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-long-lived-token');
    expect(dump.env.CLAUDE_CONFIG_DIR).toBe(profileDir);
    expect(dump.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('fails with an auth limit when the token file is missing', async () => {
    process.env.FAKE_FIXTURE = 'claude-stream.jsonl#success';
    const profileDir = profile('claude', 'notoken');
    const events: RunEvent[] = [];
    const result = await claudeProvider.run(request(home), account('claude', profileDir, 'token'), (e) => events.push(e));
    expect(result.ok).toBe(false);
    expect(result.limit?.kind).toBe('auth');
    expect(result.error).toContain('token file missing');
    expect(result.exitCode).toBeNull();
    expect(events.some((e) => e.type === 'start')).toBe(false);
  });

  it('detects a usage limit and ignores an implausibly distant |epoch suffix', async () => {
    process.env.FAKE_FIXTURE = 'claude-stream.jsonl#rate-limited';
    process.env.FAKE_EXIT = '1';
    const result = await claudeProvider.run(request(home), account('claude', profile('claude')));
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.limit?.kind).toBe('rate');
    expect(result.limit?.resetAt).toBeUndefined();
    expect(result.limit?.message).toContain('usage limit reached');
    expect(result.error).toBe('rate limit: Claude AI usage limit reached|4102444800');
    expect(result.output).toBe('Claude AI usage limit reached|4102444800');
    expect(result.usage.total).toBe(0);
  });

  it('reports a non-zero exit without a limit as a plain failure', async () => {
    process.env.FAKE_FIXTURE = 'claude-stream.jsonl#no-result';
    process.env.FAKE_EXIT = '3';
    const result = await claudeProvider.run(request(home), account('claude', profile('claude')));
    expect(result.ok).toBe(false);
    expect(result.limit).toBeUndefined();
    expect(result.exitCode).toBe(3);
    expect(result.error).toBe('claude exited with code 3');
    expect(result.output).toBe('Partial answer before the process died.');
  });

  it('times out and kills the child', async () => {
    process.env.FAKE_FIXTURE = 'claude-stream.jsonl#no-result';
    process.env.FAKE_SLEEP_MS = '15000';
    const started = Date.now();
    const result = await claudeProvider.run(request(home, { timeoutSec: 1 }), account('claude', profile('claude')));
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('timeout after 1s');
    expect(result.exitCode).toBeNull();
    expect(result.limit).toBeUndefined();
  });

  it('honours an abort signal', async () => {
    process.env.FAKE_FIXTURE = 'claude-stream.jsonl#no-result';
    process.env.FAKE_SLEEP_MS = '15000';
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const result = await claudeProvider.run(request(home, { signal: controller.signal }), account('claude', profile('claude')));
    expect(result.ok).toBe(false);
    expect(result.error).toBe('cancelled');
  });

  it('returns a readable failure when the binary is missing', async () => {
    process.env.SUBPOOL_CLAUDE_BIN = path.join(home, 'does-not-exist');
    const result = await claudeProvider.run(request(home), account('claude', profile('claude')));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('binary not found');
    expect(result.error).not.toContain('SUBPOOL_');
    expect(result.exitCode).toBeNull();
  });

  it('reports a missing working directory instead of blaming the binary', async () => {
    process.env.FAKE_FIXTURE = 'claude-stream.jsonl#success';
    const result = await claudeProvider.run(request(path.join(home, 'nope')), account('claude', profile('claude')));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('working directory');
    expect(result.error).not.toContain('binary not found');
  });
});

describe('claudeProvider.login / status (fake binary)', () => {
  it('login writes the token file with mode 0600 without spawning', async () => {
    process.env.SUBPOOL_CLAUDE_BIN = path.join(home, 'must-not-run');
    const profileDir = path.join(home, 'profiles', 'claude-t');
    await claudeProvider.login(profileDir, { token: '  tok-123\n' });
    const file = path.join(profileDir, 'token');
    expect(fs.readFileSync(file, 'utf8')).toBe('tok-123\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(profileDir).mode & 0o777).toBe(0o700);
    await expect(claudeProvider.login(profileDir, { token: '   ' })).rejects.toThrow(/empty token/);
  });

  it('login runs claude auth login with the profile env', async () => {
    const profileDir = path.join(home, 'profiles', 'claude-i');
    await claudeProvider.login(profileDir, {});
    const marker = JSON.parse(fs.readFileSync(path.join(profileDir, 'fake-login.json'), 'utf8')) as { argv: string[]; env: Record<string, string | null> };
    expect(marker.argv).toEqual(['auth', 'login']);
    expect(marker.env.CLAUDE_CONFIG_DIR).toBe(profileDir);
    expect(marker.env.ANTHROPIC_API_KEY).toBeNull();
    process.env.FAKE_EXIT = '1';
    await expect(claudeProvider.login(profileDir, {})).rejects.toThrow(/exited with code 1/);
  });

  it('status parses auth status --json and passes the profile token', async () => {
    const profileDir = profile('claude', 's');
    expect(await claudeProvider.status(profileDir)).toEqual({ loggedIn: true, detail: 'claude.ai' });
    fs.writeFileSync(path.join(profileDir, 'token'), 'tok\n');
    expect(await claudeProvider.status(profileDir)).toEqual({ loggedIn: true, detail: 'oauth_token' });
    process.env.FAKE_LOGGED_IN = '0';
    expect((await claudeProvider.status(profileDir)).loggedIn).toBe(false);
    process.env.SUBPOOL_CLAUDE_BIN = path.join(home, 'missing');
    const status = await claudeProvider.status(profileDir);
    expect(status.loggedIn).toBe(false);
    expect(status.detail).toContain('binary not found');
  });
});

describe('codexProvider.run (fake binary)', () => {
  it('runs a successful task with CODEX_HOME and scrubbed openai vars', async () => {
    process.env.FAKE_FIXTURE = 'codex-events.jsonl#success';
    process.env.FAKE_DUMP_ENV = '1';
    const profileDir = profile('codex');
    const events: RunEvent[] = [];
    const req = request(home, { permission: 'full', systemPrompt: 'answer tersely' });
    const result = await codexProvider.run(req, account('codex', profileDir), (e) => events.push(e));

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.provider).toBe('codex');
    expect(result.output).toBe('Added a `sum` helper in src/sum.ts and exported it from index.ts.');
    expect(result.sessionId).toBe('019a1c2d-3e4f-7a8b-9c0d-1e2f3a4b5c6d');
    expect(result.usage).toEqual({ input: 5120, output: 310, cached: 4096, total: 5430 });

    const dump = dumpFrom(events);
    expect(dump.fake).toBe('codex');
    expect(dump.argv).toEqual(codexArgs(req));
    expect(dump.argv[dump.argv.length - 1]).toBe('-');
    expect(dump.argv[dump.argv.indexOf('-C') + 1]).toBe(home);
    expect(dump.stdin).toBe(`answer tersely\n\n${req.prompt}`);
    expect(dump.env.CODEX_HOME).toBe(profileDir);
    expect(dump.env.OPENAI_API_KEY).toBeUndefined();
    expect(dump.env.OPENAI_BASE_URL).toBeUndefined();
    expect(dump.env.CODEX_API_KEY).toBeUndefined();

    expect(events.filter((e) => e.type === 'message').map((e) => e.text)).toEqual(['Working on it.', result.output]);
    expect(events.filter((e) => e.type === 'tool').map((e) => e.text)).toEqual(["$ /bin/bash -lc 'ls src'", 'file_change']);
    expect(events.some((e) => e.type === 'stderr' && e.text?.includes('codex_core::codex'))).toBe(true);
  });

  it('detects usage_limit_exceeded with a relative reset', async () => {
    process.env.FAKE_FIXTURE = 'codex-events.jsonl#rate-limited';
    process.env.FAKE_EXIT = '1';
    const before = Date.now();
    const result = await codexProvider.run(request(home), account('codex', profile('codex')));
    const after = Date.now();
    expect(result.ok).toBe(false);
    expect(result.limit?.kind).toBe('rate');
    const expected = 2 * 3_600_000 + 5 * 60_000;
    expect(result.limit?.resetAt).toBeGreaterThanOrEqual(before + expected);
    expect(result.limit?.resetAt).toBeLessThanOrEqual(after + expected);
    expect(result.error?.startsWith('rate limit: ')).toBe(true);
    expect(result.output).toBe('');
  });

  it('marks a turn.failed run without a limit as a failure even on exit 0', async () => {
    process.env.FAKE_FIXTURE = 'codex-events.jsonl#auth-failed';
    const result = await codexProvider.run(request(home), account('codex', profile('codex')));
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.limit?.kind).toBe('auth');
  });

  it('times out', async () => {
    process.env.FAKE_FIXTURE = 'codex-events.jsonl#success';
    process.env.FAKE_SLEEP_MS = '15000';
    const result = await codexProvider.run(request(home, { timeoutSec: 1 }), account('codex', profile('codex')));
    expect(result.ok).toBe(false);
    expect(result.error).toBe('timeout after 1s');
    expect(result.exitCode).toBeNull();
  });
});

describe('codexProvider.login / status (fake binary)', () => {
  it('login passes --device-auth and CODEX_HOME', async () => {
    const profileDir = path.join(home, 'profiles', 'codex-i');
    await codexProvider.login(profileDir, { deviceAuth: true });
    const marker = JSON.parse(fs.readFileSync(path.join(profileDir, 'fake-login.json'), 'utf8')) as { argv: string[]; env: Record<string, string | null> };
    expect(marker.argv).toEqual(['login', '--device-auth']);
    expect(marker.env.CODEX_HOME).toBe(profileDir);
    expect(marker.env.OPENAI_API_KEY).toBeNull();
    expect(fs.statSync(profileDir).mode & 0o777).toBe(0o700);
    await codexProvider.login(profileDir, {});
    expect((JSON.parse(fs.readFileSync(path.join(profileDir, 'fake-login.json'), 'utf8')) as { argv: string[] }).argv).toEqual(['login']);
  });

  it('status parses codex login status text', async () => {
    const profileDir = profile('codex', 's');
    expect(await codexProvider.status(profileDir)).toEqual({ loggedIn: true, detail: 'Logged in using ChatGPT' });
    process.env.FAKE_LOGGED_IN = '0';
    expect(await codexProvider.status(profileDir)).toEqual({ loggedIn: false, detail: 'Not logged in' });
  });
});

describe('providers registry', () => {
  it('exposes both adapters and resolves binaries lazily from env', () => {
    expect(Object.keys(providers).sort()).toEqual(['claude', 'codex']);
    expect(getProvider('claude')).toBe(claudeProvider);
    expect(getProvider('codex')).toBe(codexProvider);
    expect(getProvider('claude').binary).toBe(claudeBin);
    expect(getProvider('codex').binary).toBe(codexBin);
    delete process.env.SUBPOOL_CLAUDE_BIN;
    expect(claudeProvider.binary).toBe('claude');
    expect(isProviderId('claude')).toBe(true);
    expect(isProviderId('gemini')).toBe(false);
    expect(() => getProvider('gemini' as 'claude')).toThrow(/unknown provider/);
  });
});
