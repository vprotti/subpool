#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const env = process.env;

function scenarioLines(spec) {
  if (!spec) return [];
  const [file, name] = spec.split('#');
  const text = fs.readFileSync(path.resolve(here, file), 'utf8');
  const out = [];
  let current;
  for (const line of text.split(/\r?\n/)) {
    const m = /^#\s*scenario:\s*(\S+)/.exec(line);
    if (m) {
      current = m[1];
      continue;
    }
    if (line.trim().length === 0) continue;
    if (!name || current === name) out.push(line);
  }
  return out;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function finish(code) {
  const sleep = Number(env.FAKE_SLEEP_MS ?? 0);
  if (sleep > 0) setTimeout(() => process.exit(code), sleep);
  else process.exit(code);
}

const exitCode = Number(env.FAKE_EXIT ?? 0);

if (argv[0] === 'auth' && argv[1] === 'status') {
  const loggedIn = env.FAKE_LOGGED_IN !== '0';
  process.stdout.write(
    JSON.stringify({
      loggedIn,
      authMethod: loggedIn ? (env.CLAUDE_CODE_OAUTH_TOKEN ? 'oauth_token' : 'claude.ai') : undefined,
      configDirectory: env.CLAUDE_CONFIG_DIR ?? null,
    }) + '\n',
  );
  finish(exitCode);
} else if (argv[0] === 'auth' && argv[1] === 'login') {
  const dir = env.CLAUDE_CONFIG_DIR;
  if (dir) fs.writeFileSync(path.join(dir, 'fake-login.json'), JSON.stringify({ argv, env: { CLAUDE_CONFIG_DIR: dir, ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? null } }));
  finish(exitCode);
} else {
  const stdin = await readStdin();
  if (env.FAKE_DUMP_ENV) process.stderr.write(JSON.stringify({ fake: 'claude', argv, env, stdin, cwd: process.cwd() }) + '\n');
  for (const line of scenarioLines(env.FAKE_FIXTURE)) process.stdout.write(line + '\n');
  finish(exitCode);
}
