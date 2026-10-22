/**
 * Canal do dono pelo Telegram. No WhatsApp o assistente fala pela conta do próprio
 * dono, no chat consigo mesmo, e o WhatsApp não notifica mensagem da própria conta:
 * os avisos chegavam mudos. Pelo bot do Telegram eles chegam com notificação.
 *
 * Recebe por long polling (getUpdates): a VM não precisa de porta pública. Só o chat
 * do dono (TELEGRAM_CHAT_ID) é ouvido; o resto vai para o log, com o id, que é como
 * se descobre o id do dono na primeira vez.
 */
export interface Telegram {
  enviarTexto(texto: string): Promise<void>;
  enviarFoto(png: Buffer, legenda: string): Promise<void>;
  /** Escuta o chat do dono até `parar()`. */
  ouvir(h: {
    aoTexto(texto: string): Promise<void>;
    aoAudio(audio: { buffer: Buffer; mimetype: string }): Promise<void>;
    log(o: object, t: string): void;
  }): () => void;
}

const LIMITE_TEXTO = 4096;
const LIMITE_LEGENDA = 1024;

export function criarTelegram(token: string, chatId: string | undefined, fetcher: typeof fetch = fetch): Telegram {
  const api = `https://api.telegram.org/bot${token}`;

  async function chamar<T>(metodo: string, corpo: object | FormData, timeoutMs = 30_000): Promise<T> {
    const res = await fetcher(`${api}/${metodo}`, {
      method: "POST",
      ...(corpo instanceof FormData ? { body: corpo } : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = (await res.json()) as { ok: boolean; result?: T; description?: string };
    // O token está na URL: a mensagem de erro nunca a repete.
    if (!j.ok) throw new Error(`Telegram ${metodo}: ${j.description ?? res.status}`);
    return j.result as T;
  }

  function exigirChat(): string {
    if (!chatId) throw new Error("TELEGRAM_CHAT_ID não configurado");
    return chatId;
  }

  /**
   * O texto usa a marcação do WhatsApp (*negrito*, _itálico_), que é a mesma do
   * Markdown antigo do Telegram. Se algum asterisco ficar sem par, o Telegram recusa:
   * aí vai sem formatação, para o aviso não se perder.
   */
  async function comMarcacao(metodo: string, campos: Record<string, string>, chave: "text" | "caption", texto: string, arquivo?: Blob) {
    const montar = (formatado: boolean) => {
      if (!arquivo) return { ...campos, [chave]: texto, ...(formatado ? { parse_mode: "Markdown" } : {}) };
      const f = new FormData();
      for (const [k, v] of Object.entries(campos)) f.append(k, v);
      f.append(chave, texto);
      if (formatado) f.append("parse_mode", "Markdown");
      f.append("photo", arquivo, "resumo.png");
      return f;
    };
    try {
      await chamar(metodo, montar(true));
    } catch (err) {
      if (!/parse|entit/i.test(String(err))) throw err;
      await chamar(metodo, montar(false));
    }
  }

  return {
    async enviarTexto(texto) {
      const chat = exigirChat();
      for (const parte of partes(texto, LIMITE_TEXTO)) await comMarcacao("sendMessage", { chat_id: chat }, "text", parte);
    },

    async enviarFoto(png, legenda) {
      const chat = exigirChat();
      const [primeira, ...resto] = partes(legenda, LIMITE_LEGENDA);
      await comMarcacao("sendPhoto", { chat_id: chat }, "caption", primeira ?? "", new Blob([new Uint8Array(png)], { type: "image/png" }));
      for (const p of resto) await comMarcacao("sendMessage", { chat_id: chat }, "text", p);
    },

    ouvir(h) {
      let ativo = true;
      let offset = 0;
      void (async () => {
        while (ativo) {
          try {
            const updates = await chamar<any[]>("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] }, 65_000);
            for (const u of updates) {
              offset = u.update_id + 1;
              const m = u.message;
              if (!m) continue;
              if (!chatId || String(m.chat?.id) !== chatId) {
                h.log({ chatId: m.chat?.id, de: m.from?.username ?? m.from?.first_name }, "telegram: mensagem de chat que não é o do dono");
                continue;
              }
              if (typeof m.text === "string") {
                if (m.text === "/start") continue;
                await h.aoTexto(m.text).catch((err) => h.log({ err: String(err) }, "telegram: comando falhou"));
              } else if (m.voice?.file_id || m.audio?.file_id) {
                const arq = m.voice ?? m.audio;
                const audio = await baixar(arq.file_id, arq.mime_type ?? "audio/ogg").catch(() => null);
                if (audio) await h.aoAudio(audio).catch((err) => h.log({ err: String(err) }, "telegram: áudio falhou"));
              }
            }
          } catch (err) {
            h.log({ err: String(err) }, "telegram: leitura falhou, tento de novo");
            await new Promise((r) => setTimeout(r, 10_000));
          }
        }
      })();
      return () => {
        ativo = false;
      };
    },
  };

  async function baixar(fileId: string, mimetype: string): Promise<{ buffer: Buffer; mimetype: string }> {
    const f = await chamar<{ file_path: string }>("getFile", { file_id: fileId });
    const res = await fetcher(`https://api.telegram.org/file/bot${token}/${f.file_path}`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Telegram arquivo: ${res.status}`);
    return { buffer: Buffer.from(await res.arrayBuffer()), mimetype };
  }
}

/** Corta em pedaços que cabem no limite, de preferência numa quebra de linha. */
export function partes(texto: string, limite: number): string[] {
  const saida: string[] = [];
  let resto = texto;
  while (resto.length > limite) {
    let corte = resto.lastIndexOf("\n", limite);
    if (corte < limite / 2) corte = limite;
    saida.push(resto.slice(0, corte));
    resto = resto.slice(corte).replace(/^\n/, "");
  }
  if (resto || !saida.length) saida.push(resto);
  return saida;
}
