-- Grupo acompanhado (pedido do Lucas, 05/11/2026): grupo de obra ou de projeto é lido
-- sempre, como uma conversa individual, e as fotos dele são descritas. Os outros grupos
-- continuam só quando citam o dono, que é o que mantém o custo baixo.
ALTER TABLE contatos ADD COLUMN IF NOT EXISTS acompanhado BOOLEAN NOT NULL DEFAULT FALSE;
