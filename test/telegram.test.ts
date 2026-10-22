import { describe, expect, it } from "vitest";
import { criarTelegram, partes } from "../src/telegram.js";

/** API do Telegram falsa: devolve o que cada método pede e guarda as chamadas. */
function apiFalsa(respostas: Record<string, (corpo: any) => unknown>) {
  const chamadas: { metodo: string; corpo: any }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const metodo = url.split("/").pop()!;
    const corpo = init?.body instanceof FormData ? Object.fromEntries(init.body.entries()) : init?.body ? JSON.parse(String(init.body)) : null;
    chamadas.push({ metodo, corpo });
    // O long polling de verdade espera: sem isto o laço de leitura nunca solta o evento.
    if (metodo === "getUpdates") await new Promise((r) => setTimeout(r, 5));
    const r = respostas[metodo]?.(corpo) ?? { ok: true, result: true };
    return new Response(JSON.stringify(r), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, chamadas };
}

describe("Telegram", () => {
  it("envia com a marcação do WhatsApp e, se o Telegram recusar, sem ela", async () => {
    const { f, chamadas } = apiFalsa({
      sendMessage: (c) => (c.parse_mode ? { ok: false, description: "Bad Request: can't parse entities" } : { ok: true, result: {} }),
    });
    await criarTelegram("T", "42", f).enviarTexto("Respondo *Robson em 10 min");
    expect(chamadas.map((c) => [c.corpo.chat_id, c.corpo.parse_mode ?? null])).toEqual([
      ["42", "Markdown"],
      ["42", null],
    ]);
  });

  it("foto do resumo vai como arquivo, com a legenda", async () => {
    const { f, chamadas } = apiFalsa({});
    await criarTelegram("T", "42", f).enviarFoto(Buffer.from("png"), "Bom dia");
    expect(chamadas[0].metodo).toBe("sendPhoto");
    expect(chamadas[0].corpo.caption).toBe("Bom dia");
    expect(chamadas[0].corpo.photo).toBeInstanceOf(Blob);
  });

  it("sem o chat do dono não envia", async () => {
    const { f } = apiFalsa({});
    await expect(criarTelegram("T", undefined, f).enviarTexto("oi")).rejects.toThrow(/TELEGRAM_CHAT_ID/);
  });

  it("só ouve o chat do dono; os outros vão para o log com o id", async () => {
    let lidas = 0;
    const { f } = apiFalsa({
      getUpdates: () =>
        lidas++ === 0
          ? {
              ok: true,
              result: [
                { update_id: 1, message: { chat: { id: 42 }, text: "ok 3" } },
                { update_id: 2, message: { chat: { id: 99 }, from: { first_name: "Estranho" }, text: "ok 4" } },
                { update_id: 3, message: { chat: { id: 42 }, text: "/start" } },
              ],
            }
          : { ok: true, result: [] },
    });
    const textos: string[] = [];
    const logs: object[] = [];
    const parar = criarTelegram("T", "42", f).ouvir({ aoTexto: async (t) => void textos.push(t), aoAudio: async () => {}, log: (o) => void logs.push(o) });
    await new Promise((r) => setTimeout(r, 30));
    parar();
    expect(textos).toEqual(["ok 3"]);
    expect(logs).toEqual([{ chatId: 99, de: "Estranho" }]);
  });

  it("corta mensagem longa numa quebra de linha", () => {
    const texto = `${"a".repeat(30)}\n${"b".repeat(30)}`;
    expect(partes(texto, 40)).toEqual(["a".repeat(30), "b".repeat(30)]);
    expect(partes("curto", 40)).toEqual(["curto"]);
  });
});
