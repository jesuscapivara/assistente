import { extractText, getDocumentProxy } from "unpdf";

/**
 * Texto dos PDFs que chegam nas conversas (propostas, termos, memoriais): sem ele, o
 * assistente só guarda o nome do arquivo e a busca não acha "qual proposta tinha o valor
 * X". Sem modelo: o PDF digital já tem o texto; o escaneado volta vazio e fica como estava.
 */

/** O documento é PDF pelo nome do arquivo, que é o que a mensagem gravada guarda. */
export function ehPdf(texto: string): boolean {
  return /\[arquivo: [^\]]*\.pdf\]/i.test(texto);
}

/** Cabe na conversa sem pesar na leitura: o começo do documento é o que identifica. */
export const LIMITE_TEXTO_PDF = 3000;

export async function textoDoPdf(buffer: Buffer, limite = LIMITE_TEXTO_PDF): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  const limpo = text.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{2,}/g, "\n").trim();
  return limpo.length > limite ? `${limpo.slice(0, limite)}…` : limpo;
}
