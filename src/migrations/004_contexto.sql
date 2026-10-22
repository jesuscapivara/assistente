-- Onde cada conversa está, em uma frase, do ponto de vista do dono ("você convidou a
-- Ana para jantar; ela disse que sábado está livre — falta propor horário"). A última
-- mensagem sozinha não diz nada ("Sábado eu estaria mais livre"): é isto que vai para o
-- resumo e para o agente.
ALTER TABLE contatos ADD COLUMN IF NOT EXISTS situacao TEXT NOT NULL DEFAULT '';
-- Se o contato espera algo do dono, segundo a última leitura da conversa. Substitui o
-- "a última mensagem é dele", que punha "Tá ok" e "Disponha!" na lista de pendências.
ALTER TABLE contatos ADD COLUMN IF NOT EXISTS espera_resposta BOOLEAN NOT NULL DEFAULT FALSE;
-- Notificação automática (banco, loja, o próprio KoreOS): não é gente, não espera resposta.
ALTER TABLE contatos ADD COLUMN IF NOT EXISTS sistema BOOLEAN NOT NULL DEFAULT FALSE;

-- O chat de controle, nos dois sentidos: o que o dono pediu e o que o assistente
-- respondeu. Sem isto, cada mensagem chega sozinha ao modelo e um "sim" não tem a quê
-- responder. `refs` guarda quem foi citado (nome → jid), para "responde o segundo".
CREATE TABLE IF NOT EXISTS dialogo (
  id            SERIAL PRIMARY KEY,
  autor         TEXT NOT NULL CHECK (autor IN ('dono', 'assistente')),
  texto         TEXT NOT NULL,
  refs          TEXT NOT NULL DEFAULT '',
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dialogo_recente ON dialogo (criado_em DESC);

-- Quando o compromisso foi fechado (feito ou ignorado): é o "resolvido" do resumo.
ALTER TABLE compromissos ADD COLUMN IF NOT EXISTS decidido_em TIMESTAMPTZ;

-- Cada chamada ao Claude, com os tokens: o comando `custo` e qualquer decisão de
-- economia saem daqui, não de estimativa.
CREATE TABLE IF NOT EXISTS consumo (
  id            SERIAL PRIMARY KEY,
  funcao        TEXT NOT NULL,
  modelo        TEXT NOT NULL,
  entrada       INTEGER NOT NULL DEFAULT 0,
  saida         INTEGER NOT NULL DEFAULT 0,
  cache_leitura INTEGER NOT NULL DEFAULT 0,
  cache_escrita INTEGER NOT NULL DEFAULT 0,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS consumo_data ON consumo (criado_em);
