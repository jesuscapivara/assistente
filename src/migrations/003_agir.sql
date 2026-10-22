-- O que o dono está esperando do contato ("ele ficou de mandar as medidas"). É a base
-- das cobranças: sem isto, só dá para saber quem espera o dono, não o contrário.
ALTER TABLE contatos ADD COLUMN IF NOT EXISTS aguardando TEXT NOT NULL DEFAULT '';
ALTER TABLE contatos ADD COLUMN IF NOT EXISTS aguardando_desde TIMESTAMPTZ;
ALTER TABLE contatos ADD COLUMN IF NOT EXISTS cobrado_em TIMESTAMPTZ;

-- Autonomia por contato (0 só age quando o dono pede, 1 propõe resposta e espera ok,
-- 2 envia se não vetar a tempo, 3 envia direto o que é simples). NULL = AUTONOMIA_PADRAO.
ALTER TABLE contatos ADD COLUMN IF NOT EXISTS autonomia SMALLINT CHECK (autonomia BETWEEN 0 AND 3);

-- Datas que voltam todo ano (aniversário, casamento). Mês e dia: o ano não importa.
CREATE TABLE IF NOT EXISTS datas (
  id            SERIAL PRIMARY KEY,
  chat_jid      TEXT NOT NULL REFERENCES contatos(jid) ON DELETE CASCADE,
  descricao     TEXT NOT NULL,
  mes           SMALLINT NOT NULL CHECK (mes BETWEEN 1 AND 12),
  dia           SMALLINT NOT NULL CHECK (dia BETWEEN 1 AND 31),
  UNIQUE (chat_jid, mes, dia)
);

-- Rascunhos que o assistente propõe sozinho e, com autonomia, envia sozinho.
ALTER TABLE rascunhos ADD COLUMN IF NOT EXISTS automatico BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE rascunhos ADD COLUMN IF NOT EXISTS risco TEXT CHECK (risco IN ('baixo', 'alto'));
ALTER TABLE rascunhos ADD COLUMN IF NOT EXISTS motivo_risco TEXT NOT NULL DEFAULT '';
-- Quando sai se ninguém vetar (nível 2). NULL = só com ok.
ALTER TABLE rascunhos ADD COLUMN IF NOT EXISTS enviar_em TIMESTAMPTZ;
-- Mexido pelo dono ("ajusta") antes de sair: conta contra a taxa de acerto.
ALTER TABLE rascunhos ADD COLUMN IF NOT EXISTS ajustado BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS rascunhos_agendados ON rascunhos (enviar_em) WHERE status = 'aguardando' AND enviar_em IS NOT NULL;

-- Compromisso que foi para a agenda do Google.
ALTER TABLE compromissos ADD COLUMN IF NOT EXISTS evento_id TEXT;

-- Avisos já dados (urgência, briefing, cobrança, radar), para não repetir o mesmo.
CREATE TABLE IF NOT EXISTS alertas (
  chave         TEXT PRIMARY KEY,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);
