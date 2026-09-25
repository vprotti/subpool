import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexHomeDefault } from '../core/paths.js';
import { readText, writeFileAtomic } from '../core/fsx.js';

export const SERVER_NAME = 'subpool';
export const CONFIG_FILE = 'config.toml';
export const DEFAULT_STARTUP_TIMEOUT_SEC = 30;
export const DEFAULT_TOOL_TIMEOUT_SEC = 3600;

export type TomlValue = string | number | string[];

const BARE_KEY_RE = /^[A-Za-z0-9_-]+$/;

export function tomlString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}`);
  return `"${escaped}"`;
}

export function tomlKey(name: string): string {
  return BARE_KEY_RE.test(name) ? name : tomlString(name);
}

export function tomlValue(value: TomlValue): string {
  if (typeof value === 'string') return tomlString(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`cannot render non-finite number as TOML: ${value}`);
    return String(value);
  }
  return `[${value.map(tomlString).join(', ')}]`;
}

export function renderMcpServerBlock(name: string, block: Record<string, TomlValue>): string[] {
  const lines = [`[mcp_servers.${tomlKey(name)}]`];
  for (const [key, value] of Object.entries(block)) lines.push(`${key} = ${tomlValue(value)}`);
  return lines;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function mcpServerHeaderRe(name: string): RegExp {
  const n = escapeRegExp(name);
  return new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:"${n}"|'${n}'|${n})\\s*\\]\\s*$`);
}

const ANY_HEADER_RE = /^\s*\[/;

export interface BlockRange {
  start: number;
  end: number;
  bodyEnd: number;
}

export function findMcpServerBlock(lines: string[], name: string): BlockRange | undefined {
  const headerRe = mcpServerHeaderRe(name);
  const start = lines.findIndex((line) => headerRe.test(line));
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length && !ANY_HEADER_RE.test(lines[end] ?? '')) end += 1;
  let bodyEnd = end;
  while (bodyEnd > start + 1 && (lines[bodyEnd - 1] ?? '').trim() === '') bodyEnd -= 1;
  return { start, end, bodyEnd };
}

export function upsertMcpServerBlock(toml: string, name: string, block: Record<string, TomlValue>): string {
  const rendered = renderMcpServerBlock(name, block);
  const lines = toml.split('\n');
  const range = findMcpServerBlock(lines, name);
  if (range) {
    const next = [...lines.slice(0, range.start), ...rendered, ...lines.slice(range.bodyEnd)];
    if (range.bodyEnd === lines.length) next.push('');
    return next.join('\n');
  }
  if (toml.length === 0) return `${rendered.join('\n')}\n`;
  let prefix = toml.endsWith('\n') ? toml : `${toml}\n`;
  if (!prefix.endsWith('\n\n')) prefix = `${prefix}\n`;
  return `${prefix}${rendered.join('\n')}\n`;
}

export function removeMcpServerBlock(toml: string, name: string): string {
  const lines = toml.split('\n');
  const range = findMcpServerBlock(lines, name);
  if (!range) return toml;
  const next = [...lines.slice(0, range.start), ...lines.slice(range.end)];
  if (range.end === lines.length) {
    while (next.length > 0 && (next[next.length - 1] ?? '').trim() === '') next.pop();
    if (next.length > 0) next.push('');
  }
  return next.join('\n');
}

export function serveBlock(opts: { command: string; args: string[]; toolTimeoutSec?: number }): Record<string, TomlValue> {
  return {
    command: opts.command,
    args: opts.args,
    startup_timeout_sec: DEFAULT_STARTUP_TIMEOUT_SEC,
    tool_timeout_sec: opts.toolTimeoutSec ?? DEFAULT_TOOL_TIMEOUT_SEC,
  };
}

export function codexConfigFile(codexHome?: string): string {
  return path.join(codexHome ?? codexHomeDefault(), CONFIG_FILE);
}

export async function installCodex(opts: {
  codexHome?: string;
  command: string;
  args: string[];
  toolTimeoutSec?: number;
}): Promise<{ file: string; changed: boolean }> {
  const file = codexConfigFile(opts.codexHome);
  const current = await readText(file);
  const next = upsertMcpServerBlock(current ?? '', SERVER_NAME, serveBlock(opts));
  if (current !== undefined && next === current) return { file, changed: false };
  await writeFileAtomic(file, next, 0o600);
  return { file, changed: true };
}

export async function uninstallCodex(opts: { codexHome?: string }): Promise<{ file: string; changed: boolean }> {
  const file = codexConfigFile(opts.codexHome);
  const current = await readText(file);
  if (current === undefined) return { file, changed: false };
  const next = removeMcpServerBlock(current, SERVER_NAME);
  if (next === current) return { file, changed: false };
  await writeFileAtomic(file, next, 0o600);
  return { file, changed: true };
}

export function cliPathFrom(moduleUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..', 'cli.js');
}

export function serveCommand(): { command: string; args: string[] } {
  return { command: process.execPath, args: [cliPathFrom(import.meta.url), 'serve'] };
}
