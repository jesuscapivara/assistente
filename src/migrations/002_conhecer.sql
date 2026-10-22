-- Ficha de cada pessoa: além dos fatos soltos (`memoria`), o que ela é para o dono e
-- como ele fala com ela. É o que deixa o rascunho certo para cliente e para a mãe.
ALTER TABLE contatos ADD COLUMN IF NOT EXISTS relacao TEXT
  CHECK (relacao IN ('cliente', 'familia', 'amigo', 'trabalho', 'fornecedor', 'outro'));
ALTER TABLE contatos ADD COLUMN IF NOT EXISTS resumo TEXT NOT NULL DEFAULT '';
ALTER TABLE contatos ADD COLUMN IF NOT EXISTS tom TEXT NOT NULL DEFAULT '';
ALTER TABLE contatos ADD COLUMN IF NOT EXISTS assuntos_abertos TEXT NOT NULL DEFAULT '';
ALTER TABLE contatos ADD COLUMN IF NOT EXISTS ficha_em TIMESTAMPTZ;

-- A mesma pessoa chega com dois endereços: o número (`...@s.whatsapp.net`) e o LID
-- (`...@lid`) do WhatsApp novo. O apelido aponta o LID para o número, e tudo é gravado
-- no número.
CREATE TABLE IF NOT EXISTS apelidos (
  jid           TEXT PRIMARY KEY,
  principal     TEXT NOT NULL
);

-- Mensagens que o assistente enviou a contatos (pelo "ok"). Separa o que ele escreveu
-- do que o dono escreveu à mão, que é o que ensina o estilo.
ALTER TABLE rascunhos ADD COLUMN IF NOT EXISTS mensagem_id TEXT;
ALTER TABLE rascunhos ADD COLUMN IF NOT EXISTS aprendido BOOLEAN NOT NULL DEFAULT FALSE;

-- Quem o dono é. Três fontes, em ordem de autoridade:
--   regra   — o que ele mandou o assistente lembrar ("nunca marco antes das 9");
--   licao   — o que o assistente aprendeu comparando rascunho e o que ele mandou;
--   gerado  — o retrato que o assistente escreve a partir das mensagens dele.
CREATE TABLE IF NOT EXISTS perfil (
  id            SERIAL PRIMARY KEY,
  tipo          TEXT NOT NULL CHECK (tipo IN ('regra', 'licao', 'gerado')),
  texto         TEXT NOT NULL,
  ativo         BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS perfil_ativo ON perfil (tipo) WHERE ativo;
