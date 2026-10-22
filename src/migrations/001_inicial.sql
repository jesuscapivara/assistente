-- Contatos e grupos. `memoria` é o que o assistente sabe da pessoa, em linhas curtas,
-- e é o que fica quando o texto bruto expira.
CREATE TABLE IF NOT EXISTS contatos (
  jid           TEXT PRIMARY KEY,
  nome          TEXT,
  nome_push     TEXT,
  grupo         BOOLEAN NOT NULL DEFAULT FALSE,
  -- Fora do assistente: não grava mensagem nem extrai nada. Decidido pelo dono.
  excluido      BOOLEAN NOT NULL DEFAULT FALSE,
  memoria       TEXT NOT NULL DEFAULT '',
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mensagens (
  id            TEXT PRIMARY KEY,           -- id do WhatsApp: o webhook pode repetir
  chat_jid      TEXT NOT NULL REFERENCES contatos(jid) ON DELETE CASCADE,
  remetente_jid TEXT,
  remetente_nome TEXT,
  de_mim        BOOLEAN NOT NULL,
  tipo          TEXT NOT NULL,              -- texto | audio | imagem | video | documento | outro
  texto         TEXT NOT NULL DEFAULT '',
  enviada_em    TIMESTAMPTZ NOT NULL,
  extraida      BOOLEAN NOT NULL DEFAULT FALSE,
  criada_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mensagens_chat_data ON mensagens (chat_jid, enviada_em DESC);
CREATE INDEX IF NOT EXISTS mensagens_pendentes ON mensagens (chat_jid) WHERE NOT extraida;
CREATE INDEX IF NOT EXISTS mensagens_busca ON mensagens USING GIN (to_tsvector('portuguese', texto));

-- Compromissos e promessas achados nas conversas. Nascem `sugerido`: o dono confirma.
CREATE TABLE IF NOT EXISTS compromissos (
  id            SERIAL PRIMARY KEY,
  chat_jid      TEXT NOT NULL REFERENCES contatos(jid) ON DELETE CASCADE,
  descricao     TEXT NOT NULL,
  quando        TIMESTAMPTZ,
  responsavel   TEXT NOT NULL CHECK (responsavel IN ('eu', 'contato', 'ambos')),
  status        TEXT NOT NULL DEFAULT 'sugerido'
                CHECK (status IN ('sugerido', 'confirmado', 'feito', 'descartado')),
  mensagem_id   TEXT,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS compromissos_abertos ON compromissos (status, quando);

-- Respostas escritas pelo assistente. Só saem com o "ok" do dono no canal de controle.
CREATE TABLE IF NOT EXISTS rascunhos (
  id            SERIAL PRIMARY KEY,
  chat_jid      TEXT NOT NULL REFERENCES contatos(jid) ON DELETE CASCADE,
  texto         TEXT NOT NULL,
  pedido        TEXT NOT NULL DEFAULT '',   -- o que o dono pediu, para refazer no "ajusta"
  status        TEXT NOT NULL DEFAULT 'aguardando'
                CHECK (status IN ('aguardando', 'enviado', 'descartado')),
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  decidido_em   TIMESTAMPTZ
);

-- Mensagens que o próprio assistente mandou. O webhook devolve cada uma como "de mim";
-- sem esta lista, a resposta no canal de controle viraria um comando novo, em laço.
CREATE TABLE IF NOT EXISTS enviadas (
  id            TEXT PRIMARY KEY,
  criada_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS estado (
  chave         TEXT PRIMARY KEY,
  valor         TEXT NOT NULL
);
