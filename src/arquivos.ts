/**
 * Arquivos das conversas: o que guardar da mensagem para baixar depois e que nome dar ao
 * arquivo. O download em si é da Evolution (`baixarMidia`), na hora em que pedem.
 */

export const TIPOS_DE_ARQUIVO = new Set(["documento", "imagem", "video", "audio"]);

/**
 * A mensagem original sem as miniaturas: o download só precisa da chave, do caminho e
 * do tipo, e a miniatura em base64 pesaria mais que todo o resto.
 */
export function semMiniatura(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(semMiniatura);
  if (!v || typeof v !== "object") return v;
  const saida: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (!/thumbnail/i.test(k)) saida[k] = semMiniatura(x);
  return saida;
}

const EXTENSOES: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "application/zip": "zip",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

/** O tipo MIME pela extensão do nome, para o anexo que o dono manda. */
export function mimePeloNome(nome: string): string {
  const ext = nome.toLowerCase().split(".").pop() ?? "";
  for (const [mime, e] of Object.entries(EXTENSOES)) if (e === ext) return mime;
  if (ext === "jpeg") return "image/jpeg";
  return "application/octet-stream";
}

/** Como o WhatsApp mostra o anexo: foto e vídeo na conversa, o resto como documento. */
export function tipoDeEnvio(mime: string): "image" | "video" | "audio" | "document" {
  if (mime === "image/jpeg" || mime === "image/png") return "image";
  if (mime === "video/mp4") return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

/** O tipo MIME que a mensagem declara, onde quer que o engine o tenha posto. */
export function mimeDaMidia(midia: unknown): string | null {
  const achar = (v: unknown, fundo: number): string | null => {
    if (!v || typeof v !== "object" || fundo > 4) return null;
    for (const [k, x] of Object.entries(v)) {
      if (/^mime_?type$/i.test(k) && typeof x === "string" && x) return x.split(";")[0].trim();
      const r = achar(x, fundo + 1);
      if (r) return r;
    }
    return null;
  };
  return achar(midia, 0);
}

/**
 * O nome do arquivo: o que veio no documento ("[arquivo: Proposta.pdf]"), ou o tipo e o
 * id com a extensão do MIME. Sem barra nem caractere que o Windows recusa.
 */
export function nomeDoArquivo(m: { id: string; tipo: string; texto: string }, mime: string | null): string {
  const doc = m.texto.match(/\[arquivo: ([^\]]+)\]/)?.[1]?.trim();
  const ext = (mime && EXTENSOES[mime]) || (mime?.split("/")[1]?.replace(/[^a-z0-9]/gi, "").slice(0, 5) ?? "bin");
  const nome = doc || `${m.tipo}-${m.id}.${ext}`;
  return nome.replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").slice(0, 150);
}
