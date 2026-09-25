# subpool architecture

`subpool` is an MCP server plus CLI. It keeps a pool of linked subscription accounts (Claude Code subscriptions driven through the official `claude` CLI, ChatGPT subscriptions driven through the official `codex` CLI) and routes each delegated coding task to the account with the most remaining quota. Every account is isolated in its own profile directory, so the official CLIs keep their own credentials and subpool never touches tokens directly (except the optional long-lived token mode for Claude, which stores what `claude setup-token` prints).

## Layout

```
src/
  cli.ts                 commander entry (bin: subpool)
  server.ts              MCP server (stdio): tools + resources
  index.ts               public exports
  core/
    types.ts             shared types (fixed, do not change without updating every module)
    paths.ts             SUBPOOL_HOME layout
    fsx.ts               atomic file helpers
    config.ts            config schema (zod), load/save, account CRUD
    ledger.ts            usage ledger (JSONL) + rolling windows + cooldown state
    limits.ts            rate-limit / auth-error detection and reset parsing
    exec.ts              child process runner with env scrubbing
    router.ts            account selection strategies + failover loop
    jobs.ts              async job manager
  providers/
    index.ts             provider registry
    claude.ts            claude CLI adapter
    codex.ts             codex CLI adapter
  install/
    codex.ts             registers subpool in ~/.codex/config.toml
    claude.ts            registers subpool via `claude mcp add`
test/                    vitest specs, fixtures under test/fixtures
```

Code style: TypeScript ESM (`NodeNext`), imports use `.js` suffix, `strict` + `noUncheckedIndexedAccess`. No comments in code. Small pure functions exported for tests. Never log to stdout inside the MCP server (stdout is the protocol channel); use `console.error`.

## Storage (`SUBPOOL_HOME`, default `~/.subpool`)

```
config.json      Config
usage.jsonl      one LedgerEntry per line, append-only, compacted to the last 8 days on serve start
state.json       State (cooldowns, round-robin cursor, lastUsed)
jobs/<id>.json   persisted Job snapshots
profiles/<provider>-<id>/   the isolated CLAUDE_CONFIG_DIR or CODEX_HOME of that account
profiles/claude-<id>/token  optional, mode 0600, long-lived token for auth = "token"
```

All writes to config/state/jobs use write-temp-then-rename. Ledger uses `appendFile`.

## Verified CLI facts (do not guess beyond these)

### claude (Claude Code CLI)

- Isolation: env `CLAUDE_CONFIG_DIR=<profileDir>`.
- Headless run: `claude -p --output-format stream-json --verbose [--model M] [--max-turns N] [--append-system-prompt S] <permission flags>` with the prompt written to stdin (no positional prompt). Working directory is the spawn `cwd`.
- Permission mapping:
  - `read-only`: `--permission-mode plan --disallowedTools Edit Write MultiEdit NotebookEdit Bash`
  - `edit`: `--permission-mode acceptEdits`
  - `full`: `--dangerously-skip-permissions`
- Also pass `--permission-prompts none` is NOT supported everywhere; do not pass it. Unlisted tools are auto-denied in `-p` mode.
- stream-json lines are JSON objects with `type` in `system` (subtype `init`, has `session_id`, `model`), `assistant` (has `message.content[]` with `{type:"text",text}` and `{type:"tool_use",name,input}`), `user` (tool results), `result`.
- Final `result` line shape (observed on 2.1.x):
  `{"type":"result","subtype":"success"|"error_max_turns"|"error_during_execution"|..., "is_error":false, "result":"<final text>", "session_id":"...", "num_turns":1, "duration_ms":2324, "total_cost_usd":0.038, "api_error_status":null, "usage":{"input_tokens":2,"cache_creation_input_tokens":7951,"cache_read_input_tokens":31472,"output_tokens":4}, "modelUsage":{...}, "permission_denials":[]}`
  `usage.total = input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens`; `cached = cache_read_input_tokens`.
