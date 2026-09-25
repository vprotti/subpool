<div align="center">

<img src="https://raw.githubusercontent.com/vprotti/subpool/main/docs/icon.png" width="120" alt="subpool">

# subpool

**Several AI subscriptions, one pool. Codex and Claude Code delegate tasks to the account that still has quota.**

[nasmac.app](https://nasmac.app) · [Português](README.md) · [npm](https://www.npmjs.com/package/subpool)

<img src="https://raw.githubusercontent.com/vprotti/subpool/main/docs/terminal.png" width="720" alt="subpool listing four accounts with usage, cooldown and strategy, then running a task on the account with the most quota">

</div>

---

Free, no account, no server. An MCP server and a CLI that keep a pool of subscriptions — Claude Code (through `claude`) and ChatGPT (through `codex`) — and send each coding task to the least-used account. When one hits its limit it cools down and the task moves on to the next.

```
codex ──▶ subpool (MCP) ──▶ claude -p    profile claude-work
                        ├─▶ claude -p    profile claude-personal
                        ├─▶ codex exec   profile codex-team
                        └─▶ codex exec   profile codex-alt
```

Every account lives in its own isolated profile directory and runs through the vendor's **official CLI**. subpool never talks to the Anthropic or OpenAI APIs, never reads anyone's credential store and copies nothing from `~/.claude` or `~/.codex`.

## Why it exists

One subscription runs out mid-task. Two subscriptions turn into manual account switching, a hand-set `CLAUDE_CONFIG_DIR` and the question "which one still has quota?". I wanted to open Codex, ask for the task and leave the choice of account to something that knows the number: a router that counts tokens over 5-hour and 7-day windows, the same windows both services use for their limits.

## Install

```bash
npm i -g subpool
```

Node 20+ and `claude` and/or `codex` on your PATH. macOS, Linux and WSL.

## Link accounts

```bash
subpool link claude work            # opens the Claude login in your browser
subpool link claude personal
subpool link codex team             # opens the ChatGPT login for Codex
subpool link codex alt --device-auth
subpool ls
```

Each `link` creates `~/.subpool/profiles/<provider>-<id>` and runs the official login inside it (`claude auth login` or `codex login`). Your existing logins in `~/.claude` and `~/.codex` stay untouched.

Headless machine, or the macOS Keychain getting in the way: generate a long-lived token with `claude setup-token` anywhere and paste it with

```bash
subpool link claude ci --token      # prompts for the token, stored in profiles/claude-ci/token with mode 0600
```

`subpool check` shows who is logged in. `subpool unlink <id>` removes the account and its profile.

## Register in Codex and Claude Code

```bash
subpool install codex               # writes [mcp_servers.subpool] into ~/.codex/config.toml
subpool install claude              # runs `claude mcp add subpool --scope user -- …`
```

Inside Codex or Claude Code it is a tool:

> Use `delegate` to implement the login form in `/Users/me/app` and wait for the result.

`delegate` picks the account, runs the task in that CLI inside the given directory, records the tokens and returns the worker's final message. The worker starts with no memory, so the task has to be self-contained.

## MCP tools

| Tool | What it does |
| --- | --- |
| `delegate` | Runs a coding task on the best account. `task`, `cwd`, and optional `provider`, `account`, `permission`, `model`, `max_turns`, `system_prompt`, `wait` (default `true`), `wait_sec` (how long to wait for the result, default 300), `timeout_sec` (hard worker limit, default 1800). |
| `job_wait`, `job_result`, `job_cancel`, `jobs_list` | Follow long tasks. If `delegate` returns `status: "running"`, call `job_wait`. |
| `accounts_list`, `accounts_usage` | Tokens per account in the 5h and 7d windows, utilization, cooldown, totals per provider. |
| `account_set`, `set_strategy` | Enable/disable an account, weight, budget, model; routing strategy. |
| `link_help` | The exact commands to link another account. |

Resources: `subpool://accounts` and `subpool://usage`.

## Distributing tokens

```bash
subpool strategy least-used     # default: lowest utilization first
subpool strategy weighted       # tokens in the last 5h / weight
subpool strategy round-robin
subpool strategy priority       # config order, next account on limit

subpool set work --tokens-5h 400000 --tokens-7d 2500000
subpool set alt --weight 2
subpool set personal --disable
subpool set personal --clear-cooldown
```

Utilization is `used / budget` over the windows that have a budget, or `tokens in the last 5h / weight` when none is set. Ties go to the account used least recently.

When the CLI reports a usage limit, the account cools down until the reset time it printed (or 30 minutes without one) and the task is retried on the next eligible account, up to `maxAttempts` (3). A login error costs 6 hours of cooldown; a service overload, 2 minutes. An ordinary task failure does not fail over: the error goes back to the caller.

## Permissions

| `permission` | claude | codex |
| --- | --- | --- |
| `read-only` | `--permission-mode plan`, no Edit/Write/Bash | `--sandbox read-only` |
| `edit` (default) | `--permission-mode acceptEdits` | `--sandbox workspace-write` |
| `full` | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` |

## CLI

```
subpool serve                     MCP server on stdio
subpool link <claude|codex> <id>  [--token] [--device-auth] [--weight N] [--tokens-5h N] [--tokens-7d N] [--model M]
subpool unlink <id>               [--keep-profile]
subpool ls                        [--json]
subpool usage                     [--json]
subpool check [id]
subpool set <id>                  [--enable|--disable] [--weight N] [--tokens-5h N] [--tokens-7d N] [--model M] [--clear-cooldown]
subpool strategy [name]
subpool run <task...>             [-C dir] [--provider p] [--account id] [--permission p] [--model m] [--timeout s] [--json]
subpool jobs                      [--json]
subpool install <codex|claude>    [--scope user|local|project] [--tool-timeout s]
subpool uninstall <codex|claude>
subpool doctor
```

`subpool run "write tests for src/router.ts" -C ~/app` routes straight from the terminal, no MCP client needed. `subpool doctor` checks binaries, the home folder, the config and each account's login.

## Privacy

- **There is no server.** Nothing leaves your machine beyond what the CLIs themselves already send to Anthropic and OpenAI.
- **Credentials belong to the CLIs.** Login happens in `claude` and `codex`, inside the account's profile. subpool stores a long-lived token only if you choose `--token`, and then in a file with mode 0600.
- **What it writes:** `usage.jsonl` with tokens, cost and outcome per run; `state.json` with cooldowns; `jobs/*.json` with the task text and the worker's answer, for `jobs` and `job_result`. None of them holds an access token.
- **Clean environment.** Before a worker starts, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` and friends are removed from its environment, so the profile's account is the one used and no account sees another's credential.

Only link accounts you own or are allowed to use, and follow each provider's terms.

## Files

```
~/.subpool/config.json        accounts, strategy, defaults
~/.subpool/usage.jsonl        one line per run, compacted to 8 days on every serve
~/.subpool/state.json         cooldowns, round-robin cursor, last use
~/.subpool/jobs/<id>.json     one snapshot per job
~/.subpool/profiles/<p>-<id>  that account's CLAUDE_CONFIG_DIR or CODEX_HOME
```

`SUBPOOL_HOME` moves the folder. `SUBPOOL_CLAUDE_BIN` and `SUBPOOL_CODEX_BIN` point at other binaries.

## Details that avoid surprises

- Codex tool calls time out after `tool_timeout_sec`; `subpool install codex` writes 3600. In Claude Code the limit is `MCP_TOOL_TIMEOUT` (ms) in the environment of `claude` itself.
- Long task: `delegate` with `wait: false`, then `job_wait`. The worker is not killed when the wait ends, only when `timeout_sec` ends.
- Several servers at once (one per Codex session) share the same ledger and cooldowns, under a file lock.
- Both vendors change their limit messages without notice. If an account cooled down for no reason, `subpool set <id> --clear-cooldown` and an issue with the message help.

## Build from source

```bash
git clone https://github.com/vprotti/subpool.git
cd subpool
npm install
npm run build
npm test
```

The tests never call the real `claude` or `codex`: they use fixtures of both output formats and fake binaries. `docs/ARCHITECTURE.md` describes every module and the verified facts about both CLIs.

## Layout

```
src/server.ts             MCP server: tools and resources
src/cli.ts                commands
src/core/router.ts        account selection and failover
src/core/ledger.ts        usage ledger, 5h/7d windows, cooldowns
src/core/limits.ts        limit detection and reset time parsing
src/providers/claude.ts   claude -p adapter (stream-json)
src/providers/codex.ts    codex exec --json adapter
src/install/              registration in Codex's config.toml and in Claude Code
```

Dependencies: `@modelcontextprotocol/sdk`, `zod`, `commander`.

## Contributing

Bug, idea or question: [open an issue](https://github.com/vprotti/subpool/issues). Pull requests are welcome — read [CONTRIBUTING](CONTRIBUTING.md) first.

If subpool saved you an account switch, a ⭐ on the repository helps other people find the project.

## License

[MIT](LICENSE). Use, modify and redistribute freely, commercially included.

Not affiliated with Anthropic or OpenAI. Names and trademarks belong to their owners.

---

<div align="center">
Made by <a href="https://viniciusprotti.com.br">Vinicius Protti</a> · <a href="https://nasralla.com.br">Nasralla Serviços Digitais</a><br>
More free apps at <a href="https://nasmac.app"><strong>nasmac.app</strong></a>
</div>
