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
- Com Google ligado: vê e cria eventos, sugere horários livres, lê e busca e-mails e deixa
  **rascunho** de resposta no Gmail. Quando você manda ("pode mandar", "inclui ele no meet"),
  envia o e-mail e convida para o evento, só para endereço que você escreveu no chat.
- Com KoreOS ligado: consulta projetos, tarefas, clientes, financeiro e pranchas pelo MCP do
  KoreOS (pergunta antes de alterar algo lá).

**É proativo**
- 🛒 Ofertas: nos grupos marcados com `promo`, cada mensagem é comparada com a sua lista de
  interesses, por regra (palavras e preço, sem modelo, sem gravar a mensagem). Bateu, chega o
  aviso; a mesma oferta repostada em outro grupo não avisa de novo.
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
- Aprende com as suas correções de leitura: cada `errado N` (ou "isso está errado" no chat)
  corrige o item e vira uma lição geral que vai em toda leitura seguinte. Elas aparecem em
  `perfil` e saem com `esquece N`.
- **Ficou para trás**: quem espera você há 3 dias ou mais (a ligação prometida que não saiu)
  tem seção própria no resumo e no cartão, do mais antigo para o mais novo, com quantos dias.
- O resumo traz o KoreOS: suas tarefas que vencem hoje ou estão atrasadas e as contas do dia,
  lidas direto pelo MCP, sem passar pelo Claude.
- Contato sem nome aparece pelo que se sabe dele, nunca como número de LID. Os nomes da agenda
  do celular vêm da Evolution na subida e toda madrugada. O nome dos grupos vem do WhatsApp (`/group/list`) nas mesmas horas e acompanha quando alguém renomeia.

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
| `promo Emipe Promoções` | grupo de promoção: sai do assistente (como o `fora`), mas cada oferta passa pelos seus interesses |
| `acompanha Obra Largo do Rosário` · `solta Obra Largo do Rosário` | grupo de obra ou projeto lido sempre (não só quando citam você), com as fotos descritas |
| `interesse monitor 27 até 900` · `interesses` · `esquece interesse 2` | avisa quando sair oferta com todas as palavras (`-palavra` exclui) e até o teto; a lista mostra os grupos vigiados e o que já bateu |
| `resolvi B` · `adia B sábado` · `ignora B` · `responde B <o quê>` · `cobra B` | pelas letras do último resumo (cartão ou texto). `resolvi` é para o que você resolveu por fora (ligação, pessoalmente), que o WhatsApp não vê; `adia` aceita amanhã, sábado, 3 dias, 25/10, e a pessoa volta antes se escrever; `ignora` tira e ensina que aquilo não pedia resposta. Frase livre também vale: "já liguei pro Bruno" |
| `errado 1 quem vai ler é ele` | corrige o compromisso 1 e aprende para as próximas leituras; para o resto, diga com suas palavras ("a Thaís é notificação do KoreOS") |
| `custo` | gasto com o Claude hoje, em 7 e em 30 dias, e por função |
| `caderno` · `esquece caderno` | o que ele está acompanhando entre vocês; zera |
| `resumo` · `ajuda` | |

O **painel web** é um app de quatro abas, no mesmo desenho do cartão (maquete validada em
`docs/maquetes/painel-v2.html`):

- **Hoje**: a próxima coisa ("em 25 min: ligar para…" com o botão Liguei), a linha do dia
  (reuniões, promessas suas e prazos, com a marca de agora), rascunhos para aprovar, e cada
  pendência como um cartão com as últimas mensagens, sugestões de resposta e Resolvi,
  Adiar e Ignorar. Também "Ficou para trás", o que os outros ficaram de fazer e o KoreOS.
- **Conversas**: quem espera você, todas, e-mails e grupos; a conversa aberta com a
  situação, os atalhos de resposta e o rascunho na sua voz.
- **Pessoas**: busca e filtros (clientes, família, sumidos, aniversários) e a ficha de cada
  uma, com "corrigir algo que entendi errado" e a autonomia.
- **Assistente**: perguntar com a resposta na tela, o gasto por dia e por função, o
  caderno, as regras e as lições.

Nenhuma tela chama modelo; só Perguntar e Escrever rascunho, quando usados. As sugestões
de resposta saem da mesma leitura que já define a situação da conversa. Os comandos de
sempre respondem no WhatsApp; as ações dos itens confirmam na própria tela.

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
- **Telegram** (avisos com notificação): no WhatsApp o assistente fala pela sua própria
  conta, e mensagem da própria conta não notifica. Crie um bot no @BotFather, ponha o token
  em `TELEGRAM_BOT_TOKEN`, mande qualquer mensagem ao bot e pegue o seu id no log
  ("mensagem de chat que não é o do dono") para `TELEGRAM_CHAT_ID`. Daí em diante avisos e
  resumo vão pelo bot, e os comandos (texto ou áudio) valem lá e no chat consigo mesmo.
- **Google (agenda e Gmail)**: no Google Cloud Console, ative as APIs *Google Calendar* e
  *Gmail*, crie um *OAuth client ID* do tipo *Desktop app* e, **no seu computador**, rode
  `GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… node scripts/google.mjs`. Autorize no navegador e
  copie os três valores para o `.env`. Se o app ficar em modo "teste" no Google, adicione o seu
  e-mail como usuário de teste (e o token pode expirar em 7 dias até publicar o app).
- **KoreOS**: gere um token MCP no KoreOS (Configurações > Integrações > MCP) e preencha
  `KOREOS_MCP_URL=https://<api do KoreOS>/api/mcp/server` e `KOREOS_MCP_TOKEN=kore_mcp_…`.