- Rate limit / quota signals (match case-insensitively on `result` text, stderr, and any `error` object messages): `usage limit reached`, `reached your weekly usage limit`, `5-hour usage limit`, `rate_limit_error`, `rate limited`, `too many requests`, `api_error_status` 429. Some versions append the reset as `|<unix epoch seconds>` at the end of the message; also `resets in 3h 20m`, `resets at 4pm`. `overloaded_error` / `529` = `overloaded` kind (short cooldown). Auth signals: `Please run /login`, `Invalid API key`, `401`, `Not logged in`, `authentication_error` = `auth` kind.
- Auth commands: `claude auth login` (interactive, browser), `claude auth status --json` prints `{"loggedIn":true,"authMethod":"oauth_token"|"claude.ai"|..., "configDirectory":"..."}`; `claude auth logout`; `claude setup-token` prints a long-lived token for `CLAUDE_CODE_OAUTH_TOKEN`.
- MCP registration: `claude mcp add <name> --scope user -- <command> [args...]`. Claude Code's own MCP tool timeout is env `MCP_TOOL_TIMEOUT` (ms) on the claude process.
- Env to scrub before spawning (so the profile's subscription is used and nesting checks do not trip): `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` (re-set only for `auth: "token"` accounts from `profiles/claude-<id>/token`), `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`.

### codex (OpenAI Codex CLI, 0.157.x)

- Isolation: env `CODEX_HOME=<profileDir>` (auth lives in `<profileDir>/auth.json`).
- Headless run: `codex exec --json --color never --skip-git-repo-check -C <cwd> [-m M] <sandbox flags> -` with the prompt on stdin (`-` means read stdin).
- Permission mapping:
  - `read-only`: `-s read-only`
  - `edit`: `-s workspace-write`
  - `full`: `--dangerously-bypass-approvals-and-sandbox`
- `--json` emits JSONL on stdout; tracing logs go to stderr. Observed events:
  - `{"type":"thread.started","thread_id":"..."}`
  - `{"type":"turn.started"}`
  - `{"type":"item.started"|"item.updated"|"item.completed","item":{"id":"item_0","type":"agent_message"|"reasoning"|"command_execution"|"file_change"|"mcp_tool_call"|"error", "text"?:string, "message"?:string, "command"?:string}}`
  - `{"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,"output_tokens":N}}`
  - `{"type":"turn.failed","error":{"message":"..."}}`
  - `{"type":"error","message":"..."}`
  Final output = text of the last `item.completed` whose item type is `agent_message`. `usage.total = input_tokens + output_tokens` (cached is a subset of input).
- Rate limit / quota signals: `usage_limit_exceeded`, `usage limit`, `hit your usage limit`, `rate limit`, `too many requests`, `429`; resets: `try again in 2 hours 5 minutes`, `resets in ...`, `resets_in_seconds":N`, `resets_at":<epoch>`. Auth: `401`, `Unauthorized`, `Missing bearer`, `Not logged in`, `login` = `auth` kind. `overloaded`, `503`, `529` = `overloaded`.
- Auth commands: `codex login` (browser), `codex login --device-auth` (headless), `codex login status` prints `Logged in using ChatGPT` / `Not logged in` (exit code 0 either way, so parse text). `codex logout`.
- MCP registration: `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`):
  ```toml
  [mcp_servers.subpool]
  command = "/abs/path/to/node"
  args = ["/abs/path/to/dist/cli.js", "serve"]
  startup_timeout_sec = 30
  tool_timeout_sec = 3600
  ```
  `codex mcp add subpool -- <cmd> <args...>` also exists but does not set timeouts.
- Env to scrub before spawning: `OPENAI_API_KEY`, `CODEX_API_KEY`, `OPENAI_BASE_URL`.

## Module contracts

### core/fsx.ts
```ts
export async function writeFileAtomic(file: string, data: string, mode?: number): Promise<void>
export async function readJson<T>(file: string): Promise<T | undefined>   // undefined when missing
export async function readJsonOr<T>(file: string, fallback: T): Promise<T>
export async function appendLine(file: string, line: string): Promise<void>
export async function readLines(file: string): Promise<string[]>          // [] when missing
export function newId(prefix: string): string                            // prefix + '_' + 12 base36 chars from crypto.randomBytes
```

