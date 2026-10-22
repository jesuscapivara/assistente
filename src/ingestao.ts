import type { Db } from "./db.js";
import * as repo from "./repo.js";
import { lerHistorico, lerMensagem, tipoDoEvento, type MensagemRecebida } from "./whatsapp/evento.js";

export interface DepsIngestao {
  db: Db;
  jidsDoDono: Set<string>;
  /** Comando no canal de controle (o chat consigo mesmo). */
  aoComando(texto: string, msg: MensagemRecebida): Promise<void>;
  /** Áudio no canal de controle: comando falado, se houver como transcrever. */
  aoComandoAudio?(msg: MensagemRecebida): Promise<void>;
  /** Áudio recebido numa conversa: transcreve em segundo plano, quando houver como. */
  aoAudio?(msg: MensagemRecebida): Promise<void>;
  /** Histórico gravado: hora de conhecer as pessoas. */
  aoHistorico?(gravadas: number): Promise<void>;
  log?: (o: object, txt: string) => void;
}

export type Resultado = "ignorado" | "comando" | "excluido" | "repetido" | "gravado" | "historico";

/**
 * Um evento do webhook. Destinos:
 * - histórico (ao parear): grava em lote, já marcado como lido;
 * - canal de controle (chat consigo mesmo, escrito pelo dono): é comando, não conversa;
 * - chat fora do assistente: descarta sem gravar nada;
 * - o resto: grava, e a extração pega depois.
 */
export async function ingerir(payload: unknown, deps: DepsIngestao): Promise<Resultado> {
  if (tipoDoEvento(payload) === "HistorySync") {
    const n = await ingerirHistorico(payload, deps);
    if (n > 0) await deps.aoHistorico?.(n);
    return "historico";
  }

  const msg = lerMensagem(payload);
  if (!msg) return "ignorado";

  if (deps.jidsDoDono.has(msg.chatJid)) {
    // O que o próprio assistente escreveu ali volta pelo webhook como "de mim".
    if (!msg.deMim || (await repo.foiEnviadaPeloAssistente(deps.db, msg.id))) return "ignorado";
    if (msg.tipo === "audio" && deps.aoComandoAudio) {
      await deps.aoComandoAudio(msg);
      return "comando";
    }
    if (msg.tipo !== "texto") return "ignorado";
    await deps.aoComando(msg.texto, msg);
    return "comando";
  }

  // A mesma pessoa pode chegar pelo número ou pelo LID: guarda tudo no número.
  const chatJid = msg.jidAlternativo
    ? await repo.registrarApelido(deps.db, msg.chatJid, msg.jidAlternativo)
    : await repo.resolverJid(deps.db, msg.chatJid);
  const m = { ...msg, chatJid };

  const contato = await repo.garantirContato(deps.db, chatJid, {
    grupo: m.grupo,
    // Em grupo o PushName é de quem falou, não do grupo.
    nomePush: m.grupo || m.deMim ? null : m.remetenteNome,
  });
  if (contato.excluido) return "excluido";

  const texto = m.tipo === "audio" ? "[áudio]" : m.texto;
  const nova = await repo.gravarMensagem(deps.db, m, texto);
  if (!nova) return "repetido";

  if (m.tipo === "audio" && deps.aoAudio) {
    void deps.aoAudio(m).catch((err) => deps.log?.({ err: String(err), id: m.id }, "transcrição falhou"));
  }
  return "gravado";
}

/**
 * Histórico do pareamento. Vem em vários eventos, às vezes com milhares de mensagens:
 * grava em lote, sem transcrever áudio antigo e sem extrair compromisso velho.
 */
export async function ingerirHistorico(payload: unknown, deps: Pick<DepsIngestao, "db" | "jidsDoDono">): Promise<number> {
  const { mensagens, nomes } = lerHistorico(payload);
  let gravadas = 0;
  const excluidos = new Map<string, boolean>();
  for (const msg of mensagens) {
    if (deps.jidsDoDono.has(msg.chatJid)) continue;
    const chatJid = await repo.resolverJid(deps.db, msg.chatJid);
    let excluido = excluidos.get(chatJid);
    if (excluido === undefined) {
      const c = await repo.garantirContato(deps.db, chatJid, {
        grupo: msg.grupo,
        nomePush: msg.grupo ? null : (nomes.get(msg.chatJid) ?? null),
      });
      excluido = c.excluido;
      excluidos.set(chatJid, excluido);
    }
    if (excluido) continue;
    const texto = msg.tipo === "audio" ? "[áudio]" : msg.texto;
    if (await repo.gravarMensagem(deps.db, { ...msg, chatJid }, texto, true)) gravadas++;
  }
  return gravadas;
}
