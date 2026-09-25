import { describe, expect, it } from 'vitest';
import { WINDOW_7D_MS } from '../src/core/types.js';
import {
  MAX_COOLDOWN_MS,
  MAX_EPOCH_AHEAD_MS,
  cooldownFor,
  detectLimit,
  excerptFor,
  isRetryable,
  matchSignal,
  parseClockReset,
  parseDurationMs,
  parseResetAt,
} from '../src/core/limits.js';

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('detectLimit (claude)', () => {
  it.each([
    'Usage limit reached · resets 4pm',
    "You've reached your weekly usage limit",
    'You have hit the 5-hour usage limit',
    '{"type":"error","error":{"type":"rate_limit_error","message":"..."}}',
    'Request was rate limited',
    'HTTP 429 Too Many Requests',
  ])('flags %s as rate', (text) => {
    const limit = detectLimit('claude', text);
    expect(limit?.kind).toBe('rate');
    expect(limit?.message.length).toBeGreaterThan(0);
  });

  it.each([
    'Please run /login',
    'Invalid API key · Fix external API key',
    'Error: Not logged in',
    '{"error":{"type":"authentication_error"}}',
    'API error 401',
  ])('flags %s as auth', (text) => {
    expect(detectLimit('claude', text)?.kind).toBe('auth');
  });

  it.each(['{"error":{"type":"overloaded_error"}}', 'upstream returned 529'])('flags %s as overloaded', (text) => {
    expect(detectLimit('claude', text)?.kind).toBe('overloaded');
  });

  it('uses apiStatus 429 even when the text says nothing', () => {
    expect(detectLimit('claude', 'boom', 429)?.kind).toBe('rate');
    expect(detectLimit('claude', '', 429)?.message).toContain('429');
  });

  it('uses apiStatus 401 / 503 / 529', () => {
    expect(detectLimit('claude', 'x', 401)?.kind).toBe('auth');
    expect(detectLimit('claude', 'x', 503)?.kind).toBe('overloaded');
    expect(detectLimit('claude', 'x', 529)?.kind).toBe('overloaded');
  });

  it('does not classify 403 or 502 on status alone', () => {
    expect(detectLimit('claude', '', 403)).toBeUndefined();
    expect(detectLimit('claude', 'model not enabled for this organization', 403)).toBeUndefined();
    expect(detectLimit('claude', '', 502)).toBeUndefined();
    expect(detectLimit('codex', '', 403)).toBeUndefined();
    expect(detectLimit('claude', 'please run /login', 403)?.kind).toBe('auth');
  });

  it('ignores the "Retrying in N seconds" progress line when picking the reset time', () => {
    const limit = detectLimit('claude', 'API Error: 429 rate_limit_error\nRetrying in 1 seconds… (attempt 1/10)');
    expect(limit?.kind).toBe('rate');
    expect(limit?.resetAt).toBeUndefined();
    expect(cooldownFor(limit!, NOW, 1800)).toBe(NOW + 1800 * 1000);
    const withReset = detectLimit('claude', 'Retrying in 2 seconds… (attempt 3/10)\nAPI Error: 429 rate_limit_error · resets in 3h 20m');
    expect(withReset?.resetAt).toBeGreaterThan(Date.now() + 3 * HOUR + 19 * 60_000);
    expect(parseResetAt('Retrying in 1 seconds', NOW)).toBeUndefined();
    expect(parseResetAt('retry in 20 seconds', NOW)).toBe(NOW + 20_000);
  });

  it('prefers the reset stated on the matching line over one elsewhere in the body', () => {
    const near = Math.floor((Date.now() + HOUR) / 1000);
    const far = Math.floor((Date.now() + 5 * HOUR) / 1000);
    const limit = detectLimit('claude', `some other limit|${far}\nClaude AI usage limit reached|${near}`);
    expect(limit?.resetAt).toBe(near * 1000);
  });

  it('returns undefined for ordinary text and null status', () => {
    expect(detectLimit('claude', 'All tests pass, 3 files changed.', null)).toBeUndefined();
    expect(detectLimit('claude', '', undefined)).toBeUndefined();
    expect(detectLimit('claude', 'compiled 14290 modules in 4013 ms', 200)).toBeUndefined();
  });

  it('prefers rate over auth over overloaded', () => {
    const both = detectLimit('claude', '429 too many requests, please run /login and overloaded_error');
    expect(both?.kind).toBe('rate');
    const authOver = detectLimit('claude', 'Not logged in; overloaded_error');
    expect(authOver?.kind).toBe('auth');
    expect(detectLimit('claude', 'please run /login', 429)?.kind).toBe('rate');
  });

  it('attaches resetAt from a |epoch suffix when it is in the future', () => {
    const epoch = Math.floor((Date.now() + 2 * HOUR) / 1000);
    const limit = detectLimit('claude', `Usage limit reached|${epoch}`);
    expect(limit?.kind).toBe('rate');
    expect(limit?.resetAt).toBe(epoch * 1000);
  });

  it('picks the matching line as the message and keeps it one line', () => {
    const limit = detectLimit('claude', 'first line\nsecond: rate_limit_error here\nthird');
    expect(limit?.message).toBe('second: rate_limit_error here');
    expect(limit?.message).not.toContain('\n');
  });
});