### core/config.ts
```ts
export const ConfigSchema: z.ZodType<Config>        // zod v4, with defaults for every optional field
export function defaultConfig(): Config             // strategy 'least-used', defaults { permission:'edit', timeoutSec:1800, maxAttempts:3, cooldownSec:1800 }, accounts []
export async function loadConfig(paths: Paths): Promise<Config>   // creates the file with defaults when missing; throws a readable Error on invalid JSON/schema
export async function saveConfig(paths: Paths, config: Config): Promise<void>
export function getAccount(config: Config, id: string): Account | undefined
export function upsertAccount(config: Config, account: Account): Config   // returns a new Config
export function removeAccount(config: Config, id: string): Config
export function assertAccountId(id: string): void                        // throws unless ACCOUNT_ID_RE matches
export function newAccount(input: { id: string; provider: ProviderId; profileDir: string; auth?: AuthMode; weight?: number; budget?: AccountBudget; model?: string }): Account
```

### core/ledger.ts
```ts
export class Ledger {
  constructor(paths: Paths, now?: () => number)
  append(entry: LedgerEntry): Promise<void>
  entries(sinceMs?: number): Promise<LedgerEntry[]>
  compact(keepMs?: number): Promise<number>                         // rewrites the file keeping entries newer than now-keepMs (default WINDOW_7D_MS + 1 day), returns dropped count
  state(): Promise<State>
  setCooldown(accountId: string, until: number, reason: string): Promise<void>
  clearCooldown(accountId: string): Promise<void>
  touch(accountId: string): Promise<void>                           // lastUsed[accountId] = now
  bumpCursor(): Promise<number>                                     // rrCursor += 1, returns previous
  usage(accounts: Account[]): Promise<AccountUsage[]>               // one entry per account, utilization via computeUtilization
}
export function summarize(entries: LedgerEntry[], accountId: string, now: number): { window5h: WindowUsage; window7d: WindowUsage; lastUsedAt?: number }
export function computeUtilization(account: Account, window5h: WindowUsage, window7d: WindowUsage): number
// utilization: if budget.tokens5h or tokens7d is set, max(used/budget) over the set ones; else window5h.tokens / max(weight, 0.01). Always >= 0.
export function ledgerEntryFrom(result: RunResult, now: number): LedgerEntry
```

### core/limits.ts
```ts
export function detectLimit(provider: ProviderId, text: string, apiStatus?: number | null): Limit | undefined
export function parseResetAt(text: string, now: number): number | undefined   // handles '|<epoch10|13>', 'resets_in_seconds":N', 'resets_at":<epoch>', 'try again in Xh Ym Zs', 'resets in Xh Ym', 'in X minutes/hours/seconds'
export function isRetryable(limit: Limit | undefined): boolean          // rate and overloaded are retryable on another account, auth is retryable too (skip that account) - returns true for all three kinds
export function cooldownFor(limit: Limit, now: number, defaultSec: number): number
// rate: resetAt ?? now + defaultSec*1000; overloaded: now + 120000; auth: now + 6h
```

### core/exec.ts
```ts
export interface ExecOptions { cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; stdin?: string; timeoutMs: number; signal?: AbortSignal; onStdoutLine?: (line: string) => void; onStderrLine?: (line: string) => void; stdio?: 'pipe' | 'inherit' }
export interface ExecResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean; durationMs: number }
export async function runProcess(opts: ExecOptions): Promise<ExecResult>   // never throws on non-zero exit; rejects only on spawn failure (ENOENT) with a readable message naming the binary. Kills the tree with SIGTERM then SIGKILL after 5s on timeout/abort. stdout/stderr are capped at 8 MiB each (keep the tail).
export function scrubEnv(base: NodeJS.ProcessEnv, provider: ProviderId): NodeJS.ProcessEnv   // deletes the keys listed above for BOTH providers plus SUBPOOL_TOKEN and returns a copy (a worker must never see another account's credentials)
export function resolveBinary(name: string, override?: string): string   // override ?? process.env.SUBPOOL_<NAME>_BIN ?? name
export async function runInteractive(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<number>   // stdio inherit, returns exit code
```

### providers/claude.ts, providers/codex.ts, providers/index.ts
```ts
export const claudeProvider: ProviderAdapter
export function parseClaudeStream(lines: string[]): { text: string; usage: Usage; sessionId?: string; isError: boolean; subtype?: string; apiStatus?: number | null; errorText?: string; numTurns?: number }
export function claudeArgs(req: RunRequest): string[]

export const codexProvider: ProviderAdapter
export function parseCodexEvents(lines: string[]): { text: string; usage: Usage; threadId?: string; failed: boolean; errorText?: string }
export function codexArgs(req: RunRequest): string[]

export const providers: Record<ProviderId, ProviderAdapter>
export function getProvider(id: ProviderId): ProviderAdapter
```
`run()` must: build env with `scrubEnv` + the isolation var (+ token for auth token accounts, read from `<profileDir>/token`), spawn through `runProcess` with stdin = prompt, stream lines to `onEvent` (`message` for assistant text, `tool` for tool/command items, `stderr` for stderr), then build `RunResult`. `limit = detectLimit(provider, combinedErrorText, apiStatus)`; `ok = exit 0 && !isError && !limit`. `error` must be a one-line readable string when not ok (timeout, killed, non-zero exit + stderr tail). Timeout -> `error: 'timeout after Ns'`.

