import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LOCK_FILE,
  lockFileFor,
  writeFileAtomic,
  readJson,
  readJsonOr,
  appendLine,
  readLines,
  newId,
  splitLines,
  tempPathFor,
  withLock,
} from '../src/core/fsx.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'subpool-fsx-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  it('creates parent dirs, writes the content and leaves no temp file', async () => {
    const file = path.join(dir, 'nested', 'deeper', 'data.json');
    await writeFileAtomic(file, '{"a":1}', 0o600);
    expect(await fs.readFile(file, 'utf8')).toBe('{"a":1}');
    const entries = await fs.readdir(path.dirname(file));
    expect(entries).toEqual(['data.json']);
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false);
  });

  it('applies the requested mode', async () => {
    const file = path.join(dir, 'secret');
    await writeFileAtomic(file, 'x', 0o600);
    const stat = await fs.stat(file);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('replaces an existing file completely', async () => {
    const file = path.join(dir, 'f.txt');
    await writeFileAtomic(file, 'a long first version');
    await writeFileAtomic(file, 'short');
    expect(await fs.readFile(file, 'utf8')).toBe('short');
    expect(await fs.readdir(dir)).toEqual(['f.txt']);
  });

  it('cleans up the temp file when the write cannot complete', async () => {
    const blocker = path.join(dir, 'blocker');
    await fs.mkdir(blocker);
    await fs.writeFile(path.join(blocker, 'x'), '1');
    await expect(writeFileAtomic(blocker, 'data')).rejects.toThrow();
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });

  it('tempPathFor lives next to the target and ends with .tmp', () => {
    const tmp = tempPathFor(path.join(dir, 'cfg.json'));
    expect(path.dirname(tmp)).toBe(dir);
    expect(tmp.startsWith(path.join(dir, 'cfg.json.'))).toBe(true);
    expect(tmp.endsWith('.tmp')).toBe(true);
  });
});

describe('readJson / readJsonOr', () => {
  it('returns undefined for a missing file', async () => {
    expect(await readJson(path.join(dir, 'missing.json'))).toBeUndefined();
  });

  it('returns the fallback for a missing file', async () => {
    expect(await readJsonOr(path.join(dir, 'missing.json'), { ok: true })).toEqual({ ok: true });
  });

  it('parses an existing file', async () => {
    const file = path.join(dir, 'x.json');
    await fs.writeFile(file, JSON.stringify({ n: 2, list: [1, 2] }));
    expect(await readJson<{ n: number; list: number[] }>(file)).toEqual({ n: 2, list: [1, 2] });
    expect(await readJsonOr(file, { n: 0, list: [] })).toEqual({ n: 2, list: [1, 2] });
  });

  it('throws on invalid JSON', async () => {
    const file = path.join(dir, 'bad.json');
    await fs.writeFile(file, '{not json');
    await expect(readJson(file)).rejects.toThrow();
  });

  it('rethrows non-ENOENT errors', async () => {
    await expect(readJson(dir)).rejects.toThrow();
  });
});

describe('appendLine / readLines', () => {
  it('readLines returns [] for a missing file', async () => {
    expect(await readLines(path.join(dir, 'none.jsonl'))).toEqual([]);
  });

  it('appendLine creates the file and parent dirs when missing', async () => {
    const file = path.join(dir, 'sub', 'usage.jsonl');
    await appendLine(file, '{"t":1}');
    await appendLine(file, '{"t":2}\n');
    await appendLine(file, '{"t":3}');
    expect(await fs.readFile(file, 'utf8')).toBe('{"t":1}\n{"t":2}\n{"t":3}\n');
    expect(await readLines(file)).toEqual(['{"t":1}', '{"t":2}', '{"t":3}']);
  });

  it('splitLines drops empty lines and handles CRLF', () => {
    expect(splitLines('a\r\nb\n\nc\n')).toEqual(['a', 'b', 'c']);
    expect(splitLines('')).toEqual([]);
  });
});

describe('withLock', () => {
  it('serializes critical sections that share a home and removes the lock file afterwards', async () => {
    const home = path.join(dir, 'home');
    const order: string[] = [];
    let inside = 0;
    let overlap = false;
    const section = (name: string, ms: number) =>
      withLock(home, async () => {
        inside += 1;
        if (inside > 1) overlap = true;
        order.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`${name}:end`);
        inside -= 1;
        return name;
      });
    const results = await Promise.all([section('a', 40), section('b', 10), section('c', 10)]);
    expect(results.sort()).toEqual(['a', 'b', 'c']);
    expect(overlap).toBe(false);
    for (let i = 0; i < order.length; i += 2) expect(order[i]?.replace(':start', '')).toBe(order[i + 1]?.replace(':end', ''));
    expect(await fs.readdir(home)).toEqual([]);
    expect(lockFileFor(home)).toBe(path.join(home, LOCK_FILE));
  });

  it('releases the lock when the section throws', async () => {
    await expect(
      withLock(dir, async () => {
        throw new Error('inner');
      }),
    ).rejects.toThrow('inner');
    expect((await fs.readdir(dir)).includes(LOCK_FILE)).toBe(false);
    expect(await withLock(dir, async () => 42)).toBe(42);
  });

  it('breaks a stale lock but times out on a fresh one', async () => {
    const file = lockFileFor(dir);
    await fs.writeFile(file, '12345\n');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(file, old, old);
    expect(await withLock(dir, async () => 'ok', { staleMs: 30_000, timeoutMs: 500 })).toBe('ok');
    expect((await fs.readdir(dir)).filter((f) => f.startsWith(LOCK_FILE))).toEqual([]);
    await fs.writeFile(file, '12345\n');
    const started = Date.now();
    await expect(withLock(dir, async () => 'never', { staleMs: 60_000, timeoutMs: 150 })).rejects.toThrow(/timed out waiting for lock/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(Date.now() - started).toBeLessThan(2000);
    await fs.rm(file);
  });
});

describe('newId', () => {
  it('produces prefix_ plus 12 base36 chars', () => {
    const id = newId('job');
    expect(id).toMatch(/^job_[0-9a-z]{12}$/);
  });

  it('is unique across many calls', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId('x')));
    expect(ids.size).toBe(500);
  });
});