- **Painel**: `PAINEL_TOKEN` (24+ caracteres). O compose publica a porta só em
  `127.0.0.1:3100` da VM, e o acesso é pelo **Tailscale**: `tailscale serve --bg 3100` na VM
  dá um endereço `https://<máquina>.<rede>.ts.net` que só existe para os aparelhos da sua
  rede do Tailscale. Abra `https://<máquina>.<rede>.ts.net/painel/<PAINEL_TOKEN>`. Nenhuma
  porta pública, nenhum DNS. Sem Tailscale, por túnel SSH:
  `ssh -L 3100:127.0.0.1:3100 vm` e `http://localhost:3100/painel/<PAINEL_TOKEN>`.
- **MCP para o Claude Code**: `MCP_TOKEN` (32+ caracteres, `openssl rand -hex 32`)
  liga `POST /mcp`, com o token no cabeçalho `Authorization: Bearer`. Seis ferramentas:
  `buscar_contato`, `ler_conversa` (com `ate` para voltar no tempo e `desde` para ler só o
  novo), `buscar_mensagens`, `conversas_recentes` (por dias ou `desde`), `novidades` (tudo que
  chegou depois de um instante, por conversa, numa chamada: é o que atualiza as anotações do
  Claude Code sem ler conversa por conversa) e `pendencias`; conversa tirada com `fora` não aparece. Com envio ligado, também `adicionar_interesse`,
  `remover_interesse` e `marcar_promocao` (pede `confirmar: true`); `interesses` lista.
  Desde a 1.16.0: `exportar` devolve em JSON tudo o que o assistente sabe de cada conversa
  (ficha, espera, compromissos, datas), para gerar anotações por script, sem modelo; e, com
  envio ligado, `concluir_compromisso` (feito/descartado) e `anotar_aguardando` (vazio limpa).
  Desde a 1.17.0: `resumo_do_dia` (o texto do resumo da manhã, sem modelo) e, com envio,
  `acompanhar_grupo`. PDF que chega numa conversa tem o texto lido (sem modelo, até 3.000
  caracteres) e gravado junto do nome do arquivo: entra na busca e na leitura.
  Desde a 1.18.0: `arquivos` lista os documentos, fotos, vídeos e áudios que dá para baixar,
  e `GET /arquivo/<id>` (mesmo `Authorization` do MCP) entrega o arquivo, buscado na hora pela
  Evolution. Só vale para o que chegou depois da 1.18.0: antes, a mensagem original (com a
  chave da mídia) não era guardada. Para **enviar** arquivo: `POST /arquivo` (mesmo `Authorization`,
  `Content-Type: application/octet-stream`, nome em `X-Nome-Arquivo` codificado em URL, até
  64 MB) devolve o id do anexo; `preparar_mensagem` com `anexo` faz o rascunho (o texto vira
  legenda, e o aviso no seu canal mostra 📎) e ele só sai com o seu sim, por `executarEnvio`. Desde a 1.13.0
  também envia, em dois passos: `preparar_mensagem` grava um rascunho (que chega no seu canal,
  onde vale `ok`/veto) e `enviar_rascunho` manda depois do seu sim na sessão; `criar_grupo`
  só cria com `confirmar: true`. Para valer em toda sessão, registre no escopo do usuário, pelo mesmo
  endereço do Tailscale do painel:
  `claude mcp add --transport http -s user whatsapp https://<máquina>.<rede>.ts.net/mcp --header "Authorization: Bearer <MCP_TOKEN>"`.
  Sem Tailscale, com o túnel SSH aberto: `http://localhost:3100/mcp`.

### Backup

O serviço `backup` do compose faz um dump do banco na subida e todo dia às 03:30, em
`./backups`, por 14 dias. Fica na mesma VM: protege de migração errada e de apagar dado sem
querer, não de perder o disco. Restaurar:
`gunzip -c backups/<arquivo>.sql.gz | docker compose exec -T db psql -U assistente assistente`.

### Atualizar

A VM (`koreos-vps`, em `/root/assistente`) não tem credencial do GitHub e roda a API de
produção do KoreOS com 2 CPUs. Por isso o código vai por pacote do git e a imagem é montada
fora dela:

```bash
git bundle create /tmp/a.bundle <commit-da-vm>..HEAD && scp /tmp/a.bundle koreos-vps:/tmp/
ssh koreos-vps "cd /root/assistente && git fetch /tmp/a.bundle HEAD && git merge --ff-only FETCH_HEAD"
git archive HEAD | tar -x -C /tmp/ctx && docker build -t assistente-assistente:latest /tmp/ctx
docker save assistente-assistente:latest | gzip -1 | ssh koreos-vps docker load
ssh koreos-vps "cd /root/assistente && docker compose up -d --no-build"
```

As migrações do banco rodam sozinhas na subida.

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
- O MCP do Claude Code só envia rascunho que você aprovou na sessão, sempre por `executarEnvio`,
  e cada rascunho é avisado no seu canal. O que ele devolve vai para o contexto da sessão do Claude Code
  (e daí para a Anthropic), como já acontece com o agente do assistente.
- E-mail só é enviado, e convite só é mandado, por ordem sua e para endereço que **você**
  digitou no chat ou no painel nas últimas 24 h. Endereço tirado de mensagem ou e-mail de
  outra pessoa é recusado (um texto de terceiro não consegue mandar o assistente escrever
  para alguém). Sem ordem de enviar, fica em rascunho.
