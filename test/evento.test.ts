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

describe("número e LID da mesma pessoa", () => {
  it("chat em LID com o número em SenderAlt", () => {
    const m = lerMensagem(evento({ Chat: "987654@lid", Sender: "987654@lid", SenderAlt: "5551911111111:3@s.whatsapp.net" }, { conversation: "oi" }));
    expect(m?.jidAlternativo).toBe("5551911111111@s.whatsapp.net");
  });
  it("mensagem do dono usa RecipientAlt", () => {
    const m = lerMensagem(evento({ Chat: "5551911111111@s.whatsapp.net", IsFromMe: true, RecipientAlt: "987654@lid" }, { conversation: "oi" }));
    expect(m?.jidAlternativo).toBe("987654@lid");
  });
  it("mesmo tipo de endereço não é alternativo, e grupo não tem", () => {
    expect(lerMensagem(evento({ Chat: "5551911111111@s.whatsapp.net", SenderAlt: "5551922222222@s.whatsapp.net" }, { conversation: "oi" }))?.jidAlternativo).toBeNull();
    expect(lerMensagem(evento({ Chat: "1203@g.us", SenderAlt: "5551922222222@s.whatsapp.net" }, { conversation: "oi" }))?.jidAlternativo).toBeNull();
  });
});

describe("lerHistorico", () => {
  it("lê conversas, mensagens e nomes, nas duas grafias do protobuf", async () => {
    const { lerHistorico } = await import("../src/whatsapp/evento.js");
    const payload = {
      event: "HistorySync",
      data: {
        Data: {
          syncType: 2,
          conversations: [
            {
              id: "5551911111111@s.whatsapp.net",
              name: "Fernanda Moraes",
              messages: [
                { message: { key: { remoteJID: "5551911111111@s.whatsapp.net", fromMe: false, ID: "H1" }, message: { conversation: "Oi Lucas" }, messageTimestamp: 1760000000, pushName: "Fê" } },
                { message: { key: { remoteJID: "5551911111111@s.whatsapp.net", fromMe: true, ID: "H2" }, message: { extendedTextMessage: { text: "Oi Fê!" } }, messageTimestamp: "1760000060" } },
                { message: { key: { ID: "H3" }, message: { reactionMessage: {} }, messageTimestamp: 1760000070 } },
              ],
            },
            { ID: "status@broadcast", Messages: [{ Message: { Key: { ID: "S1" }, Message: { Conversation: "x" }, MessageTimestamp: 1 } }] },
            {
              ID: "120363@g.us",
              Messages: [{ Message: { Key: { ID: "G1", Participant: "5551933333333@s.whatsapp.net", FromMe: false }, Message: { Conversation: "bom dia" }, MessageTimestamp: 1760000100 } }],
            },
          ],
          pushnames: [{ ID: "5551933333333@s.whatsapp.net", pushname: "Pedro" }],
        },
      },
    };
    const { mensagens, nomes } = lerHistorico(payload);
    expect(mensagens.map((m) => [m.id, m.deMim, m.texto])).toEqual([
      ["H1", false, "Oi Lucas"],
      ["H2", true, "Oi Fê!"],
      ["G1", false, "bom dia"],
    ]);
    expect(mensagens[0].enviadaEm.toISOString()).toBe(new Date(1760000000 * 1000).toISOString());
    expect(mensagens[2]).toMatchObject({ grupo: true, remetenteJid: "5551933333333@s.whatsapp.net" });
    expect(nomes.get("5551911111111@s.whatsapp.net")).toBe("Fernanda Moraes");
    expect(nomes.get("5551933333333@s.whatsapp.net")).toBe("Pedro");
  });
});
