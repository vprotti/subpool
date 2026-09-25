# Security Policy · Política de Segurança

## English

**Supported version.** The latest release on [npm](https://www.npmjs.com/package/subpool).

**Reporting.** Please do not open a public issue for a security problem. Use
GitHub's [private advisory form](https://github.com/vprotti/subpool/security/advisories/new),
which reaches me directly. Include what the flaw is, how to trigger it and what
an attacker gets out of it.

I will confirm receipt within a few days and keep you posted until it is fixed.
Credit in the release notes if you want it.

**Scope worth knowing about.** subpool spawns the official `claude` and `codex`
CLIs with the permissions the caller asked for; `permission: "full"` disables
their sandboxes on purpose, and any MCP client that can call `delegate` can run
code in the given directory. It has no server and no account system. The only
secret it may store is the optional long-lived Claude token, in a file with
mode 0600 inside the account's profile.

## Português

**Versão suportada.** A última publicada no [npm](https://www.npmjs.com/package/subpool).

**Como reportar.** Por favor não abra issue pública para falha de segurança.
Use o [formulário privado do GitHub](https://github.com/vprotti/subpool/security/advisories/new),
que chega direto em mim. Diga qual é a falha, como reproduzir e o que um
atacante consegue com ela.

Confirmo o recebimento em alguns dias e te mantenho informado até a correção.
Crédito nas notas da versão, se você quiser.

**Contexto útil.** O subpool executa os CLIs oficiais `claude` e `codex` com a
permissão que quem chamou pediu; `permission: "full"` desliga o sandbox deles de
propósito, e qualquer cliente MCP que consiga chamar `delegate` consegue rodar
código no diretório informado. Não tem servidor nem sistema de conta. O único
segredo que ele pode guardar é o token de longa duração opcional do Claude, em
arquivo com modo 0600 dentro do perfil da conta.
