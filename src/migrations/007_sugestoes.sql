-- Sugestões do que responder ("Sábado às 10h", "Próxima semana"), escritas na mesma
-- leitura que já define a situação da conversa: o painel mostra como atalhos, e o toque
-- vira o pedido de um rascunho. Lista JSON de textos curtos.
ALTER TABLE contatos ADD COLUMN IF NOT EXISTS sugestoes TEXT NOT NULL DEFAULT '[]';
