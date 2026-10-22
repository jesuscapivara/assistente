# Assistente: regras para quem mexe no código

Leia o README antes (fluxo, comandos, instalação).

- Código, comentários, commits e mensagens ao usuário em português. Comentário explica o porquê.
- **Envio a contato só por `executarEnvio` (`src/controle.ts`).** O Claude não recebe ferramenta
  de envio. Sai pelo `ok` do dono, ou pela autonomia que ele deu ao contato (`src/autonomia.ts`):
  nível 2 com janela de veto, nível 3 direto, e nunca com risco alto, `[preencher:]`, em grupo,
  entre 21h e 8h ou com `pausa`. Não crie outro caminho de envio nem afrouxe essas travas sem
  pedido explícito do Lucas. E-mail: só rascunho no Gmail. Evento: sem convidados.
- Tudo que o assistente escreve vai para o chat do dono consigo mesmo, com 🤖, pela função
  `avisar`, que registra o id em `enviadas` (senão o eco do webhook vira comando, em laço).
- Chat `excluido` não grava nada; `fora` apaga o que havia. Respeite isso em qualquer consulta nova.
- Conhecimento do dono: `perfil` (regra > lição > gerado) e a ficha em `contatos`. Os dois entram
  em todo rascunho e no agente por `perfilEmTexto`/`fichaEmTexto` (`src/repo.ts`).
- Endereço da pessoa: sempre o número. LID vira apelido (`apelidos`) e `registrarApelido` junta
  as conversas; consulta nova deve passar por `resolverJid`.
- Integrações opcionais (Google, KoreOS MCP, áudio, painel): sem a chave, a função some; o
  resto funciona. Google e Evolution ficam atrás de interfaces (`Google`, `Evolution`) com
  versões falsas nos testes.
- O Claude fica atrás da interface `Ia` (`src/ia.ts`). Modelos vêm de `MODELO` e `MODELO_EXTRACAO`.
- Teste: `npm run typecheck` (código e testes) e `npm test`; os fluxos com banco rodam com
  `DATABASE_URL_TESTE` apontando para um Postgres vazio (o teste apaga o schema).
- Tokens no caminho (webhook, painel) não podem ir para o log: `ocultarToken` em `src/server.ts`.
- Webhook da Evolution GO: mesmo formato que o KoreOS trata em
  `backend_koreos/controllers/evolutionWebhookController.js` (`data.Info` + `data.Message`).
