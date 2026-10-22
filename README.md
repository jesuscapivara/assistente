# Assistente

Assistente pessoal ligado ao WhatsApp do Lucas. Lê as conversas, aprende quem é quem e
como ele escreve, cuida da agenda, cobra quem ficou devendo, avisa do que é urgente e
responde por ele, **na medida da autonomia que ele der a cada contato**.

## O que ele faz

**Conhece você e as pessoas**
- Ao conectar, recebe as conversas recentes do WhatsApp e lê tudo para montar a **ficha de
  cada pessoa**: relação (cliente, família, amigo, trabalho, fornecedor), quem é, **como você
  fala com ela**, assuntos em aberto, fatos e datas (aniversário).
- Monta o **seu perfil** em três camadas, nesta ordem de autoridade: as *regras* que você dá,
  as *lições* das suas correções (rascunho descartado + a versão que você mandou, e os
  `ajusta`) e o *retrato* que ele escreve a partir das suas mensagens.
- A mesma pessoa pelo número e pelo LID do WhatsApp novo vira uma conversa só.

**Cuida das coisas**
- Lê compromissos e promessas nas conversas. Compromisso seu para as próximas 48h vira aviso
  na hora; `confirma N` coloca na agenda do Google.
- Sabe o que **você está esperando** de cada um ("ele ficou de mandar as medidas") e, depois
  de alguns dias, pergunta se é para cobrar.
- Com Google ligado: vê e cria eventos (sem convidados), sugere horários livres, lê e busca
  e-mails e deixa **rascunho** de resposta no Gmail.
- Com KoreOS ligado: consulta projetos, tarefas, clientes, financeiro e pranchas pelo MCP do
  KoreOS (pergunta antes de alterar algo lá).

**É proativo**
- ⚡ Urgência na hora (prazo para hoje, problema, cliente insatisfeito).
- 📅 Briefing antes de cada reunião: quem é, onde a conversa parou, o que está combinado.
- ☀️ Resumo da manhã (07:30) **em imagem**: o dia desenhado como relevo (a altura é a carga de
  reuniões), uma frase de abertura, três blocos de horário, o que precisa de você e o que já se
  resolveu. Os `#N` dos compromissos vão na legenda. Sem imagem, ou se ela falhar, vai em texto.
- O que ficou aberto do dia (18h), cobranças (10h) e a revisão da semana com o radar de quem
  você não procura há tempo (domingo, 18h30).

**Entende o contexto**
- Cada conversa tem uma **situação** em uma frase, que junta a última mensagem ao que veio
  antes ("você convidou a Ana para a obra; ela disse que sábado está livre — falta propor o
  horário"). É ela que aparece no resumo, e não a frase solta.
- "Esperando resposta" é quem de fato espera: "tá ok", "disponha" e emoji não entram, robô
  (banco, notificação do KoreOS) não entra, e quem você respondeu pelo celular sai na hora.
- O chat de controle tem memória: as últimas falas dos dois lados e um **caderno** curto do que
  está em andamento entre vocês. Um "sim" responde ao que ele acabou de propor.
- Contato sem nome aparece pelo que se sabe dele, nunca como número de LID. Os nomes da agenda
  do celular vêm da Evolution na subida e toda madrugada.

**Responde por você, até onde você deixar**

| Nível | O que ele faz quando alguém espera resposta |
|---|---|
| 0 (padrão) | nada: só quando você pede ("responde a Fernanda que…") |
| 1 | propõe a resposta e espera o seu `ok` |
| 2 | envia sozinho se você não vetar em 10 min |
| 3 | envia direto o que for simples e te avisa |

Em qualquer nível, **dinheiro, preço, contrato, prazo, assunto delicado ou rascunho com
`[preencher: …]` esperam o seu ok**: há uma barreira por palavras, sem modelo, e outra de
classificação de risco. Grupo nunca recebe resposta automática, e nada sai sozinho entre 21h e
8h. Se você responder à mão antes de a janela de veto acabar, a resposta automática não sai.
`pausa` desliga tudo na hora.

## Canal de controle

Tudo acontece no seu chat consigo mesmo ("mensagem para você"); o que ele escreve começa com
🤖. Vale texto ou áudio (com `OPENAI_API_KEY`).

| Mensagem | O que faz |
|---|---|
| `o que eu combinei com a Fernanda?` | pergunta livre: ele procura nas conversas, agenda, e-mail e KoreOS |
| `responde o João dizendo que amanhã não dá` | rascunho na sua voz, para aprovar |
| `marca com a Fernanda quinta à tarde` | vê horários livres e cria o evento |
| `ok 12` · `ajusta 12 mais curto` · `descarta 12` / `veta 12` | rascunhos (sem número, só se houver um aguardando) |
| `confirma 5` · `feito 5` · `ignora 5` | compromissos |
| `cobra João` | rascunho cobrando o que ele ficou de mandar |
| `autonomia` · `autonomia Fernanda 2` | níveis e taxa de aprovação sem ajuste |
| `pausa` · `retoma` | desliga e religa todo envio automático |
| `perfil` · `regra nunca marco nada antes das 9` · `esquece 4` | o que ele sabe de você |
| `estuda` | atualiza agora as fichas e o seu retrato |
| `fora Grupo da Família` · `volta Grupo da Família` | tira (e apaga) ou devolve uma conversa |
| `custo` | gasto com o Claude hoje, em 7 e em 30 dias, e por função |
| `caderno` · `esquece caderno` | o que ele está acompanhando entre vocês; zera |
| `resumo` · `ajuda` | |

O **painel web** (opcional) mostra a mesma coisa numa tela: rascunhos para aprovar,
compromissos, quem espera resposta, pessoas com o nível de autonomia de cada uma, e o seu
perfil. Os botões viram os mesmos comandos.

## Instalação na VM de staging

Pré-requisitos: Docker e a Evolution GO do KoreOS rodando na mesma VM.

1. **Configurar**
   ```bash
   git clone https://github.com/jesuscapivara/assistente && cd assistente
   cp .env.example .env
   ```
   Obrigatórios no `.env`:
   - `POSTGRES_PASSWORD`, `WEBHOOK_TOKEN` e `EVOLUTION_INSTANCE_TOKEN` (`openssl rand -hex 24`
     para cada um);
   - `EVOLUTION_NETWORK` e `EVOLUTION_API_URL` (`docker ps | grep evolution`, `docker network ls`);
   - `EVOLUTION_GLOBAL_API_KEY`, a mesma do KoreOS (só para criar a instância);
   - `WEBHOOK_URL_PUBLICA=http://assistente:3100/webhook/<WEBHOOK_TOKEN>`;
   - `DONO_NUMERO` (só dígitos, com 55) e `ANTHROPIC_API_KEY`.

2. **Subir**: `docker compose up -d --build`, e `docker compose logs -f assistente` deve mostrar
   "assistente no ar".

3. **Ligar o seu número**
   ```bash
   docker compose run --rm assistente node scripts/conectar.mjs --telefone 5551999990000
   ```
   No celular: *WhatsApp > Aparelhos conectados > Conectar com número de telefone* e digite o
   código. O serviço já está no ar e recebe o histórico: uns minutos depois chega "Recebi N
   mensagens antigas…". (Se a instância já existia com outro token, o script imprime o token
   dela: troque no `.env` e rode `docker compose up -d`.)