`login()`: claude -> `runInteractive('claude', ['auth','login'], env)` where env has `CLAUDE_CONFIG_DIR`; if `opts.token` given, write `<profileDir>/token` with mode 0600 instead and skip the interactive login. codex -> `runInteractive('codex', ['login', ...(opts.deviceAuth ? ['--device-auth'] : [])], env)` with `CODEX_HOME`. Create the profile dir (mode 0700) first.

`status()`: claude -> `claude auth status --json` parse `loggedIn`; codex -> `codex login status` text contains `Logged in` and not `Not logged in`.

### core/router.ts
```ts
export function eligible(config: Config, usages: AccountUsage[], opts: SelectOptions, now: number): Account[]
// enabled, not in opts.exclude, provider matches (opts.provider undefined/'any' = all), opts.account -> only that id (even if cooling down? no: cooldown still applies), cooldownUntil undefined or <= now
export function selectAccount(config: Config, usages: AccountUsage[], opts: SelectOptions, now: number, rrCursor: number): Account | undefined
// least-used: min utilization, tie -> oldest lastUsedAt (undefined first), tie -> config order
// weighted: min (window5h.tokens + 1) / weight
// round-robin: eligible[rrCursor % eligible.length]
// priority: first eligible in config order
export class Router {
  constructor(deps: { paths: Paths; ledger: Ledger; providers: Record<ProviderId, ProviderAdapter>; loadConfig: () => Promise<Config>; now?: () => number })
  run(req: RunRequest, opts: SelectOptions, onEvent?: (e: RunEvent, accountId: string) => void): Promise<RoutedResult>
}
```
`Router.run` loop: up to `config.defaults.maxAttempts` attempts (or the number of eligible accounts if smaller). Each attempt: select -> touch -> provider.run -> `ledger.append(ledgerEntryFrom(...))`. If `result.limit` -> `setCooldown(id, cooldownFor(limit, now, cooldownSec), limit.message)`, push attempt, exclude id, continue. If not ok and no limit -> return failure (no failover on ordinary task failure). When no eligible account: return `ok:false` with `error` explaining (`no eligible account: 2 cooling down (work until 18:40), 1 disabled`) and `attempts`. `RoutedResult.attempts` always includes the final attempt.

### core/jobs.ts
```ts
export class JobManager {
  constructor(router: Router, paths: Paths, now?: () => number)
  submit(req: Omit<RunRequest,'signal'>, opts: SelectOptions): Job       // starts immediately, returns snapshot
  get(id: string): Job | undefined
  list(): Job[]
  wait(id: string, timeoutMs: number): Promise<Job>                      // resolves with the current snapshot when done or when timeout elapses
  cancel(id: string): boolean                                            // aborts the AbortController
}
```
Events are kept (last 200 per job). Each status change persists `jobs/<id>.json`. Snapshots returned to callers must not include the AbortController.

### install/codex.ts, install/claude.ts
```ts
export function upsertMcpServerBlock(toml: string, name: string, block: Record<string, string | number | string[]>): string
// idempotent: replaces an existing [mcp_servers.<name>] table (up to the next [table] header or EOF) or appends one; preserves the rest byte-for-byte
export function removeMcpServerBlock(toml: string, name: string): string
export async function installCodex(opts: { codexHome?: string; command: string; args: string[]; toolTimeoutSec?: number }): Promise<{ file: string; changed: boolean }>
export async function uninstallCodex(opts: { codexHome?: string }): Promise<{ file: string; changed: boolean }>
export function serveCommand(): { command: string; args: string[] }   // { command: process.execPath, args: [<abs dist/cli.js>, 'serve'] } resolved from import.meta.url
export async function installClaude(opts: { scope: 'user' | 'local' | 'project'; command: string; args: string[] }): Promise<{ ok: boolean; output: string }>   // runs `claude mcp add subpool --scope <scope> -- <command> <args...>` and also `claude mcp remove subpool` first, ignoring its failure
```

