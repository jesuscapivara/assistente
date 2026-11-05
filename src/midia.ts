import { randomBytes } from "node:crypto";

/**
 * Arquivos que o assistente manda pelo WhatsApp (o cartão do resumo, os anexos que o dono
 * aprovou). A Evolution GO só envia mídia por URL, então o próprio assistente serve o
 * arquivo na rede interna do Docker, por alguns minutos, num endereço que não se adivinha.
 * Fica em memória: reiniciar perde só o que já foi entregue.
 */
const VALIDADE_MS = 15 * 60_000;
const guardadas = new Map<string, { dados: Buffer; tipo: string; expira: number }>();

export function guardarArquivo(dados: Buffer, tipo: string, agora = Date.now()): string {
  for (const [id, x] of guardadas) if (x.expira < agora) guardadas.delete(id);
  const id = randomBytes(16).toString("hex");
  guardadas.set(id, { dados, tipo, expira: agora + VALIDADE_MS });
  return id;
}

export function guardarImagem(png: Buffer, agora = Date.now()): string {
  return guardarArquivo(png, "image/png", agora);
}

export function lerArquivoGuardado(id: string, agora = Date.now()): { dados: Buffer; tipo: string } | null {
  const x = guardadas.get(id);
  if (!x || x.expira < agora) return null;
  return x;
}

export function lerImagem(id: string, agora = Date.now()): Buffer | null {
  return lerArquivoGuardado(id, agora)?.dados ?? null;
}
