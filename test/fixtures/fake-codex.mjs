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

if (argv[0] === 'login' && argv[1] === 'status') {
  process.stdout.write(env.FAKE_LOGGED_IN === '0' ? 'Not logged in\n' : 'Logged in using ChatGPT\n');
  finish(0);
} else if (argv[0] === 'login') {
  const dir = env.CODEX_HOME;
  if (dir) fs.writeFileSync(path.join(dir, 'fake-login.json'), JSON.stringify({ argv, env: { CODEX_HOME: dir, OPENAI_API_KEY: env.OPENAI_API_KEY ?? null } }));
  finish(exitCode);
} else {
  const stdin = await readStdin();
  process.stderr.write('2026-09-25T12:00:00.000000Z  INFO codex_core::codex: fake codex tracing line\n');
  if (env.FAKE_DUMP_ENV) process.stderr.write(JSON.stringify({ fake: 'codex', argv, env, stdin, cwd: process.cwd() }) + '\n');
  for (const line of scenarioLines(env.FAKE_FIXTURE)) process.stdout.write(line + '\n');
  finish(exitCode);
}