describe('detectLimit (codex)', () => {
  it.each([
    '{"type":"error","message":"usage_limit_exceeded"}',
    "You've hit your usage limit. Try again in 2 hours 5 minutes.",
    'usage limit reached for this plan',
    'rate limit exceeded',
    'Too Many Requests',
    'status 429',
  ])('flags %s as rate', (text) => {
    expect(detectLimit('codex', text)?.kind).toBe('rate');
  });

  it.each(['401 Unauthorized', 'Missing bearer token', 'Not logged in', 'run codex login first'])(
    'flags %s as auth',
    (text) => {
      expect(detectLimit('codex', text)?.kind).toBe('auth');
    },
  );

  it.each(['server overloaded', 'HTTP 503', 'status 529'])('flags %s as overloaded', (text) => {
    expect(detectLimit('codex', text)?.kind).toBe('overloaded');
  });

  it('does not treat "logged" or "login" inside other words as auth', () => {
    expect(detectLimit('codex', 'user logged the results in loginfo.txt')).toBeUndefined();
  });

  it('rate beats auth for a 429 that mentions login', () => {
    expect(detectLimit('codex', '429 too many requests; login again')?.kind).toBe('rate');
  });

  it('attaches resetAt from resets_in_seconds', () => {
    const limit = detectLimit('codex', '{"error":{"message":"usage_limit_exceeded","resets_in_seconds":900}}');
    expect(limit?.kind).toBe('rate');
    expect(limit?.resetAt).toBeGreaterThan(Date.now() + 890_000);
    expect(limit?.resetAt).toBeLessThanOrEqual(Date.now() + 900_000);
  });
});

describe('matchSignal / excerptFor', () => {
  it('matches strings case-insensitively and regexes with word boundaries', () => {
    expect(matchSignal('RATE LIMITED', ['rate limited'])).toBe('rate limited');
    expect(matchSignal('code 4290', [/\b429\b/])).toBeUndefined();
    expect(matchSignal('code 429.', [/\b429\b/])).toBe('429');
    expect(matchSignal('', ['x'])).toBeUndefined();
  });

  it('collapses whitespace and truncates long lines', () => {
    const long = 'a'.repeat(500) + ' rate limited';
    const msg = excerptFor(long, 'rate limited');
    expect(msg.length).toBeLessThanOrEqual(240);
    expect(excerptFor('  hello \t world  \n', undefined)).toBe('hello world');
    expect(excerptFor('\n\n', undefined)).toBe('');
  });
});

