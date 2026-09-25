import os from 'node:os';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import type { ProviderId } from './types.js';

export interface Paths {
  home: string;
  config: string;
  ledger: string;
  state: string;
  jobs: string;
  profiles: string;
}

export function resolvePaths(home?: string): Paths {
  const base = home ?? process.env.SUBPOOL_HOME ?? path.join(os.homedir(), '.subpool');
  return {
    home: base,
    config: path.join(base, 'config.json'),
    ledger: path.join(base, 'usage.jsonl'),
    state: path.join(base, 'state.json'),
    jobs: path.join(base, 'jobs'),
    profiles: path.join(base, 'profiles'),
  };
}

export function profileDirFor(paths: Paths, provider: ProviderId, id: string): string {
  return path.join(paths.profiles, `${provider}-${id}`);
}

export function ensureDirs(paths: Paths): void {
  for (const dir of [paths.home, paths.jobs, paths.profiles]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export function codexHomeDefault(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
}

export function claudeConfigDirDefault(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
}
