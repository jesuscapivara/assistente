# Assistente: regras para quem mexe no código

Leia o README antes (fluxo, comandos, instalação).

- Código, comentários, commits e mensagens ao usuário em português. Comentário explica o porquê.
- **Envio a contato só por `executarEnvio` (`src/controle.ts`).** O Claude não recebe ferramenta
  de envio. Sai pelo `ok` do dono, ou pela autonomia que ele deu ao contato (`src/autonomia.ts`):
  nível 2 com janela de veto, nível 3 direto, e nunca com risco alto, `[preencher:]`, em grupo,
  entre 21h e 8h ou com `pausa`. Não crie outro caminho de envio nem afrouxe essas travas sem
  pedido explícito do Lucas.
- Exceção pedida pelo Lucas (05/11/2026): o MCP do Claude Code (`src/mcp.ts`) envia e cria
  grupo, só pelas sessões dele. Envio em dois passos: `preparar_mensagem` grava rascunho comum
  (avisado no canal do dono), `enviar_rascunho` passa por `executarEnvio`, depois do sim dele no
  chat. Criar grupo pede `confirmar: true`. Sem `envio` nas deps, o MCP volta a ser só leitura.
- Arquivo (1.18.0): sobe por `POST /arquivo` para a tabela `anexos` e vai num rascunho com
  `anexo_id`, que sai só pelo ok do dono: `reservarEnvio` recusa anexo no envio automático.
- E-mail e convite de evento (pedido do Lucas, 22/10/2026): saem por ordem dele, e só para
  endereço que ele mesmo digitou (`enderecosDoDono` em `src/controle.ts`, falas `dono` do
  `dialogo` nas últimas 24 h; a trava é `destinatarios` em `src/ferramentas_google.ts`).
  Nunca libere endereço do pedido montado pelo código, da fala do assistente ou de mensagem e
  e-mail de terceiros: é por aí que um texto de fora mandaria o assistente escrever a alguém.
- As travas do envio automático são conferidas no banco, no mesmo UPDATE que reserva o rascunho
  (`repo.reservarEnvio`): entre ler e enviar, o dono pode vetar, ajustar, pausar, baixar o nível,
  tirar a pessoa ou responder à mão. Não confira só em memória antes de enviar.
- Tudo que o assistente escreve ao dono passa pela função `avisar`: pelo bot do Telegram,
  quando `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID` existem (o WhatsApp não notifica mensagem
  da própria conta), ou pelo chat dele consigo mesmo, com 🤖, registrando o id em `enviadas`
  (senão o eco do webhook vira comando, em laço). Comandos valem nos dois canais.
- O Telegram só ouve `TELEGRAM_CHAT_ID`: mensagem de outro chat vai para o log, nunca vira
  comando. O token fica só no `.env` da VM.
- O que o assistente envia a um contato é gravado na conversa no próprio `executarEnvio`:
  a Evolution GO não devolve pelo webhook o que a API envia.
- Chat `excluido` não grava nada; `fora` apaga o que havia. Respeite isso em qualquer consulta nova.
- Conhecimento do dono: `perfil` (regra > lição > gerado) e a ficha em `contatos`. Os dois entram
  em todo rascunho e no agente por `perfilEmTexto`/`fichaEmTexto` (`src/repo.ts`).
- Endereço da pessoa: sempre o número. LID vira apelido (`apelidos`) e `registrarApelido` junta
  as conversas; consulta nova deve passar por `resolverJid`.
- Integrações opcionais (Google, KoreOS MCP, áudio, painel): sem a chave, a função some; o
  resto funciona. Google e Evolution ficam atrás de interfaces (`Google`, `Evolution`) com
  versões falsas nos testes.
- O Claude fica atrás da interface `Ia` (`src/ia.ts`). Modelos vêm de `MODELO`, `MODELO_EXTRACAO`
  e `MODELO_LEVE`. Toda chamada nova leva `funcao` (vira linha na tabela `consumo`) e, se for
  ler, resumir ou classificar, `peso: "leve"`. Custo é requisito do Lucas: antes de chamar
  modelo, veja se dá para resolver com dado ou regra (o resumo em texto não chama nenhum).
- Memória do chat de controle: tudo que entra e sai dele passa por `registrarFala` (`dialogo`),
  e o caderno (`src/memoria.ts`) guarda o que está em andamento. Pedido livre novo deve levar
  `contextoDoChat`, senão um "sim" fica sem referência.
- Nome de contato na tela ou em prompt: `nomeDe` / `NOME_SQL`, nunca o jid cru (o LID não é
  telefone). "Esperando resposta" sai de `espera_resposta`, não de "a última mensagem é dele".
- Teste: `npm run typecheck` (código e testes) e `npm test`; os fluxos com banco rodam com
  `DATABASE_URL_TESTE` apontando para um Postgres vazio (o teste apaga o schema).
- Tokens no caminho (webhook, painel) não podem ir para o log: `ocultarToken` em `src/server.ts`.
- Webhook da Evolution GO: mesmo formato que o KoreOS trata em
  `backend_koreos/controllers/evolutionWebhookController.js` (`data.Info` + `data.Message`).
