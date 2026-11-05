-- Preço de toda oferta que casa com um interesse, mesmo acima do teto (pedido do Lucas,
-- 05/11/2026: "não tenho noção se está barato"). O aviso compara com o menor já visto.
CREATE TABLE IF NOT EXISTS precos_vistos (
  id SERIAL PRIMARY KEY,
  interesse_id INT NOT NULL REFERENCES interesses (id) ON DELETE CASCADE,
  preco NUMERIC(12, 2) NOT NULL,
  visto_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS precos_vistos_interesse ON precos_vistos (interesse_id, visto_em);
