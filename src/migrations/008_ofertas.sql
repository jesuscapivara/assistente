-- Grupos de promoção (pedido do Lucas, 05/11/2026): ficam fora do assistente como
-- `excluido` (não grava nada, não lê, não custa), mas cada oferta que chega é comparada
-- com a lista de interesses dele, por regra, sem modelo. O que bate vira aviso.
ALTER TABLE contatos ADD COLUMN IF NOT EXISTS promo BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS interesses (
  id SERIAL PRIMARY KEY,
  -- Palavras que precisam aparecer na oferta; "-palavra" exclui.
  termos TEXT NOT NULL,
  -- Teto em reais; sem teto, qualquer preço serve.
  preco_max NUMERIC(12, 2),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Uma oferta repostada em vários grupos avisa uma vez só por interesse.
CREATE TABLE IF NOT EXISTS ofertas_avisadas (
  interesse_id INT NOT NULL REFERENCES interesses (id) ON DELETE CASCADE,
  chave TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  texto TEXT NOT NULL,
  preco NUMERIC(12, 2),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (interesse_id, chave)
);
