-- Arquivos das conversas (pedido do Lucas, 05/11/2026): para baixar um documento, foto,
-- vídeo ou áudio depois, a Evolution precisa da mensagem original (chave e caminho da
-- mídia no WhatsApp). Guarda só isso, sem a miniatura; o arquivo em si não fica aqui.
ALTER TABLE mensagens ADD COLUMN IF NOT EXISTS midia JSONB;
CREATE INDEX IF NOT EXISTS mensagens_arquivos ON mensagens (enviada_em DESC) WHERE midia IS NOT NULL;

-- E para enviar: o arquivo sobe antes (o Claude Code manda pelo POST /arquivo) e fica aqui
-- até o dono aprovar o rascunho, que pode levar horas. A limpeza apaga depois de 30 dias.
CREATE TABLE IF NOT EXISTS anexos (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  mimetype TEXT NOT NULL,
  dados BYTEA NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE rascunhos ADD COLUMN IF NOT EXISTS anexo_id INT REFERENCES anexos (id) ON DELETE SET NULL;
