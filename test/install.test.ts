import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cliPathFrom,
  findMcpServerBlock,
  installCodex,
  mcpServerHeaderRe,
  removeMcpServerBlock,
  renderMcpServerBlock,
  serveBlock,
  serveCommand,
  tomlKey,
  tomlString,
  tomlValue,
  uninstallCodex,
  upsertMcpServerBlock,
} from '../src/install/codex.js';
import {
  claudeMcpAddArgs,
  claudeMcpRemoveArgs,
  execOutput,
  installClaude,
  uninstallClaude,
} from '../src/install/claude.js';

const block = {
  command: '/usr/bin/node',
  args: ['/opt/subpool/dist/cli.js', 'serve'],
  startup_timeout_sec: 30,
  tool_timeout_sec: 3600,
};

const expectedBlock = [
  '[mcp_servers.subpool]',
  'command = "/usr/bin/node"',
  'args = ["/opt/subpool/dist/cli.js", "serve"]',
  'startup_timeout_sec = 30',
  'tool_timeout_sec = 3600',
].join('\n');

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'subpool-install-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('toml rendering', () => {
  it('escapes backslashes, quotes and control characters in strings', () => {
    expect(tomlString('C:\\Users\\me')).toBe('"C:\\\\Users\\\\me"');
    expect(tomlString('say "hi"')).toBe('"say \\"hi\\""');
    expect(tomlString('a\nb\tc')).toBe('"a\\nb\\tc"');
    expect(tomlString('a\u0000b\u0007c\u001bd\u007fe\u000bf')).toBe('"a\\u0000b\\u0007c\\u001Bd\\u007Fe\\u000Bf"');
    expect(tomlString('café')).toBe('"café"');
  });

  it('renders non-bare server names as quoted keys', () => {
    expect(tomlKey('subpool')).toBe('subpool');
    expect(tomlKey('my-server_2')).toBe('my-server_2');
    expect(tomlKey('a.b')).toBe('"a.b"');
    expect(tomlKey('with space')).toBe('"with space"');
    expect(renderMcpServerBlock('a.b', { command: 'c' })).toEqual(['[mcp_servers."a.b"]', 'command = "c"']);
    expect(mcpServerHeaderRe('a.b').test('[mcp_servers."a.b"]')).toBe(true);
  });

  it('renders integers, floats and string arrays', () => {
    expect(tomlValue(30)).toBe('30');
    expect(tomlValue(1.5)).toBe('1.5');
    expect(tomlValue([])).toBe('[]');
    expect(tomlValue(['a', 'b "c"'])).toBe('["a", "b \\"c\\""]');
    expect(() => tomlValue(Number.NaN)).toThrow();
  });

  it('renders the table header followed by one key per line', () => {
    expect(renderMcpServerBlock('subpool', block).join('\n')).toBe(expectedBlock);
  });

  it('matches bare and quoted table headers with surrounding whitespace', () => {
    const re = mcpServerHeaderRe('subpool');
    expect(re.test('[mcp_servers.subpool]')).toBe(true);
    expect(re.test('  [ mcp_servers . subpool ]  ')).toBe(true);
    expect(re.test('[mcp_servers."subpool"]\r')).toBe(true);
    expect(re.test('[mcp_servers.subpool2]')).toBe(false);
    expect(re.test('[mcp_servers.subpool.env]')).toBe(false);
    expect(re.test('[mcp_servers]')).toBe(false);
  });

  it('serveBlock fills the verified defaults', () => {
    expect(serveBlock({ command: 'node', args: ['x'] })).toEqual({
      command: 'node',
      args: ['x'],
      startup_timeout_sec: 30,
      tool_timeout_sec: 3600,
    });
    expect(serveBlock({ command: 'node', args: [], toolTimeoutSec: 60 }).tool_timeout_sec).toBe(60);
  });
});

