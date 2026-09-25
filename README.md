<div align="center">

<img src="https://raw.githubusercontent.com/vprotti/subpool/main/docs/icon.png" width="120" alt="subpool">

# subpool

**Várias assinaturas de IA, um pool só. O Codex e o Claude Code delegam tarefas para a conta que ainda tem cota.**

[nasmac.app](https://nasmac.app) · [English](README.en.md) · [npm](https://www.npmjs.com/package/subpool)

<img src="https://raw.githubusercontent.com/vprotti/subpool/main/docs/terminal.png" width="720" alt="O subpool listando quatro contas com uso, cooldown e estratégia, e uma tarefa rodando na conta com mais cota">

</div>

---

Grátis, sem conta, sem servidor. Um MCP server e uma CLI que guardam um pool de assinaturas — Claude Code (via `claude`) e ChatGPT (via `codex`) — e mandam cada tarefa de código para a conta menos usada. Bateu no limite, a conta entra em cooldown e a tarefa segue na próxima.

```
codex ──▶ subpool (MCP) ──▶ claude -p    perfil claude-work
                        ├─▶ claude -p    perfil claude-personal
                        ├─▶ codex exec   perfil codex-team
                        └─▶ codex exec   perfil codex-alt
```

Cada conta vive num diretório de perfil isolado e roda pelo **CLI oficial** do fornecedor. O subpool não fala com a API da Anthropic nem da OpenAI, não lê o cofre de credenciais de ninguém e não copia nada de `~/.claude` ou `~/.codex`.

## Por que existe

Uma assinatura acaba no meio da tarefa. Duas assinaturas viram troca manual de conta, `CLAUDE_CONFIG_DIR` na mão e a pergunta "qual ainda tem cota?". Eu queria abrir o Codex, pedir a tarefa e deixar a escolha da conta com quem sabe o número: um roteador que conta tokens por janela de 5 horas e 7 dias, igual aos limites dos dois serviços.

## Instalar

```bash
npm i -g subpool
```

Node 20+ e o `claude` e/ou o `codex` no PATH. macOS, Linux e WSL.

## Vincular contas

```bash
subpool link claude work            # abre o login do Claude no navegador
subpool link claude personal
subpool link codex team             # abre o login do ChatGPT para o Codex
subpool link codex alt --device-auth
subpool ls
```

Cada `link` cria `~/.subpool/profiles/<provider>-<id>` e roda o login oficial ali dentro (`claude auth login` ou `codex login`). O login que você já tem em `~/.claude` e `~/.codex` continua intacto.

Máquina sem navegador, ou Keychain do macOS atrapalhando: gere um token de longa duração com `claude setup-token` em qualquer lugar e cole com

```bash
subpool link claude ci --token      # pede o token, grava em profiles/claude-ci/token com modo 0600
```

`subpool check` mostra quem está logado. `subpool unlink <id>` remove a conta e o perfil.

## Registrar no Codex e no Claude Code

```bash
subpool install codex               # grava [mcp_servers.subpool] em ~/.codex/config.toml
subpool install claude              # roda `claude mcp add subpool --scope user -- …`
```

Dentro do Codex ou do Claude Code, é uma tool:

> Use `delegate` para implementar o formulário de login em `/Users/eu/app` e aguarde o resultado.

O `delegate` escolhe a conta, roda a tarefa naquele CLI dentro do diretório informado, registra os tokens e devolve a mensagem final do worker. O worker começa sem memória: a tarefa precisa ser autocontida.

## Tools MCP

| Tool | O que faz |
| --- | --- |
| `delegate` | Roda uma tarefa de código na melhor conta. `task`, `cwd`, e opcionais `provider`, `account`, `permission`, `model`, `max_turns`, `system_prompt`, `wait` (padrão `true`), `wait_sec` (quanto esperar pelo resultado, padrão 300), `timeout_sec` (limite duro do worker, padrão 1800). |
| `job_wait`, `job_result`, `job_cancel`, `jobs_list` | Acompanham tarefas longas. Se o `delegate` devolver `status: "running"`, chame `job_wait`. |
| `accounts_list`, `accounts_usage` | Tokens por conta nas janelas de 5h e 7d, utilização, cooldown, totais por fornecedor. |
| `account_set`, `set_strategy` | Liga/desliga conta, peso, orçamento, modelo; estratégia de roteamento. |
| `link_help` | Os comandos exatos para vincular outra conta. |

Resources: `subpool://accounts` e `subpool://usage`.

## Distribuição de tokens

```bash
subpool strategy least-used     # padrão: menor utilização primeiro
subpool strategy weighted       # tokens das últimas 5h / peso
subpool strategy round-robin
subpool strategy priority       # ordem do config, próxima conta ao bater limite

subpool set work --tokens-5h 400000 --tokens-7d 2500000
subpool set alt --weight 2
subpool set personal --disable
subpool set personal --clear-cooldown
```

Utilização é `usado / orçamento` nas janelas que têm orçamento, ou `tokens das últimas 5h / peso` quando não tem. Empate vai para a conta usada há mais tempo.

Quando o CLI reporta limite de uso, a conta entra em cooldown até o horário de reset que ele imprimiu (ou 30 minutos, sem horário) e a tarefa é refeita na próxima conta elegível, até `maxAttempts` (3). Erro de login vale 6 horas de cooldown; sobrecarga do serviço, 2 minutos. Falha comum da tarefa não faz failover: o erro volta para quem pediu.

## Permissões

| `permission` | claude | codex |
| --- | --- | --- |
| `read-only` | `--permission-mode plan`, sem Edit/Write/Bash | `--sandbox read-only` |
| `edit` (padrão) | `--permission-mode acceptEdits` | `--sandbox workspace-write` |
| `full` | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` |

## CLI

```
subpool serve                     servidor MCP em stdio
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

`subpool run "escreva testes para src/router.ts" -C ~/app` roteia direto do terminal, sem cliente MCP. `subpool doctor` confere binários, pasta, config e o login de cada conta.

## Privacidade

- **Não existe servidor.** Nada seu sai da máquina além do que os próprios CLIs já mandam para a Anthropic e a OpenAI.
- **Credencial é dos CLIs.** O login acontece no `claude` e no `codex`, dentro do perfil da conta. O subpool só guarda o token de longa duração se você escolher `--token`, e aí em arquivo com modo 0600.
- **O que ele grava:** `usage.jsonl` com tokens, custo e resultado de cada execução; `state.json` com cooldowns; `jobs/*.json` com o texto da tarefa e a resposta do worker, para o `jobs` e o `job_result`. Nenhum deles tem token de acesso.
- **Ambiente limpo.** Antes de rodar um worker, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` e afins são removidos do ambiente, para que a conta do perfil seja a usada e nenhuma conta veja a credencial da outra.

Vincule apenas contas suas ou autorizadas e siga os termos de cada fornecedor.

## Arquivos

```
~/.subpool/config.json        contas, estratégia, padrões
~/.subpool/usage.jsonl        uma linha por execução, compactado para 8 dias a cada serve
~/.subpool/state.json         cooldowns, cursor do round-robin, último uso
~/.subpool/jobs/<id>.json     snapshot de cada job
~/.subpool/profiles/<p>-<id>  CLAUDE_CONFIG_DIR ou CODEX_HOME daquela conta
```

`SUBPOOL_HOME` muda a pasta. `SUBPOOL_CLAUDE_BIN` e `SUBPOOL_CODEX_BIN` apontam para outros binários.

## Detalhes que evitam susto

- Chamada de tool no Codex expira em `tool_timeout_sec`; o `subpool install codex` grava 3600. No Claude Code o limite é `MCP_TOOL_TIMEOUT` (ms) no ambiente do próprio `claude`.
- Tarefa longa: `delegate` com `wait: false` e depois `job_wait`. O worker não é morto quando a espera acaba, só quando `timeout_sec` acaba.
- Vários servidores ao mesmo tempo (um por sessão do Codex) compartilham o mesmo ledger e os mesmos cooldowns, com lock de arquivo.
- Os dois fornecedores mudam mensagem de limite sem avisar. Se uma conta ficou em cooldown sem motivo, `subpool set <id> --clear-cooldown` e uma issue com a mensagem ajudam.

## Compilar do código

```bash
git clone https://github.com/vprotti/subpool.git
cd subpool
npm install
npm run build
npm test
```

Os testes não chamam o `claude` nem o `codex` reais: usam fixtures dos formatos de saída e binários falsos. `docs/ARCHITECTURE.md` descreve cada módulo e os fatos verificados sobre os dois CLIs.

## Estrutura

```
src/server.ts             MCP server: tools e resources
src/cli.ts                comandos
src/core/router.ts        escolha da conta e failover
src/core/ledger.ts        ledger de uso, janelas 5h/7d, cooldowns
src/core/limits.ts        detecção de limite e horário de reset
src/providers/claude.ts   adapter do claude -p (stream-json)
src/providers/codex.ts    adapter do codex exec --json
src/install/              registro no config.toml do Codex e no Claude Code
```

Dependências: `@modelcontextprotocol/sdk`, `zod`, `commander`.

## Contribuir

Bug, ideia ou dúvida: [abra uma issue](https://github.com/vprotti/subpool/issues). Pull requests são bem-vindos — leia o [CONTRIBUTING](CONTRIBUTING.md) antes.

Se o subpool te poupou uma troca de conta, uma ⭐ no repositório ajuda outras pessoas a encontrarem o projeto.

## Licença

[MIT](LICENSE). Use, modifique e redistribua à vontade, inclusive comercialmente.

Não tem relação com a Anthropic nem com a OpenAI. Os nomes e marcas são de cada empresa.

---

<div align="center">
Feito por <a href="https://viniciusprotti.com.br">Vinicius Protti</a> · <a href="https://nasralla.com.br">Nasralla Serviços Digitais</a><br>
Mais apps grátis em <a href="https://nasmac.app"><strong>nasmac.app</strong></a>
</div>
