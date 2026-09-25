import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LineSplitter,
  TailBuffer,
  assertDirectory,
  binaryEnvVar,
  hasPathSeparator,
  isDirectory,
  resolveBinary,
  runInteractive,
  runProcess,
  scrubEnv,
  spawnErrorMessage,
  splitLines,
  type ExecOptions,
} from '../src/core/exec.js';

const node = process.execPath;

function nodeScript(script: string, extra: Partial<ExecOptions> = {}): ExecOptions {
  return {
    cmd: node,
    args: ['-e', script],
    cwd: os.tmpdir(),
    env: { ...process.env },
    timeoutMs: 10_000,
    ...extra,
  };
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'subpool-exec-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('splitLines / LineSplitter', () => {
  it('splits on LF and strips CR, keeping the partial tail', () => {
    expect(splitLines('', 'a\nb\r\nc')).toEqual({ lines: ['a', 'b'], rest: 'c' });
    expect(splitLines('c', 'd\n')).toEqual({ lines: ['cd'], rest: '' });
    expect(splitLines('', '')).toEqual({ lines: [], rest: '' });
  });

  it('LineSplitter reassembles chunks and flushes the remainder', () => {
    const s = new LineSplitter();
    expect(s.push('hel')).toEqual([]);
    expect(s.push('lo\nwor')).toEqual(['hello']);
    expect(s.push('ld\r')).toEqual([]);
    expect(s.push('\nlast')).toEqual(['world']);
    expect(s.flush()).toEqual(['last']);
    expect(s.flush()).toEqual([]);
  });

  it('LineSplitter flush drops a trailing CR', () => {
    const s = new LineSplitter();
    s.push('x\r');
    expect(s.flush()).toEqual(['x']);
  });
});

describe('TailBuffer', () => {
  it('keeps the tail once the cap is exceeded', () => {
    const b = new TailBuffer(10);
    b.append('0123456789abc');
    expect(b.toString()).toBe('3456789abc');
    expect(b.truncated).toBe(true);
  });

  it('drops whole leading chunks and keeps the last max characters', () => {
    const b = new TailBuffer(8);
    for (const c of ['aaaa', 'bbbb', 'cccc', 'dd']) b.append(c);
    expect(b.toString()).toBe('bbccccdd');
    expect(b.truncated).toBe(true);
    b.append('eeee');
    expect(b.toString()).toBe('ccddeeee');
  });

  it('is not truncated while under the cap', () => {
    const b = new TailBuffer(100);
    b.append('short');
    b.append('');
    expect(b.toString()).toBe('short');
    expect(b.truncated).toBe(false);
  });
});