### server.ts
```ts
export function createServer(deps: { paths: Paths; ledger: Ledger; jobs: JobManager; loadConfig: () => Promise<Config>; saveConfig: (c: Config) => Promise<void>; providers: Record<ProviderId, ProviderAdapter>; now?: () => number }): McpServer
export async function serve(paths?: Paths): Promise<void>   // wires everything and connects StdioServerTransport
```
Tools (all return `content: [{type:'text', text: JSON.stringify(payload, null, 2)}]` plus `structuredContent` when an outputSchema is declared):
- `delegate` { task: string (required), cwd?: string (absolute, must exist, default process.cwd()), provider?: 'claude'|'codex'|'any', account?: string, permission?: 'read-only'|'edit'|'full', model?: string, max_turns?: number, system_prompt?: string, wait?: boolean (default true), wait_sec?: number (default 300, max 86400), timeout_sec?: number (default config.defaults.timeoutSec, max 86400) } -> when wait: runs the job and returns `{ job_id, status, provider, account, output, usage, attempts, duration_ms }`; if the job is still running when `wait_sec` elapses, returns `{ job_id, status:'running', hint:'call job_wait' }` without cancelling. `timeout_sec` is independent of waiting: it is the hard run limit after which the worker is killed. When wait=false returns `{ job_id, status:'queued' }` immediately. While waiting, if `extra._meta?.progressToken` is present send `notifications/progress` every 10 s with `progress` = seconds elapsed and `message` = last event text.
  Description must tell the calling model: use this to hand a self-contained coding task to another subscription; include full context in `task` because the worker starts with no memory; pass `cwd`; for long tasks use `wait:false` then `job_wait`.
- `job_wait` { job_id, timeout_sec? (default 300) } -> same payload as delegate.
- `job_result` { job_id } -> payload with full output.
- `job_cancel` { job_id }
- `jobs_list` {} -> compact list.
- `accounts_list` {} -> accounts with usage windows, utilization, cooldown, enabled, provider, model, weight, budget.
- `accounts_usage` {} -> same numbers plus totals per provider.
- `account_set` { account, enabled?, weight?, tokens_5h?, tokens_7d?, model? } -> updated account.
- `set_strategy` { strategy }
- `link_help` {} -> the exact shell commands to link a new account (see CLI) and the note that linking is interactive and must be done in a terminal.
Resources: `subpool://accounts` (JSON of accounts_list), `subpool://usage` (JSON of accounts_usage).
Server name `subpool`, version from package.json.

### cli.ts (commander)
```
subpool serve                                   start the MCP server on stdio
subpool link <claude|codex> <id> [--token] [--device-auth] [--weight N] [--tokens-5h N] [--tokens-7d N] [--model M]
subpool unlink <id> [--keep-profile]
subpool ls [--json]                             table: id, provider, status, 5h tokens/budget, 7d tokens/budget, utilization %, cooldown, model
subpool usage [--json]
subpool check [id]                              runs status() for one/all accounts and prints login state
subpool set <id> [--enable|--disable] [--weight N] [--tokens-5h N] [--tokens-7d N] [--model M] [--clear-cooldown]
subpool strategy [name]                         get or set
subpool run <task...> [-C cwd] [--provider p] [--account id] [--permission p] [--model m] [--timeout sec] [--json]   direct routed run, streams events to stderr, prints output
subpool jobs [--json]
subpool install <codex|claude> [--scope user|local|project] [--tool-timeout sec]
subpool uninstall <codex|claude>
subpool doctor                                  checks binaries on PATH, SUBPOOL_HOME writable, each account login status, config validity
```
`link` flow: assertAccountId, create profile dir, `provider.login`, then `provider.status`; if not logged in print a warning but keep the account. For `--token` on claude: prompt on the terminal with echo off (readline, `process.stdin.setRawMode` is fine) unless `SUBPOOL_TOKEN` env is set; print the reminder that the token comes from `claude setup-token`. Print a one-line summary at the end: `linked claude-work (claude) -> profiles/claude-work`.

Exit codes: 0 ok, 1 error, 2 usage error. All errors printed as one line to stderr.
