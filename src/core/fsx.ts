import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function isMissing(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

export function tempPathFor(file: string): string {
  return `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
}

export async function writeFileAtomic(file: string, data: string, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = tempPathFor(file);
  try {
    await fs.writeFile(tmp, data, { encoding: 'utf8', mode: mode ?? 0o644 });
    if (mode !== undefined) await fs.chmod(tmp, mode);
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if (isMissing(err)) return undefined;
    throw err;
  }
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  const text = await readText(file);
  if (text === undefined) return undefined;
  return JSON.parse(text) as T;
}

export async function readJsonOr<T>(file: string, fallback: T): Promise<T> {
  const value = await readJson<T>(file);
  return value === undefined ? fallback : value;
}

export async function appendLine(file: string, line: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.appendFile(file, line.endsWith('\n') ? line : `${line}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => l.length > 0);
}

export async function readLines(file: string): Promise<string[]> {
  const text = await readText(file);
  if (text === undefined) return [];
  return splitLines(text);
}

export function newId(prefix: string): string {
  const bytes = crypto.randomBytes(12);
  let out = '';
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return `${prefix}_${out}`;
}

export const LOCK_FILE = '.lock';
export const LOCK_STALE_MS = 30_000;
export const LOCK_TIMEOUT_MS = LOCK_STALE_MS + 5_000;
const LOCK_MIN_DELAY_MS = 10;
const LOCK_MAX_DELAY_MS = 200;

export interface LockOptions {
  staleMs?: number;
  timeoutMs?: number;
}

export function lockFileFor(home: string): string {
  return path.join(home, LOCK_FILE);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as NodeJS.ErrnoException).code : undefined;
}

async function breakStaleLock(file: string, staleMs: number, now: number): Promise<boolean> {
  let stat: { mtimeMs: number };
  try {
    stat = await fs.stat(file);
  } catch {
    return true;
  }
  if (now - stat.mtimeMs <= staleMs) return false;
  const moved = `${file}.stale.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  try {
    await fs.rename(file, moved);
  } catch {
    return true;
  }
  await fs.rm(moved, { force: true }).catch(() => undefined);
  return true;
}

async function acquireLock(file: string, opts: LockOptions): Promise<fs.FileHandle> {
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const timeoutMs = opts.timeoutMs ?? LOCK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let delay = LOCK_MIN_DELAY_MS;
  for (;;) {
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n`).catch(() => undefined);
      return handle;
    } catch (err) {
      if (errCode(err) !== 'EEXIST') throw err;
    }
    if (await breakStaleLock(file, staleMs, Date.now())) continue;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for lock ${file}`);
    await sleep(delay + Math.floor(Math.random() * delay));
    delay = Math.min(delay * 2, LOCK_MAX_DELAY_MS);
  }
}

export async function withLock<T>(home: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const file = lockFileFor(home);
  const handle = await acquireLock(file, opts);
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => undefined);
    await fs.rm(file, { force: true }).catch(() => undefined);
  }
}