4. **Testar**: mande `ajuda` no seu chat consigo mesmo. Se não responder, veja o log; se o seu
   chat consigo mesmo vier como `...@lid`, coloque o JID em `DONO_LIDS`.

### Opcionais

- **Áudio** (transcrição e comando falado): `OPENAI_API_KEY`.
- **Google (agenda e Gmail)**: no Google Cloud Console, ative as APIs *Google Calendar* e
  *Gmail*, crie um *OAuth client ID* do tipo *Desktop app* e, **no seu computador**, rode
  `GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… node scripts/google.mjs`. Autorize no navegador e
  copie os três valores para o `.env`. Se o app ficar em modo "teste" no Google, adicione o seu
  e-mail como usuário de teste (e o token pode expirar em 7 dias até publicar o app).
- **KoreOS**: gere um token MCP no KoreOS (Configurações > Integrações > MCP) e preencha
  `KOREOS_MCP_URL=https://<api do KoreOS>/api/mcp/server` e `KOREOS_MCP_TOKEN=kore_mcp_…`.
- **Painel**: `PAINEL_TOKEN` (24+ caracteres). O compose publica a porta só em
  `127.0.0.1:3100` da VM: acesse por túnel (`ssh -L 3100:127.0.0.1:3100 vm` e abra
  `http://localhost:3100/painel/<PAINEL_TOKEN>`) ou ponha atrás do proxy da VM com HTTPS.

### Atualizar

`git pull && docker compose up -d --build`. As migrações do banco rodam sozinhas na subida.

## Desenvolvimento

```bash
npm install
npm run typecheck                          # código e testes
npm test                                   # testes de unidade
DATABASE_URL_TESTE=postgres://... npm test # inclui os fluxos contra um Postgres vazio
```

### Custo

Cada chamada ao Claude fica na tabela `consumo` (função, modelo, tokens), e o comando `custo`
soma em dólares. Três modelos, por tipo de trabalho:

| Variável | Padrão | Faz |
|---|---|---|
| `MODELO` | `claude-sonnet-5-5` | rascunho na sua voz, perguntas livres, retrato semanal, risco do envio automático |
| `MODELO_EXTRACAO` | `claude-haiku-5-5` | leitura de cada conversa que se mexe |
| `MODELO_LEVE` | `claude-haiku-5-5` | fichas, lições, briefing, cartão do resumo, caderno, revisão da semana |

O que não chama modelo nenhum: o resumo em texto; mensagem sem conteúdo ("ok", "kkk",
figurinha); grupo em que você não falou nem foi citado. As ferramentas do KoreOS só vão ao
agente quando o pedido é sobre o escritório.

Ficou de fora, de propósito, a API de lote (metade do preço) no estudo da madrugada: no Haiku,
as 25 fichas da noite custam por volta de US$ 0,02, e o lote atrasaria as fichas em horas para
economizar um centavo.

Para ver o cartão sem banco nem Claude: `npx tsx scripts/cartao-exemplo.ts cartao.png`.

## Privacidade e segurança

- Tudo fica no Postgres da VM; sai só para o Claude (e para a transcrição e o Google, se ligados).
- Texto bruto apagado depois de `RETENCAO_DIAS` (365); a ficha e a memória de cada pessoa ficam.
- `fora <nome>` apaga na hora tudo daquela conversa: mensagens, ficha, compromissos, datas e rascunhos.
- Webhook, painel e engine sem porta pública; os tokens não aparecem no log.
- E-mail nunca é enviado (só rascunho no Gmail); evento nunca leva convidado.
