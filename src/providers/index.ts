import type { ProviderAdapter, ProviderId } from '../core/types.js';
import { claudeProvider } from './claude.js';
import { codexProvider } from './codex.js';

export const providers: Record<ProviderId, ProviderAdapter> = {
  claude: claudeProvider,
  codex: codexProvider,
};

export function isProviderId(value: unknown): value is ProviderId {
  return value === 'claude' || value === 'codex';
}

export function getProvider(id: ProviderId): ProviderAdapter {
  const provider = providers[id];
  if (!provider) throw new Error(`unknown provider: ${String(id)}`);
  return provider;
}

export { claudeProvider, claudeArgs, parseClaudeStream } from './claude.js';
export { codexProvider, codexArgs, parseCodexEvents } from './codex.js';