describe('scrubEnv / resolveBinary', () => {
  it('removes provider specific keys and returns a copy', () => {
    const base: NodeJS.ProcessEnv = {
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'k',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_OAUTH_TOKEN: 't',
      OPENAI_API_KEY: 'o',
      CODEX_API_KEY: 'c',
      OPENAI_BASE_URL: 'u',
    };
    const claude = scrubEnv(base, 'claude');
    expect(claude.PATH).toBe('/bin');
    expect(claude.ANTHROPIC_API_KEY).toBeUndefined();
    expect(claude.CLAUDECODE).toBeUndefined();
    expect(claude.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(claude.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(claude.OPENAI_API_KEY).toBeUndefined();
    const codex = scrubEnv({ ...base, SUBPOOL_TOKEN: 's' }, 'codex');
    expect(codex.OPENAI_API_KEY).toBeUndefined();
    expect(codex.CODEX_API_KEY).toBeUndefined();
    expect(codex.OPENAI_BASE_URL).toBeUndefined();
    expect(codex.ANTHROPIC_API_KEY).toBeUndefined();
    expect(codex.SUBPOOL_TOKEN).toBeUndefined();
    expect(codex.PATH).toBe('/bin');
    expect(base.ANTHROPIC_API_KEY).toBe('k');
  });

  it('resolves binaries from override, env var, then name', () => {
    const prev = process.env.SUBPOOL_CLAUDE_BIN;
    try {
      delete process.env.SUBPOOL_CLAUDE_BIN;
      expect(resolveBinary('claude')).toBe('claude');
      process.env.SUBPOOL_CLAUDE_BIN = '/opt/claude';
      expect(resolveBinary('claude')).toBe('/opt/claude');
      expect(resolveBinary('claude', '/custom/claude')).toBe('/custom/claude');
      expect(binaryEnvVar('codex')).toBe('SUBPOOL_CODEX_BIN');
      expect(binaryEnvVar('my-tool')).toBe('SUBPOOL_MY_TOOL_BIN');
    } finally {
      if (prev === undefined) delete process.env.SUBPOOL_CLAUDE_BIN;
      else process.env.SUBPOOL_CLAUDE_BIN = prev;
    }
  });

  it('spawnErrorMessage names the binary', () => {
    const e = Object.assign(new Error('spawn nope ENOENT'), { code: 'ENOENT' });
    expect(spawnErrorMessage('nope', e)).toContain('"nope"');
    expect(spawnErrorMessage('nope', e)).toContain('ENOENT');
  });

  it('spawnErrorMessage distinguishes a missing cwd and only hints the env var for bare names', () => {
    const e = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    expect(spawnErrorMessage('claude', e, tmp)).toBe('cannot run "claude": binary not found (ENOENT); install it or set SUBPOOL_CLAUDE_BIN');
    expect(spawnErrorMessage('/opt/claude', e, tmp)).toBe('cannot run "/opt/claude": binary not found (ENOENT)');
    const missing = path.join(tmp, 'missing');
    expect(spawnErrorMessage('claude', e, missing)).toBe(`working directory "${missing}" does not exist or is not a directory`);
    const file = path.join(tmp, 'file');
    fs.writeFileSync(file, '');
    const notdir = Object.assign(new Error('spawn claude ENOTDIR'), { code: 'ENOTDIR' });
    expect(spawnErrorMessage('claude', notdir, file)).toContain('not a directory');
    expect(isDirectory(tmp)).toBe(true);
    expect(isDirectory(file)).toBe(false);
    expect(() => assertDirectory(tmp)).not.toThrow();
    expect(() => assertDirectory(missing, 'cwd')).toThrow(`cwd "${missing}" does not exist or is not a directory`);
    expect(hasPathSeparator('claude')).toBe(false);
    expect(hasPathSeparator('./claude')).toBe(true);
    expect(hasPathSeparator('C:\\claude.exe')).toBe(true);
  });
});

describe('runProcess', () => {
  it('captures stdout lines including CRLF and partial trailing lines', async () => {
    const lines: string[] = [];
    const res = await runProcess(
      nodeScript(`process.stdout.write('one\\ntwo\\r\\n'); setTimeout(() => process.stdout.write('three'), 20);`, {
        onStdoutLine: (l) => lines.push(l),
      }),
    );
    expect(res.code).toBe(0);
    expect(res.signal).toBeNull();
    expect(res.timedOut).toBe(false);
    expect(res.aborted).toBe(false);
    expect(lines).toEqual(['one', 'two', 'three']);
    expect(res.stdout).toBe('one\ntwo\r\nthree');
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('captures stderr lines separately', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const res = await runProcess(
      nodeScript(`console.error('warn1'); console.error('warn2'); console.log('ok');`, {
        onStdoutLine: (l) => out.push(l),
        onStderrLine: (l) => err.push(l),
      }),
    );
    expect(res.code).toBe(0);
    expect(out).toEqual(['ok']);
    expect(err).toEqual(['warn1', 'warn2']);
    expect(res.stderr).toBe('warn1\nwarn2\n');
  });

  it('never throws on non-zero exit', async () => {
    const res = await runProcess(nodeScript(`console.error('bad'); process.exit(3);`));
    expect(res.code).toBe(3);
    expect(res.stderr.trim()).toBe('bad');
  });

  it('feeds stdin to the child and honours cwd', async () => {
    const res = await runProcess(
      nodeScript(
        `let d='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{process.stdout.write(d.toUpperCase()+'|'+process.cwd())});`,
        { stdin: 'hello stdin', cwd: fs.realpathSync(tmp) },
      ),
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('HELLO STDIN|' + fs.realpathSync(tmp));
  });

  it('closes stdin when none is given so the child does not hang', async () => {
    const res = await runProcess(
      nodeScript(`process.stdin.on('end',()=>process.stdout.write('eof'));process.stdin.resume();`),
    );
    expect(res.stdout).toBe('eof');
  });

  it('passes the given env only', async () => {
    const res = await runProcess(
      nodeScript(`process.stdout.write(String(process.env.SUBPOOL_TEST_VAR)+'|'+String(process.env.SUBPOOL_MISSING))`, {
        env: { PATH: process.env.PATH ?? '', SUBPOOL_TEST_VAR: 'yes' },
      }),
    );
    expect(res.stdout).toBe('yes|undefined');
  });

  it('times out and kills the child with SIGTERM', async () => {
    const res = await runProcess(nodeScript(`process.stdout.write('started\\n'); setTimeout(()=>{}, 30000);`, { timeoutMs: 300 }));
    expect(res.timedOut).toBe(true);
    expect(res.aborted).toBe(false);
    expect(res.code).toBeNull();
    expect(res.signal).toBe('SIGTERM');
    expect(res.stdout).toBe('started\n');
    expect(res.durationMs).toBeLessThan(5000);
  });

  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    const res = await runProcess(
      nodeScript(`process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000);`, { timeoutMs: 200, killGraceMs: 300 }),
    );
    expect(res.timedOut).toBe(true);
    expect(res.signal).toBe('SIGKILL');
    expect(res.durationMs).toBeLessThan(5000);
  });

  it('honours an AbortSignal', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const res = await runProcess(nodeScript(`setTimeout(()=>{}, 30000);`, { signal: ac.signal }));
    expect(res.aborted).toBe(true);
    expect(res.timedOut).toBe(false);
    expect(res.signal).toBe('SIGTERM');
  });

  it('kills immediately when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const res = await runProcess(nodeScript(`setTimeout(()=>{}, 30000);`, { signal: ac.signal }));
    expect(res.aborted).toBe(true);
    expect(res.code).toBeNull();
  });

  it('caps stdout keeping the tail', async () => {
    const res = await runProcess(
      nodeScript(`process.stdout.write('x'.repeat(5000) + 'TAIL')`, { maxBuffer: 100 }),
    );
    expect(res.stdout.length).toBe(100);
    expect(res.stdout.endsWith('TAIL')).toBe(true);
  });

  it('rejects with a readable error naming the binary on ENOENT', async () => {
    const missing = 'subpool-definitely-missing-binary-xyz';
    await expect(runProcess({ cmd: missing, args: [], cwd: os.tmpdir(), env: { ...process.env }, timeoutMs: 1000 })).rejects.toThrow(
      missing,
    );
    await expect(runProcess({ cmd: missing, args: [], cwd: os.tmpdir(), env: { ...process.env }, timeoutMs: 1000 })).rejects.toThrow(
      /ENOENT|not found/,
    );
  });

  it('rejects with a working-directory error when cwd is missing', async () => {
    const missing = path.join(tmp, 'nope');
    const err = await runProcess(nodeScript(`process.exit(0)`, { cwd: missing })).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err?.message).toBe(`working directory "${missing}" does not exist or is not a directory`);
  });

  it('settles after exit even when a grandchild keeps the stdio pipes open', async () => {
    const started = Date.now();
    const res = await runProcess(
      nodeScript(
        `const { spawn } = require('node:child_process'); process.stdout.write('parent\\n'); spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 2500)'], { stdio: 'inherit', detached: true }).unref(); process.exit(0);`,
        { killGraceMs: 200 },
      ),
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.code).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.stdout).toBe('parent\n');
  });

  it('keeps running when a line listener throws', async () => {
    const res = await runProcess(
      nodeScript(`console.log('a'); console.log('b');`, {
        onStdoutLine: () => {
          throw new Error('listener bug');
        },
      }),
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('a\nb\n');
  });

  it('runs with stdio inherit and returns only the exit code', async () => {
    const res = await runProcess(nodeScript(`process.exit(0)`, { stdio: 'inherit' }));
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toBe('');
  });
});

describe('runInteractive', () => {
  it('returns the exit code', async () => {
    expect(await runInteractive(node, ['-e', 'process.exit(4)'], { ...process.env }, os.tmpdir())).toBe(4);
    expect(await runInteractive(node, ['-e', 'process.exit(0)'], { ...process.env })).toBe(0);
  });

  it('rejects on ENOENT', async () => {
    await expect(runInteractive('subpool-missing-binary-abc', [], { ...process.env })).rejects.toThrow('subpool-missing-binary-abc');
  });
});
