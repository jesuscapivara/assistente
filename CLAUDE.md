# Assistente: regras para quem mexe no código

Leia o README antes (fluxo, comandos, instalação).

- Código, comentários, commits e mensagens ao usuário em português. Comentário explica o porquê.
- **Nada sai para um contato sem o "ok" do dono.** O Claude não recebe ferramenta de envio; o
  envio só acontece em `controle.ts > enviarRascunho`, disparado pelo comando `ok`. Não crie
  outro caminho de envio sem pedido explícito do Lucas.
- Tudo que o assistente escreve vai para o chat do dono consigo mesmo, com 🤖, pela função
  `avisar`, que registra o id em `enviadas` (senão o eco do webhook vira comando, em laço).
- Chat `excluido` não grava nada; `fora` apaga o que havia. Respeite isso em qualquer consulta nova.
- Conhecimento do dono: `perfil` (regra > lição > gerado) e a ficha em `contatos`. Os dois entram
  em todo rascunho e no agente por `perfilEmTexto`/`fichaEmTexto` (`src/repo.ts`).
- Endereço da pessoa: sempre o número. LID vira apelido (`apelidos`) e `registrarApelido` junta
  as conversas; consulta nova deve passar por `resolverJid`.
- O Claude fica atrás da interface `Ia` (`src/ia.ts`). Modelos vêm de `MODELO` e `MODELO_EXTRACAO`.
- Teste: `npm run typecheck` e `npm test`; o fluxo com banco roda com `DATABASE_URL_TESTE`
  apontando para um Postgres vazio (o teste apaga o schema).
- Webhook da Evolution GO: mesmo formato que o KoreOS trata em
  `backend_koreos/controllers/evolutionWebhookController.js` (`data.Info` + `data.Message`).
