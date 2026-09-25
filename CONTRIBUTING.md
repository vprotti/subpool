# Contribuir · Contributing

*Português abaixo do inglês.*

---

## English

Thanks for taking a look.

**Bugs.** Open an issue with what you did, what you expected and what happened,
plus your OS, Node version, and the versions of `claude` and `codex`
(`claude --version`, `codex --version`). If an account cooled down for no
reason, paste the message from `subpool ls` or `subpool jobs`.

**Ideas.** Open an issue and describe the problem you are trying to solve, not
only the feature you have in mind. subpool is deliberately small — a change that
makes it route better beats a change that adds a switch.

**Pull requests.**

1. Fork, branch, and keep the change focused on one thing.
2. `npm run build && npm test` has to finish clean. Tests never call the real
   `claude` or `codex`: use the fixtures in `test/fixtures` or a fake binary.
3. Match the surrounding code. TypeScript strict, ESM with `.js` imports, no
   comments in code, no new runtime dependencies without a reason in the PR.
4. A change to how a CLI is invoked or parsed must come with the observed
   output that motivated it; `docs/ARCHITECTURE.md` lists what was verified.
5. Write the PR description as if the reader has not seen the issue.

**What will not be merged:** anything that reads a CLI's credential store,
calls the vendors' APIs directly, sends data off the user's machine, or adds
telemetry.

## Português

Obrigado por dar uma olhada.

**Bugs.** Abra uma issue com o que você fez, o que esperava e o que aconteceu,
mais o sistema, a versão do Node e as versões do `claude` e do `codex`
(`claude --version`, `codex --version`). Se uma conta entrou em cooldown sem
motivo, cole a mensagem do `subpool ls` ou do `subpool jobs`.

**Ideias.** Abra uma issue e descreva o problema que quer resolver, não só a
funcionalidade que imaginou. O subpool é pequeno de propósito — uma mudança que
melhora o roteamento vale mais que uma que adiciona um botão.

**Pull requests.**

1. Fork, branch, e mantenha a mudança focada em uma coisa só.
2. `npm run build && npm test` precisa terminar limpo. Os testes nunca chamam o
   `claude` nem o `codex` reais: use as fixtures em `test/fixtures` ou um
   binário falso.
3. Siga o estilo do código em volta. TypeScript strict, ESM com imports `.js`,
   sem comentário no código, sem dependência nova sem motivo no PR.
4. Mudança em como um CLI é chamado ou lido precisa vir com a saída observada
   que motivou; `docs/ARCHITECTURE.md` lista o que foi verificado.
5. Escreva a descrição do PR como se quem lê não tivesse visto a issue.

**O que não entra:** qualquer coisa que leia o cofre de credenciais de um CLI,
chame a API dos fornecedores direto, mande dado para fora da máquina do usuário
ou adicione telemetria.
