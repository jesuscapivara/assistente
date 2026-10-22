import { randomBytes } from "node:crypto";

/**
 * Imagens que o assistente manda ao dono (o cartão do resumo). A Evolution GO só envia
 * mídia por URL, então o próprio assistente serve o arquivo na rede interna do Docker,
 * por alguns minutos, num endereço que não se adivinha. Fica em memória: reiniciar
 * perde só o que já foi entregue.
 */
const VALIDADE_MS = 15 * 60_000;
const guardadas = new Map<string, { png: Buffer; expira: number }>();

export function guardarImagem(png: Buffer, agora = Date.now()): string {
  for (const [id, x] of guardadas) if (x.expira < agora) guardadas.delete(id);
  const id = randomBytes(16).toString("hex");
  guardadas.set(id, { png, expira: agora + VALIDADE_MS });
  return id;
}

export function lerImagem(id: string, agora = Date.now()): Buffer | null {
  const x = guardadas.get(id);
  if (!x || x.expira < agora) return null;
  return x.png;
}
