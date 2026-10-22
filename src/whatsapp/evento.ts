/**
 * Leitura do webhook da Evolution GO (whatsmeow). O formato é o mesmo que o KoreOS
 * recebe (`controllers/evolutionWebhookController.js` no backend): metadados em
 * `data.Info` e o conteúdo em `data.Message`, com variações de caixa entre versões.
 */

export type TipoMensagem = "texto" | "audio" | "imagem" | "video" | "documento" | "outro";

export interface MensagemRecebida {
  id: string;
  chatJid: string;
  remetenteJid: string | null;
  remetenteNome: string | null;
  deMim: boolean;
  grupo: boolean;
  tipo: TipoMensagem;
  texto: string;
  enviadaEm: Date;
  /** O `Message` original, para baixar a mídia (áudio) pelo engine. */
  bruto: Record<string, unknown>;
  /**
   * O outro endereço do contato, quando o evento traz: o número quando o chat veio
   * como LID, ou o LID quando veio como número. É o que junta as duas conversas.
   */
  jidAlternativo: string | null;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function str(o: Obj | undefined, ...chaves: string[]): string | undefined {
  if (!o) return undefined;
  for (const k of chaves) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function obj(o: Obj | undefined, ...chaves: string[]): Obj | undefined {
  if (!o) return undefined;
  for (const k of chaves) {
    const v = o[k];
    if (isObj(v)) return v;
  }
  return undefined;
}

const ALIASES: Record<string, string> = {
  message: "MESSAGE",
  messages: "MESSAGE",
  historysync: "HistorySync",
  history_sync: "HistorySync",
};

export function tipoDoEvento(payload: unknown): string {
  if (!isObj(payload)) return "unknown";
  const data = obj(payload, "data") ?? payload;
  const bruto = str(payload, "event", "type", "Event", "Type") ?? str(data, "event", "type") ?? "unknown";
  return ALIASES[bruto.toLowerCase()] ?? bruto;
}

/**
 * Mensagens temporárias, de visualização única e editadas chegam embrulhadas:
 * o conteúdo de verdade está um nível abaixo.
 */
function desembrulhar(msg: Obj): Obj {
  let atual = msg;
  for (let i = 0; i < 4; i++) {
    const dentro =
      obj(obj(atual, "ephemeralMessage", "EphemeralMessage"), "message", "Message") ??
      obj(obj(atual, "viewOnceMessage", "viewOnceMessageV2", "ViewOnceMessage"), "message", "Message") ??
      obj(obj(atual, "documentWithCaptionMessage"), "message", "Message");
    if (!dentro) break;
    atual = dentro;
  }
  return atual;
}

function conteudo(msg: Obj): { tipo: TipoMensagem; texto: string } {
  const m = desembrulhar(msg);
  const texto =
    str(m, "conversation", "Conversation") ??
    str(obj(m, "extendedTextMessage", "ExtendedTextMessage"), "text", "Text");
  if (texto) return { tipo: "texto", texto };

  const audio = obj(m, "audioMessage", "AudioMessage");
  if (audio) return { tipo: "audio", texto: "" };

  const imagem = obj(m, "imageMessage", "ImageMessage");
  if (imagem) return { tipo: "imagem", texto: str(imagem, "caption", "Caption") ?? "" };

  const video = obj(m, "videoMessage", "VideoMessage");
  if (video) return { tipo: "video", texto: str(video, "caption", "Caption") ?? "" };

  const doc = obj(m, "documentMessage", "DocumentMessage");
  if (doc) {
    const nome = str(doc, "fileName", "FileName", "title", "Title");
    const legenda = str(doc, "caption", "Caption");
    return { tipo: "documento", texto: [nome && `[arquivo: ${nome}]`, legenda].filter(Boolean).join(" ") };
  }
  return { tipo: "outro", texto: "" };
}

/** Status, newsletters e broadcast: ruído que nunca interessa ao assistente. */
export function chatDeRuido(jid: string): boolean {
  return jid === "status@broadcast" || jid.endsWith("@broadcast") || jid.endsWith("@newsletter");
}

/**
 * Converte o evento numa mensagem, ou `null` quando não há o que guardar: evento que
 * não é mensagem, reação, apagar/editar (protocolMessage), figurinha, ou chat de ruído.
 */
export function lerMensagem(payload: unknown): MensagemRecebida | null {
  if (!isObj(payload) || tipoDoEvento(payload) !== "MESSAGE") return null;
  const data = obj(payload, "data") ?? payload;
  const info = obj(data, "Info", "info") ?? data;
  const msg = obj(data, "Message", "message");
  if (!msg) return null;

  const id = str(info, "ID", "Id", "id");
  const chatJid = str(info, "Chat", "chat");
  if (!id || !chatJid || chatDeRuido(chatJid)) return null;

  const { tipo, texto } = conteudo(msg);
  if (tipo === "outro") return null;
  if (tipo === "texto" && !texto) return null;

  const ts = str(info, "Timestamp", "timestamp");
  const quando = ts ? new Date(ts) : new Date();

  const deMim = info.IsFromMe === true || info.isFromMe === true;
  const grupo = info.IsGroup === true || chatJid.endsWith("@g.us");
  return {
    id,
    chatJid,
    remetenteJid: str(info, "Sender", "sender", "SenderAlt", "Participant") ?? null,
    remetenteNome: str(info, "PushName", "pushName") ?? null,
    deMim,
    grupo,
    tipo,
    texto,
    enviadaEm: Number.isNaN(quando.getTime()) ? new Date() : quando,
    bruto: msg,
    jidAlternativo: grupo ? null : alternativo(chatJid, info, deMim),
  };
}

/**
 * Em conversa individual, o alternativo do contato está em `SenderAlt` quando ele
 * escreveu e em `RecipientAlt` quando foi o dono. Só vale se for o outro tipo de
 * endereço (LID ↔ número): o mesmo tipo seria outra pessoa.
 */
function alternativo(chatJid: string, info: Obj, deMim: boolean): string | null {
  const alt = deMim ? str(info, "RecipientAlt", "recipientAlt") : str(info, "SenderAlt", "senderAlt");
  if (!alt) return null;
  const limpo = alt.replace(/:\d+(?=@)/, ""); // tira o número do aparelho ("5551...:12@s.whatsapp.net")
  const chatLid = chatJid.endsWith("@lid");
  const altLid = limpo.endsWith("@lid");
  if (chatLid === altLid || !(limpo.endsWith("@lid") || limpo.endsWith("@s.whatsapp.net"))) return null;
  return limpo;
}

/** Campo pelo nome sem diferenciar caixa nem "_": o protobuf vem em mais de uma grafia. */
function campo(o: unknown, nome: string): unknown {
  if (!isObj(o)) return undefined;
  const alvo = nome.toLowerCase().replace(/_/g, "");
  for (const [k, v] of Object.entries(o)) if (k.toLowerCase().replace(/_/g, "") === alvo) return v;
  return undefined;
}

const texto = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * Histórico que o WhatsApp manda ao parear (`HistorySync`, protobuf do whatsmeow):
 * conversas com as mensagens de cada uma. Devolve as mensagens no mesmo formato do
 * webhook, e os nomes que vierem junto (`pushnames`).
 */
export function lerHistorico(payload: unknown): { mensagens: MensagemRecebida[]; nomes: Map<string, string> } {
  const mensagens: MensagemRecebida[] = [];
  const nomes = new Map<string, string>();
  if (!isObj(payload) || tipoDoEvento(payload) !== "HistorySync") return { mensagens, nomes };
  const data = obj(payload, "data") ?? payload;
  const raiz = (campo(data, "Data") as Obj | undefined) ?? data;

  for (const p of (campo(raiz, "pushnames") as unknown[]) ?? []) {
    const jid = texto(campo(p, "id"));
    const nome = texto(campo(p, "pushname"));
    if (jid && nome) nomes.set(jid, nome);
  }

  for (const conv of (campo(raiz, "conversations") as unknown[]) ?? []) {
    const chatJid = texto(campo(conv, "id"));
    if (!chatJid || chatDeRuido(chatJid)) continue;
    const grupo = chatJid.endsWith("@g.us");
    const nomeConversa = texto(campo(conv, "name")) ?? null;
    if (nomeConversa && !grupo) nomes.set(chatJid, nomeConversa);
    for (const item of (campo(conv, "messages") as unknown[]) ?? []) {
      const wmi = (campo(item, "message") as Obj | undefined) ?? (item as Obj);
      const chave = campo(wmi, "key") as Obj | undefined;
      const conteudoMsg = campo(wmi, "message") as Obj | undefined;
      const id = texto(campo(chave, "id"));
      if (!id || !isObj(conteudoMsg)) continue;
      const { tipo, texto: t } = conteudo(conteudoMsg);
      if (tipo === "outro" || (tipo === "texto" && !t)) continue;
      const ts = Number(campo(wmi, "messageTimestamp"));
      const quando = Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : null;
      if (!quando) continue;
      const deMim = campo(chave, "fromMe") === true;
      mensagens.push({
        id,
        chatJid,
        remetenteJid: texto(campo(chave, "participant")) ?? (deMim ? null : chatJid),
        remetenteNome: texto(campo(wmi, "pushName")) ?? null,
        deMim,
        grupo,
        tipo,
        texto: t,
        enviadaEm: quando,
        bruto: conteudoMsg,
        jidAlternativo: null,
      });
    }
  }
  return { mensagens, nomes };
}
