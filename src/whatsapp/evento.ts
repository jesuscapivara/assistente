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

const ALIASES: Record<string, string> = { message: "MESSAGE", messages: "MESSAGE" };

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

  return {
    id,
    chatJid,
    remetenteJid: str(info, "Sender", "sender", "SenderAlt", "Participant") ?? null,
    remetenteNome: str(info, "PushName", "pushName") ?? null,
    deMim: info.IsFromMe === true || info.isFromMe === true,
    grupo: info.IsGroup === true || chatJid.endsWith("@g.us"),
    tipo,
    texto,
    enviadaEm: Number.isNaN(quando.getTime()) ? new Date() : quando,
    bruto: msg,
  };
}
