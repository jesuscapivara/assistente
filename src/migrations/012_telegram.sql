-- Grupos e canais do Telegram do dono, lidos pela conta dele (pedido do Lucas, 05/11/2026:
-- o Pegue Promo só existe lá). Só o nome: nenhuma mensagem é guardada; os marcados `promo`
-- passam pelos interesses, como os grupos de promoção do WhatsApp.
CREATE TABLE IF NOT EXISTS telegram_chats (
  chat_id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  promo BOOLEAN NOT NULL DEFAULT false,
  visto_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
