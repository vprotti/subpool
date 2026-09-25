import type { Limit, LimitKind, ProviderId } from './types.js';
import { WINDOW_7D_MS } from './types.js';

export type Signal = string | RegExp;

export const RATE_SIGNALS: Record<ProviderId, Signal[]> = {
  claude: [
    'usage limit reached',
    'reached your weekly usage limit',
    '5-hour usage limit',
    'rate_limit_error',
    'rate limited',
    'too many requests',
    /\b429\b/,
  ],
  codex: [
    'usage_limit_exceeded',
    'usage limit',
    'hit your usage limit',
    'rate limit',
    'too many requests',
    /\b429\b/,
  ],
};

export const AUTH_SIGNALS: Record<ProviderId, Signal[]> = {
  claude: ['please run /login', 'invalid api key', 'not logged in', 'authentication_error', /\b401\b/],
  codex: ['unauthorized', 'missing bearer', 'not logged in', /\blogin\b/, /\b401\b/],
};

export const OVERLOADED_SIGNALS: Record<ProviderId, Signal[]> = {
  claude: ['overloaded_error', /\b529\b/],
  codex: ['overloaded', /\b503\b/, /\b529\b/],
};

const RATE_STATUSES = new Set([429]);
const AUTH_STATUSES = new Set([401]);
const OVERLOADED_STATUSES = new Set([503, 529]);

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MAX_MESSAGE = 240;
export const MAX_EPOCH_AHEAD_MS = 30 * DAY_MS;
export const MAX_COOLDOWN_MS = WINDOW_7D_MS;

export function matchSignal(text: string, signals: Signal[]): string | undefined {
  const lower = text.toLowerCase();
  for (const signal of signals) {
    if (typeof signal === 'string') {
      if (lower.includes(signal.toLowerCase())) return signal;
    } else {
      const m = new RegExp(signal.source, signal.flags.includes('i') ? signal.flags : signal.flags + 'i').exec(text);
      if (m) return m[0];
    }
  }
  return undefined;
}

export function excerptFor(text: string, matched: string | undefined): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0);
  let line = lines[0] ?? '';
  if (matched) {
    const needle = matched.toLowerCase();
    const hit = lines.find((l) => l.toLowerCase().includes(needle));
    if (hit) line = hit;
  }
  return line.length > MAX_MESSAGE ? line.slice(0, MAX_MESSAGE - 1) + '…' : line;
}

export function detectLimit(provider: ProviderId, text: string, apiStatus?: number | null): Limit | undefined {
  const status = typeof apiStatus === 'number' ? apiStatus : undefined;
  const body = text ?? '';
  let kind: LimitKind | undefined;
  let matched: string | undefined;

  const rate = matchSignal(body, RATE_SIGNALS[provider]);
  const auth = matchSignal(body, AUTH_SIGNALS[provider]);
  const over = matchSignal(body, OVERLOADED_SIGNALS[provider]);

  if (rate !== undefined || (status !== undefined && RATE_STATUSES.has(status))) {
    kind = 'rate';
    matched = rate;
  } else if (auth !== undefined || (status !== undefined && AUTH_STATUSES.has(status))) {
    kind = 'auth';
    matched = auth;
  } else if (over !== undefined || (status !== undefined && OVERLOADED_STATUSES.has(status))) {
    kind = 'overloaded';
    matched = over;
  }
  if (!kind) return undefined;

  let message = excerptFor(body, matched);
  if (!message) message = status !== undefined ? `${kind} (http ${status})` : kind;
  const limit: Limit = { kind, message };
  if (kind === 'rate') {
    const now = Date.now();
    const resetAt = parseResetAt(excerptFor(body, matched), now) ?? parseResetAt(body, now);
    if (resetAt !== undefined) limit.resetAt = resetAt;
  }
  return limit;
}

function epochToMs(raw: string): number | undefined {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

function acceptEpoch(ms: number | undefined, now: number): number | undefined {
  if (ms === undefined) return undefined;
  if (ms < now - DAY_MS) return undefined;
  if (ms > now + MAX_EPOCH_AHEAD_MS) return undefined;
  return ms;
}

const UNIT_MS: Record<string, number> = {
  h: HOUR_MS,
  hr: HOUR_MS,
  hrs: HOUR_MS,
  hour: HOUR_MS,
  hours: HOUR_MS,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
};

const UNIT_RE = '(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)';
const DURATION_PART = `\\d+(?:\\.\\d+)?\\s*${UNIT_RE}\\b`;
const DURATION_RE = new RegExp(
  `(?<!retry(?:ing)?\\s)\\b(?:try again in|retry in|resets? in|reset in|available in|in)\\s+((?:${DURATION_PART}[\\s,]*(?:and\\s+)?)+)`,
  'i',
);
const PART_RE = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNIT_RE})\\b`, 'gi');

export function parseDurationMs(text: string): number | undefined {
  const m = DURATION_RE.exec(text);
  if (!m || m[1] === undefined) return undefined;
  let total = 0;
  let found = false;
  for (const part of m[1].matchAll(PART_RE)) {
    const value = Number(part[1]);
    const unit = (part[2] ?? '').toLowerCase();
    const mult = UNIT_MS[unit];
    if (mult === undefined || !Number.isFinite(value)) continue;
    total += value * mult;
    found = true;
  }
  return found ? Math.round(total) : undefined;
}

const CLOCK_RE = /\bresets?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;

export function parseClockReset(text: string, now: number): number | undefined {
  const m = CLOCK_RE.exec(text);
  if (!m || m[1] === undefined) return undefined;
  let hour = Number(m[1]);
  const minute = m[2] !== undefined ? Number(m[2]) : 0;
  const meridiem = m[3]?.toLowerCase();
  if (!meridiem && m[2] === undefined) return undefined;
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return undefined;
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  let at = d.getTime();
  if (at <= now) at += DAY_MS;
  return at;
}

export function parseResetAt(text: string, now: number): number | undefined {
  if (!text) return undefined;

  const pipe = /\|\s*(\d{13}|\d{10})(?!\d)/.exec(text);
  if (pipe?.[1]) {
    const at = acceptEpoch(epochToMs(pipe[1]), now);
    if (at !== undefined) return at;
  }

  const resetsAt = /resets?_at"?\s*[:=]\s*"?(\d{10,13}(?:\.\d+)?)/i.exec(text);
  if (resetsAt?.[1]) {
    const at = acceptEpoch(epochToMs(resetsAt[1]), now);
    if (at !== undefined) return at;
  }

  const resetsIn = /resets?_in_seconds"?\s*[:=]\s*"?(\d+(?:\.\d+)?)/i.exec(text);
  if (resetsIn?.[1]) {
    const secs = Number(resetsIn[1]);
    if (Number.isFinite(secs) && secs >= 0) return now + Math.round(secs * 1000);
  }

  const duration = parseDurationMs(text);
  if (duration !== undefined) return now + duration;

  return parseClockReset(text, now);
}

export function isRetryable(limit: Limit | undefined): boolean {
  if (!limit) return false;
  return limit.kind === 'rate' || limit.kind === 'auth' || limit.kind === 'overloaded';
}

export function cooldownFor(limit: Limit, now: number, defaultSec: number): number {
  switch (limit.kind) {
    case 'rate': {
      const fallback = now + defaultSec * 1000;
      const at = typeof limit.resetAt === 'number' && Number.isFinite(limit.resetAt) ? limit.resetAt : fallback;
      return Math.min(Math.max(at, now), now + MAX_COOLDOWN_MS);
    }
    case 'overloaded':
      return now + 120_000;
    case 'auth':
      return now + 6 * HOUR_MS;
  }
}