describe('upsertMcpServerBlock', () => {
  it('creates the block on an empty file', () => {
    expect(upsertMcpServerBlock('', 'subpool', block)).toBe(`${expectedBlock}\n`);
  });

  it('appends after other tables with a leading blank line', () => {
    const toml = 'model = "gpt-5"\n\n[sandbox_workspace_write]\nnetwork_access = true\n';
    expect(upsertMcpServerBlock(toml, 'subpool', block)).toBe(`${toml}\n${expectedBlock}\n`);
  });

  it('appends after a file without a trailing newline', () => {
    const toml = 'model = "gpt-5"';
    expect(upsertMcpServerBlock(toml, 'subpool', block)).toBe(`model = "gpt-5"\n\n${expectedBlock}\n`);
  });

  it('does not add a second blank line when the file already ends with one', () => {
    const toml = 'model = "gpt-5"\n\n';
    expect(upsertMcpServerBlock(toml, 'subpool', block)).toBe(`model = "gpt-5"\n\n${expectedBlock}\n`);
  });

  it('replaces an existing block sitting between other tables and keeps everything else byte-for-byte', () => {
    const before = '# codex config\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\nargs = ["--x"]\n\n';
    const stale = '[mcp_servers.subpool]\ncommand = "old"\nargs = ["old.js"]\n# stale comment\n\n\n';
    const after = '[mcp_servers.other2]\ncommand = "o2"\n\n[projects."/home/me/x"]\ntrust_level = "trusted"\n';
    const result = upsertMcpServerBlock(before + stale + after, 'subpool', block);
    expect(result).toBe(`${before}${expectedBlock}\n\n\n${after}`);
    expect(result.startsWith(before)).toBe(true);
    expect(result.endsWith(after)).toBe(true);
  });

  it('replaces a block at EOF, with or without a trailing newline', () => {
    const before = '[a]\nx = 1\n\n';
    expect(upsertMcpServerBlock(`${before}[mcp_servers.subpool]\ncommand = "old"\n`, 'subpool', block)).toBe(
      `${before}${expectedBlock}\n`,
    );
    expect(upsertMcpServerBlock(`${before}[mcp_servers.subpool]\ncommand = "old"`, 'subpool', block)).toBe(
      `${before}${expectedBlock}\n`,
    );
  });

  it('leaves sub-tables of the same server untouched', () => {
    const toml = '[mcp_servers.subpool]\ncommand = "old"\n\n[mcp_servers.subpool.env]\nFOO = "bar"\n';
    expect(upsertMcpServerBlock(toml, 'subpool', block)).toBe(`${expectedBlock}\n\n[mcp_servers.subpool.env]\nFOO = "bar"\n`);
  });

  it('is idempotent', () => {
    const toml = '[a]\nx = 1\n\n[mcp_servers.subpool]\ncommand = "old"\n\n[b]\ny = 2\n';
    const once = upsertMcpServerBlock(toml, 'subpool', block);
    const twice = upsertMcpServerBlock(once, 'subpool', block);
    expect(twice).toBe(once);
    expect(upsertMcpServerBlock(twice, 'subpool', block)).toBe(once);
  });

  it('preserves CRLF lines outside the block', () => {
    const toml = 'model = "gpt-5"\r\n\r\n[mcp_servers.subpool]\r\ncommand = "old"\r\n\r\n[b]\r\ny = 2\r\n';
    const result = upsertMcpServerBlock(toml, 'subpool', block);
    expect(result.startsWith('model = "gpt-5"\r\n\r\n')).toBe(true);
    expect(result.endsWith('\r\n[b]\r\ny = 2\r\n')).toBe(true);
    expect(result).toContain(expectedBlock);
  });

  it('escapes regex metacharacters in the server name and quotes the rendered key', () => {
    const toml = '[mcp_servers.a.b]\nx = 1\n\n[mcp_servers.axb]\ncommand = "keep"\n';
    const result = upsertMcpServerBlock(toml, 'a.b', { command: 'new' });
    expect(result).toBe('[mcp_servers."a.b"]\ncommand = "new"\n\n[mcp_servers.axb]\ncommand = "keep"\n');
    expect(upsertMcpServerBlock(result, 'a.b', { command: 'new' })).toBe(result);
  });
});

