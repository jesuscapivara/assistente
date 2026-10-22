import { describe, expect, it } from "vitest";
import { lerMensagem, tipoDoEvento } from "../src/whatsapp/evento.js";

/** Formato da Evolution GO 0.7 (whatsmeow), como chega no webhook. */
function evento(info: object, message: object, event = "Message") {
  return { event, data: { Info: { ID: "ABC1", Timestamp: "2026-10-21T14:32:00-03:00", ...info }, Message: message } };
}

describe("lerMensagem", () => {
  it("texto simples de um contato", () => {
    const m = lerMensagem(
      evento({ Chat: "5551999990000@s.whatsapp.net", Sender: "5551999990000@s.whatsapp.net", PushName: "Fernanda", IsFromMe: false }, { conversation: "Oi, tudo bem?" }),
    );
    expect(m).toMatchObject({
      id: "ABC1",
      chatJid: "5551999990000@s.whatsapp.net",
      remetenteNome: "Fernanda",
      deMim: false,
      grupo: false,
      tipo: "texto",
      texto: "Oi, tudo bem?",
    });
    expect(m!.enviadaEm.toISOString()).toBe("2026-10-21T17:32:00.000Z");
  });

  it("texto estendido, mensagem temporária e de visualização única", () => {
    expect(lerMensagem(evento({ Chat: "x@s.whatsapp.net" }, { extendedTextMessage: { text: "com link" } }))?.texto).toBe("com link");
    expect(
      lerMensagem(evento({ Chat: "x@s.whatsapp.net" }, { ephemeralMessage: { message: { conversation: "some em 24h" } } }))?.texto,
    ).toBe("some em 24h");
    expect(
      lerMensagem(evento({ Chat: "x@s.whatsapp.net" }, { viewOnceMessageV2: { message: { imageMessage: { caption: "foto" } } } })),
    ).toMatchObject({ tipo: "imagem", texto: "foto" });
  });

  it("grupo, áudio e documento", () => {
    const g = lerMensagem(evento({ Chat: "1203@g.us", IsGroup: true, PushName: "Pedro" }, { audioMessage: { seconds: 12 } }));
    expect(g).toMatchObject({ grupo: true, tipo: "audio", texto: "" });
    const d = lerMensagem(evento({ Chat: "x@s.whatsapp.net" }, { documentMessage: { fileName: "orcamento.pdf" } }));
    expect(d).toMatchObject({ tipo: "documento", texto: "[arquivo: orcamento.pdf]" });
  });

  it("descarta o que não é conversa", () => {
    // status, reação, apagar/editar, figurinha e evento que não é mensagem
    expect(lerMensagem(evento({ Chat: "status@broadcast" }, { conversation: "story" }))).toBeNull();
    expect(lerMensagem(evento({ Chat: "x@s.whatsapp.net" }, { reactionMessage: { text: "👍" } }))).toBeNull();
    expect(lerMensagem(evento({ Chat: "x@s.whatsapp.net" }, { protocolMessage: { type: 0 } }))).toBeNull();
    expect(lerMensagem(evento({ Chat: "x@s.whatsapp.net" }, { stickerMessage: {} }))).toBeNull();
    expect(lerMensagem({ event: "Connected", data: {} })).toBeNull();
    expect(lerMensagem(null)).toBeNull();
  });

  it("mensagem enviada pelo próprio dono", () => {
    expect(lerMensagem(evento({ Chat: "x@s.whatsapp.net", IsFromMe: true }, { conversation: "fechado" }))?.deMim).toBe(true);
  });

  it("tipo do evento aceita variações de caixa", () => {
    expect(tipoDoEvento({ event: "messages" })).toBe("MESSAGE");
    expect(tipoDoEvento({ data: { type: "Message" } })).toBe("MESSAGE");
    expect(tipoDoEvento({ event: "QRCode" })).toBe("QRCode");
  });
});