describe('parseResetAt', () => {
  it('parses a 10-digit epoch after a pipe', () => {
    const epoch = Math.floor(NOW / 1000) + 3600;
    expect(parseResetAt(`limit reached|${epoch}`, NOW)).toBe(epoch * 1000);
  });

  it('parses a 13-digit epoch after a pipe', () => {
    const ms = NOW + 90 * 60 * 1000;
    expect(parseResetAt(`limit reached | ${ms}`, NOW)).toBe(ms);
  });

  it('ignores an epoch more than a day in the past', () => {
    const old = Math.floor((NOW - 2 * DAY) / 1000);
    expect(parseResetAt(`limit reached|${old}`, NOW)).toBeUndefined();
    expect(parseResetAt(`"resets_at":${old}`, NOW)).toBeUndefined();
  });

  it('keeps an epoch that is less than a day in the past', () => {
    const recent = Math.floor((NOW - 2 * HOUR) / 1000);
    expect(parseResetAt(`limit reached|${recent}`, NOW)).toBe(recent * 1000);
  });

  it('rejects epochs more than 30 days ahead', () => {
    expect(MAX_EPOCH_AHEAD_MS).toBe(30 * DAY);
    expect(parseResetAt('limit reached|9999999999999', NOW)).toBeUndefined();
    expect(parseResetAt('limit reached|4102444800', NOW)).toBeUndefined();
    expect(parseResetAt(`"resets_at":${Math.floor((NOW + 31 * DAY) / 1000)}`, NOW)).toBeUndefined();
    const ok = Math.floor((NOW + 29 * DAY) / 1000);
    expect(parseResetAt(`limit reached|${ok}`, NOW)).toBe(ok * 1000);
  });

  it('parses resets_in_seconds', () => {
    expect(parseResetAt('{"resets_in_seconds":1500}', NOW)).toBe(NOW + 1_500_000);
    expect(parseResetAt('resets_in_seconds": 30', NOW)).toBe(NOW + 30_000);
  });

  it('parses resets_at epoch in seconds or milliseconds', () => {
    const secs = Math.floor(NOW / 1000) + 7200;
    expect(parseResetAt(`{"resets_at":${secs}}`, NOW)).toBe(secs * 1000);
    expect(parseResetAt(`{"resets_at":"${secs}"}`, NOW)).toBe(secs * 1000);
    expect(parseResetAt(`"resets_at": ${NOW + 5000}`, NOW)).toBe(NOW + 5000);
  });

  it('parses "try again in Xh Ym Zs" style durations', () => {
    expect(parseResetAt('Try again in 2h 5m 10s.', NOW)).toBe(NOW + 2 * HOUR + 5 * 60_000 + 10_000);
    expect(parseResetAt('try again in 2 hours 5 minutes', NOW)).toBe(NOW + 2 * HOUR + 5 * 60_000);
    expect(parseResetAt('Try again in 1 hour and 30 minutes', NOW)).toBe(NOW + 90 * 60_000);
  });

  it('parses "resets in ..." and "in X minutes/hours/seconds"', () => {
    expect(parseResetAt('Your limit resets in 3h 20m', NOW)).toBe(NOW + 3 * HOUR + 20 * 60_000);
    expect(parseResetAt('quota resets in 45 minutes', NOW)).toBe(NOW + 45 * 60_000);
    expect(parseResetAt('retry in 20 seconds', NOW)).toBe(NOW + 20_000);
    expect(parseResetAt('available again in 4 hours', NOW)).toBe(NOW + 4 * HOUR);
    expect(parseResetAt('in 90 sec', NOW)).toBe(NOW + 90_000);
  });

  it('parses "resets at 4pm" as the next occurrence of that local time', () => {
    const at = parseResetAt('Usage limit reached · resets at 4pm', NOW);
    expect(at).toBeDefined();
    expect(at!).toBeGreaterThan(NOW);
    expect(at! - NOW).toBeLessThanOrEqual(DAY);
    const d = new Date(at!);
    expect(d.getHours()).toBe(16);
    expect(d.getMinutes()).toBe(0);
  });

  it('parses "resets at 9:30am" and 24h "resets at 16:00"', () => {
    const am = parseClockReset('resets at 9:30am', NOW);
    expect(new Date(am!).getHours()).toBe(9);
    expect(new Date(am!).getMinutes()).toBe(30);
    const h24 = parseClockReset('resets at 16:00', NOW);
    expect(new Date(h24!).getHours()).toBe(16);
    expect(parseClockReset('resets at 7', NOW)).toBeUndefined();
    expect(parseClockReset('resets at 25:00', NOW)).toBeUndefined();
  });

  it('returns undefined when nothing matches', () => {
    expect(parseResetAt('', NOW)).toBeUndefined();
    expect(parseResetAt('done in 3 files', NOW)).toBeUndefined();
    expect(parseResetAt('finished at 12345', NOW)).toBeUndefined();
    expect(parseResetAt('rate limited', NOW)).toBeUndefined();
  });

  it('prefers explicit epochs over relative durations', () => {
    const secs = Math.floor(NOW / 1000) + 600;
    expect(parseResetAt(`try again in 5 minutes|${secs}`, NOW)).toBe(secs * 1000);
  });
});

describe('parseDurationMs', () => {
  it('sums mixed units and ignores unrelated numbers', () => {
    expect(parseDurationMs('in 1h 2m 3s')).toBe(HOUR + 2 * 60_000 + 3000);
    expect(parseDurationMs('in 1.5 hours')).toBe(90 * 60_000);
    expect(parseDurationMs('took 3 files')).toBeUndefined();
    expect(parseDurationMs('in 10 files')).toBeUndefined();
  });
});

describe('isRetryable / cooldownFor', () => {
  it('is retryable for every limit kind and false for none', () => {
    expect(isRetryable({ kind: 'rate', message: '' })).toBe(true);
    expect(isRetryable({ kind: 'auth', message: '' })).toBe(true);
    expect(isRetryable({ kind: 'overloaded', message: '' })).toBe(true);
    expect(isRetryable(undefined)).toBe(false);
  });

  it('cooldown uses resetAt for rate limits when present', () => {
    expect(cooldownFor({ kind: 'rate', message: '', resetAt: NOW + 123 }, NOW, 1800)).toBe(NOW + 123);
    expect(cooldownFor({ kind: 'rate', message: '' }, NOW, 1800)).toBe(NOW + 1800 * 1000);
  });

  it('cooldown is 2 minutes for overloaded and 6 hours for auth', () => {
    expect(cooldownFor({ kind: 'overloaded', message: '', resetAt: NOW + 999 }, NOW, 1800)).toBe(NOW + 120_000);
    expect(cooldownFor({ kind: 'auth', message: '' }, NOW, 1800)).toBe(NOW + 6 * HOUR);
  });

  it('caps a rate cooldown at 7 days and never sets it in the past', () => {
    expect(MAX_COOLDOWN_MS).toBe(WINDOW_7D_MS);
    expect(cooldownFor({ kind: 'rate', message: '', resetAt: 9999999999999 }, NOW, 1800)).toBe(NOW + WINDOW_7D_MS);
    expect(cooldownFor({ kind: 'rate', message: '', resetAt: NOW + 999_999 * HOUR }, NOW, 1800)).toBe(NOW + WINDOW_7D_MS);
    expect(cooldownFor({ kind: 'rate', message: '', resetAt: NOW - 5000 }, NOW, 1800)).toBe(NOW);
    expect(cooldownFor({ kind: 'rate', message: '', resetAt: Number.NaN }, NOW, 60)).toBe(NOW + 60_000);
  });
});