describe('findMcpServerBlock', () => {
  it('reports header, body end and next header', () => {
    const lines = ['[a]', 'x = 1', '', '[mcp_servers.subpool]', 'command = "c"', '', '', '[b]', ''];
    expect(findMcpServerBlock(lines, 'subpool')).toEqual({ start: 3, end: 7, bodyEnd: 5 });
    expect(findMcpServerBlock(lines, 'nope')).toBeUndefined();
  });
});

describe('removeMcpServerBlock', () => {
  it('returns the input unchanged when the block is absent', () => {
    const toml = '[a]\nx = 1\n';
    expect(removeMcpServerBlock(toml, 'subpool')).toBe(toml);
  });

  it('removes a block in the middle and keeps the neighbours intact', () => {
    const toml = '[a]\nx = 1\n\n[mcp_servers.subpool]\ncommand = "c"\nargs = []\n\n[b]\ny = 2\n';
    expect(removeMcpServerBlock(toml, 'subpool')).toBe('[a]\nx = 1\n\n[b]\ny = 2\n');
  });

  it('removes a block at EOF without leaving trailing blank lines', () => {
    expect(removeMcpServerBlock('[a]\nx = 1\n\n[mcp_servers.subpool]\ncommand = "c"\n\n\n', 'subpool')).toBe('[a]\nx = 1\n');
    expect(removeMcpServerBlock('[mcp_servers.subpool]\ncommand = "c"\n', 'subpool')).toBe('');
  });

  it('round-trips with upsert', () => {
    const toml = '[a]\nx = 1\n';
    const added = upsertMcpServerBlock(toml, 'subpool', block);
    expect(removeMcpServerBlock(added, 'subpool')).toBe(toml);
  });
});

describe('installCodex / uninstallCodex', () => {
  it('creates the config dir and file with mode 0600 and reports changes', async () => {
    const codexHome = path.join(tmp, 'codex-home', 'nested');
    const first = await installCodex({ codexHome, command: '/usr/bin/node', args: ['/opt/subpool/dist/cli.js', 'serve'] });
    expect(first).toEqual({ file: path.join(codexHome, 'config.toml'), changed: true });
    expect(fs.readFileSync(first.file, 'utf8')).toBe(`${expectedBlock}\n`);
    if (process.platform !== 'win32') expect(fs.statSync(first.file).mode & 0o777).toBe(0o600);

    const second = await installCodex({ codexHome, command: '/usr/bin/node', args: ['/opt/subpool/dist/cli.js', 'serve'] });
    expect(second).toEqual({ file: first.file, changed: false });

    const third = await installCodex({ codexHome, command: '/usr/bin/node', args: ['/opt/subpool/dist/cli.js', 'serve'], toolTimeoutSec: 900 });
    expect(third.changed).toBe(true);
    expect(fs.readFileSync(first.file, 'utf8')).toContain('tool_timeout_sec = 900');
  });

  it('preserves existing content in an existing config.toml', async () => {
    const codexHome = path.join(tmp, 'codex');
    fs.mkdirSync(codexHome, { recursive: true });
    const file = path.join(codexHome, 'config.toml');
    const existing = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n';
    fs.writeFileSync(file, existing);
    const res = await installCodex({ codexHome, command: '/usr/bin/node', args: ['/opt/subpool/dist/cli.js', 'serve'] });
    expect(res.changed).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(`${existing}\n${expectedBlock}\n`);

    const removed = await uninstallCodex({ codexHome });
    expect(removed).toEqual({ file, changed: true });
    expect(fs.readFileSync(file, 'utf8')).toBe(existing);
    expect(await uninstallCodex({ codexHome })).toEqual({ file, changed: false });
  });

  it('uninstall on a missing file is a no-op', async () => {
    const codexHome = path.join(tmp, 'missing');
    expect(await uninstallCodex({ codexHome })).toEqual({ file: path.join(codexHome, 'config.toml'), changed: false });
    expect(fs.existsSync(codexHome)).toBe(false);
  });
});

