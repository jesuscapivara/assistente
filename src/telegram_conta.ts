import tg from "telegram";
import { NewMessage, type NewMessageEvent } from "telegram/events/index.js";
import { Logger, LogLevel } from "telegram/extensions/Logger.js";
import { StringSession } from "telegram/sessions/index.js";
import type { Db } from "./db.js";
import { normalizar } from "./ofertas.js";

/**
 * Grupos e canais de promoção do Telegram, lidos pela conta do dono (pedido do Lucas,
 * 05/11/2026). O bot não serve: ele só lê grupo em que um administrador o colocou. A
 * conta entra pelo MTProto (GramJS) com a sessão gerada em scripts/telegram-login.mjs.
 *
 * Só leitura: este módulo nunca chama envio, nem marca mensagem como lida. Nada do que
 * chega é guardado; o texto dos chats marcados `promo` passa por `avaliarOferta` e some.
 */

export interface ChatTelegram {
  chat_id: string;
  nome: string;
  promo: boolean;
}

/** Os grupos e canais da conta (só o nome), para o dono escolher pelo nome. */
export async function gravarChatsTelegram(db: Db, chats: { id: string; nome: string }[]): Promise<void> {
  for (const c of chats) {
    await db.query(
      `INSERT INTO telegram_chats (chat_id, nome) VALUES ($1, $2)
       ON CONFLICT (chat_id) DO UPDATE SET nome = EXCLUDED.nome, visto_em = now()`,
      [c.id, c.nome],
    );
  }
}

/** Pelo nome, sem acento nem caixa; o nome exato ganha de quem só o contém. */
export async function buscarChatsTelegram(db: Db, nome: string): Promise<ChatTelegram[]> {
  const todos = (await db.query<ChatTelegram>("SELECT chat_id, nome, promo FROM telegram_chats ORDER BY nome")).rows;
  const alvo = normalizar(nome).trim();
  const exato = todos.filter((c) => normalizar(c.nome).trim() === alvo);
  return exato.length ? exato : todos.filter((c) => normalizar(c.nome).includes(alvo));
}

export async function marcarPromoTelegram(db: Db, chatId: string, promo: boolean): Promise<void> {
  await db.query("UPDATE telegram_chats SET promo = $2 WHERE chat_id = $1", [chatId, promo]);
}

/** chat_id → nome dos marcados. */
export async function promoTelegram(db: Db): Promise<Map<string, string>> {
  const r = await db.query<{ chat_id: string; nome: string }>("SELECT chat_id, nome FROM telegram_chats WHERE promo");
  return new Map(r.rows.map((x) => [x.chat_id, x.nome]));
}

/**
 * "promo telegram <nome>" e o MCP: um chat só, ou a lista para o dono escolher. Sem a
 * conta ligada, a tabela fica vazia e a resposta diz o porquê.
 */
export async function marcarPromoTelegramPeloNome(db: Db, nome: string, promo = true): Promise<string> {
  const achados = await buscarChatsTelegram(db, nome);
  if (!achados.length) {
    const n = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM telegram_chats")).rows[0].n;
    return n ? `Não achei "${nome}" nos seus grupos e canais do Telegram.` : "A conta do Telegram ainda não está ligada ao assistente (scripts/telegram-login.mjs).";
  }
  if (achados.length > 1) return `Achei mais de um. Mande o nome exato:\n${achados.slice(0, 8).map((c) => `• ${c.nome}`).join("\n")}`;
  await marcarPromoTelegram(db, achados[0].chat_id, promo);
  return promo
    ? `${achados[0].nome} (Telegram) virou grupo de promoção: não guardo nada dele, só comparo as ofertas com os seus interesses.`
    : `${achados[0].nome} (Telegram) saiu dos grupos de promoção.`;
}

/**
 * Liga a conta e escuta. Os nomes dos grupos e canais são gravados na subida e a cada
 * 6 h; a lista dos marcados é relida a cada minuto, para o "promo telegram" valer logo.
 * Devolve como parar.
 */
export async function ligarContaTelegram(o: {
  apiId: number;
  apiHash: string;
  sessao: string;
  db: Db;
  aoOferta(chatId: string, nome: string, texto: string): Promise<void>;
  log(o: object, t: string): void;
}): Promise<() => Promise<void>> {
  // Logger próprio só com erro: o padrão do GramJS escreve cada reconexão no stdout.
  const cliente = new tg.TelegramClient(new StringSession(o.sessao), o.apiId, o.apiHash, {
    connectionRetries: 10,
    autoReconnect: true,
    baseLogger: new Logger(LogLevel.ERROR),
  });
  await cliente.connect();
  if (!(await cliente.checkAuthorization())) throw new Error("sessão do Telegram inválida: rode scripts/telegram-login.mjs de novo");

  const lerChats = async () => {
    const chats: { id: string; nome: string }[] = [];
    for await (const d of cliente.iterDialogs({})) {
      if ((d.isGroup || d.isChannel) && d.id) chats.push({ id: d.id.toString(), nome: d.title || d.name || d.id.toString() });
    }
    await gravarChatsTelegram(o.db, chats);
    return chats.length;
  };
  o.log({ n: await lerChats() }, "telegram: grupos e canais gravados");

  let marcados = await promoTelegram(o.db);
  let lidoEm = Date.now();
  cliente.addEventHandler(async (ev: NewMessageEvent) => {
    try {
      const m = ev.message;
      if (m.out || !m.chatId) return;
      if (Date.now() - lidoEm > 60_000) {
        marcados = await promoTelegram(o.db);
        lidoEm = Date.now();
      }
      const nome = marcados.get(m.chatId.toString());
      const texto = m.message ?? "";
      if (nome && texto.trim()) await o.aoOferta(m.chatId.toString(), nome, texto);
    } catch (err) {
      o.log({ err: String(err) }, "telegram: oferta falhou");
    }
  }, new NewMessage({}));

  const t = setInterval(() => void lerChats().catch((err) => o.log({ err: String(err) }, "telegram: leitura dos chats falhou")), 6 * 3600_000);
  return async () => {
    clearInterval(t);
    await cliente.disconnect();
  };
}
