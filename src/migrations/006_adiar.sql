-- "adia B sábado": a pessoa some de "Esperando" e de "Ficou para trás" até esse dia.
-- Se ela escrever de novo antes, volta na hora (a ingestão limpa o adiamento).
ALTER TABLE contatos ADD COLUMN IF NOT EXISTS adiado_ate TIMESTAMPTZ;