describe('serveCommand', () => {
  it('resolves cli.js one directory above the install module', () => {
    expect(cliPathFrom('file:///opt/subpool/dist/install/codex.js')).toBe(path.resolve('/opt/subpool/dist/cli.js'));
    const cmd = serveCommand();
    expect(cmd.command).toBe(process.execPath);
    expect(cmd.args).toHaveLength(2);
    expect(cmd.args[1]).toBe('serve');
    expect(path.isAbsolute(cmd.args[0] ?? '')).toBe(true);
    expect(path.basename(cmd.args[0] ?? '')).toBe('cli.js');
    expect(path.basename(path.dirname(cmd.args[0] ?? ''))).toBe('src');
  });
});

describe('installClaude', () => {
  const fakeClaude = (script: string): string => {
    const bin = path.join(tmp, 'claude');
    fs.writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return bin;
  };

  it('builds the verified mcp add / remove argument lists', () => {
    expect(claudeMcpAddArgs('user', '/usr/bin/node', ['/x/cli.js', 'serve'])).toEqual([
      'mcp', 'add', 'subpool', '--scope', 'user', '--', '/usr/bin/node', '/x/cli.js', 'serve',
    ]);
    expect(claudeMcpRemoveArgs()).toEqual(['mcp', 'remove', 'subpool']);
  });

  it('formats output from stdout, stderr and exit status', () => {
    const base = { signal: null, timedOut: false, aborted: false, durationMs: 1 };
    expect(execOutput({ ...base, code: 0, stdout: 'ok\n', stderr: '' })).toBe('ok');
    expect(execOutput({ ...base, code: 1, stdout: '', stderr: 'boom' })).toBe('boom\nexit code 1');
    expect(execOutput({ ...base, code: null, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: true })).toBe('timed out');
  });

  it.skipIf(process.platform === 'win32')('removes first (ignoring failure) then adds, capturing output', async () => {
    const log = path.join(tmp, 'calls.log');
    const bin = fakeClaude(
      `echo "$@" >> "${log}"\nif [ "$2" = "remove" ]; then echo "No MCP server found with name: subpool" >&2; exit 1; fi\necho "Added stdio MCP server subpool to user config"`,
    );
    const res = await installClaude({ scope: 'user', command: '/usr/bin/node', args: ['/x/cli.js', 'serve'], binary: bin, cwd: tmp });
    expect(res.ok).toBe(true);
    expect(res.output).toBe('Added stdio MCP server subpool to user config');
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    expect(calls).toEqual(['mcp remove subpool', 'mcp add subpool --scope user -- /usr/bin/node /x/cli.js serve']);
  });

  it.skipIf(process.platform === 'win32')('reports failure output when add exits non-zero', async () => {
    const bin = fakeClaude(`if [ "$2" = "add" ]; then echo "bad scope" >&2; exit 2; fi\nexit 0`);
    const res = await installClaude({ scope: 'project', command: 'node', args: [], binary: bin, cwd: tmp });
    expect(res.ok).toBe(false);
    expect(res.output).toBe('bad scope\nexit code 2');
  });

  it('reports a readable error when the binary is missing', async () => {
    const missing = path.join(tmp, 'no-such-claude');
    const res = await installClaude({ scope: 'user', command: 'node', args: [], binary: missing, cwd: tmp });
    expect(res.ok).toBe(false);
    expect(res.output).toContain('no-such-claude');
    const un = await uninstallClaude({ binary: missing, cwd: tmp });
    expect(un.ok).toBe(false);
    expect(un.output).toContain('no-such-claude');
  });

  it.skipIf(process.platform === 'win32')('uninstallClaude runs mcp remove', async () => {
    const log = path.join(tmp, 'calls.log');
    const bin = fakeClaude(`echo "$@" >> "${log}"\necho removed`);
    const res = await uninstallClaude({ binary: bin, cwd: tmp });
    expect(res).toEqual({ ok: true, output: 'removed' });
    expect(fs.readFileSync(log, 'utf8').trim()).toBe('mcp remove subpool');
  });
});
