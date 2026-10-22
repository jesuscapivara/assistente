import type { Db } from "./db.js";
import * as repo from "./repo.js";
import { lerMensagem, type MensagemRecebida } from "./whatsapp/evento.js";

export interface DepsIngestao {
  db: Db;
  jidsDoDono: Set<string>;
  /** Comando no canal de controle (o chat consigo mesmo). */
  aoComando(texto: string, msg: MensagemRecebida): Promise<void>;
  /** Áudio recebido: transcreve em segundo plano, quando houver como. */
  aoAudio?(msg: MensagemRecebida): Promise<void>;
  log?: (o: object, txt: string) => void;
}

export type Resultado = "ignorado" | "comando" | "excluido" | "repetido" | "gravado";

/**
 * Um evento do webhook. Três destinos:
 * - canal de controle (chat consigo mesmo, escrito pelo dono): é comando, não conversa;
 * - chat fora do assistente: descarta sem gravar nada;
 * - o resto: grava, e a extração pega depois.
 */
export async function ingerir(payload: unknown, deps: DepsIngestao): Promise<Resultado> {
  const msg = lerMensagem(payload);
  if (!msg) return "ignorado";

  if (deps.jidsDoDono.has(msg.chatJid)) {
    // O que o próprio assistente escreveu ali volta pelo webhook como "de mim".
    if (!msg.deMim || (await repo.foiEnviadaPeloAssistente(deps.db, msg.id))) return "ignorado";
    if (msg.tipo !== "texto") return "ignorado";
    await deps.aoComando(msg.texto, msg);
    return "comando";
  }

  const contato = await repo.garantirContato(deps.db, msg.chatJid, {
    grupo: msg.grupo,
    // Em grupo o PushName é de quem falou, não do grupo.
    nomePush: msg.grupo || msg.deMim ? null : msg.remetenteNome,
  });
  if (contato.excluido) return "excluido";

  const texto = msg.tipo === "audio" ? "[áudio]" : msg.texto;
  const nova = await repo.gravarMensagem(deps.db, msg, texto);
  if (!nova) return "repetido";

  if (msg.tipo === "audio" && deps.aoAudio) {
    void deps.aoAudio(msg).catch((err) => deps.log?.({ err: String(err), id: msg.id }, "transcrição falhou"));
  }
  return "gravado";
}
