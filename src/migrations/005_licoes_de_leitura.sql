-- Lição de leitura: o que o dono corrigiu no que o assistente entendeu de uma conversa
-- ("quem promete 'vou ler' é quem lê"). Vai junto em toda extração, como as lições de
-- estilo vão em todo rascunho. É o que impede o mesmo erro de voltar.
ALTER TABLE perfil DROP CONSTRAINT IF EXISTS perfil_tipo_check;
ALTER TABLE perfil ADD CONSTRAINT perfil_tipo_check CHECK (tipo IN ('regra', 'licao', 'gerado', 'leitura'));
