# Assistente

Assistente pessoal ligado ao WhatsApp do Lucas. Lê as conversas (individuais e grupos),
guarda o que importa, lembra compromissos e escreve respostas na voz dele, que **só saem
com o "ok" dele**.

## Como funciona

```
WhatsApp pessoal ── Evolution GO (instância própria, mesma engine do KoreOS)
                        │ webhook
                        ▼
                    assistente (Node/TS) ── Postgres
                        │
                        ├─ grava as mensagens (texto; áudio transcrito se houver OPENAI_API_KEY)
                        ├─ extração (Claude): compromissos, promessas e fatos de cada pessoa,
                        │   quando a conversa assenta (3 min sem mensagem)
                        ├─ resumo da manhã (07:30): agenda, promessas, quem espera resposta
                        └─ canal de controle: o seu chat consigo mesmo ("mensagem para você")
```

Tudo que o assistente diz chega no seu chat consigo mesmo, começando com 🤖.

### O que você pode mandar nesse chat

| Mensagem | O que faz |
|---|---|
| `o que eu combinei com a Fernanda?` | pergunta livre: ele procura nas conversas e responde |
| `responde o João dizendo que amanhã não dá` | escreve um rascunho na sua voz e manda para você ver |
| `ok` / `ok 12` | envia o rascunho (sem número: o último) |
| `ajusta 12 mais curto, sem emoji` | refaz o rascunho |
| `descarta 12` | joga fora |
| `confirma 5` · `feito 5` · `ignora 5` | compromissos anotados |
| `fora Grupo da Família` | tira a conversa ou o grupo do assistente e **apaga** o que já tinha |
| `volta Grupo da Família` | põe de volta (a partir de agora) |
| `resumo` | o resumo do dia, na hora |
| `ajuda` | a lista de comandos |

Rascunho com `[preencher: …]` não sai: ajuste antes.

### O que ele nunca faz

- Enviar mensagem a alguém sem o seu "ok" (não existe ferramenta de envio para o Claude).
- Ler conversa marcada com `fora`.
- Inventar data, valor ou fato: o que falta vira `[preencher: …]`.

## Instalação na VM de staging

Pré-requisitos: Docker, e a Evolution GO do KoreOS rodando na mesma VM.

1. **Clonar e configurar**
   ```bash
   git clone https://github.com/jesuscapivara/assistente && cd assistente
   cp .env.example .env
   ```
   Preencha no `.env`:
   - `POSTGRES_PASSWORD`, `WEBHOOK_TOKEN` (`openssl rand -hex 24` serve para os dois).
   - `EVOLUTION_NETWORK` e `EVOLUTION_API_URL`: a rede e o nome do container da Evolution
     (`docker ps | grep evolution` e `docker network ls`).
   - `EVOLUTION_GLOBAL_API_KEY`: a mesma do KoreOS (só para criar a instância).
   - `WEBHOOK_URL_PUBLICA=http://assistente:3100/webhook/<WEBHOOK_TOKEN>`.
   - `DONO_NUMERO` (só dígitos, com 55), `ANTHROPIC_API_KEY`, e `OPENAI_API_KEY` se quiser áudio.

2. **Subir**
   ```bash
   docker compose up -d --build
   docker compose logs -f assistente   # "assistente no ar"
   ```

3. **Ligar o seu número** (cria a instância, aponta o webhook e gera o código de pareamento)
   ```bash
   docker compose run --rm assistente node scripts/conectar.mjs --telefone 5551999990000
   ```
   No celular: *WhatsApp > Aparelhos conectados > Conectar com número de telefone* e digite o
   código. Copie o `EVOLUTION_INSTANCE_TOKEN` que o script imprimir para o `.env` e reinicie:
   `docker compose up -d`.

4. **Testar**: mande `ajuda` no seu chat consigo mesmo. A resposta chega com 🤖.
   Se não chegar, veja `docker compose logs assistente`. Se o seu chat consigo mesmo vier
   como `...@lid` (WhatsApp novo), o log mostra o JID: coloque em `DONO_LIDS`.

## Desenvolvimento

```bash
npm install
npm run typecheck
npm test                                   # testes de unidade
DATABASE_URL_TESTE=postgres://... npm test # inclui o fluxo contra um Postgres vazio
```

Modelos: `MODELO` (rascunho, resumo, perguntas) e `MODELO_EXTRACAO` (cada conversa nova).
Os dois começam em `claude-opus-5-5`. A extração roda para cada conversa que se mexe, então é
onde o custo cresce: se o volume de grupos pesar, dá para trocar só `MODELO_EXTRACAO` por um
modelo menor.

## Privacidade

- Tudo fica no Postgres da VM. Nada é reenviado a terceiros além das chamadas ao Claude (e à
  transcrição de áudio, se ligada).
- O texto bruto das mensagens é apagado depois de `RETENCAO_DIAS` (padrão 365). A memória
  resumida de cada pessoa fica.
- `fora <nome>` apaga na hora tudo que havia daquela conversa.
