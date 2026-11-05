/**
 * Ofertas dos grupos de promoção: a regra de casar e o preço sem banco; o aviso único,
 * o teto e o grupo que não grava nada com DATABASE_URL_TESTE (sem ela, essa parte pula).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { lerComando } from "../src/controle.js";
import { abrirDb, migrar, type Db } from "../src/db.js";
import { ingerir } from "../src/ingestao.js";
import { adicionarInteresse, avaliarOferta, casa, comparacao, lerInteresse, lerValor, precos, textoDosInteresses } from "../src/ofertas.js";
import * as repo from "../src/repo.js";
import { gravarChatsTelegram, marcarPromoTelegramPeloNome, promoTelegram } from "../src/telegram_conta.js";

const URL_TESTE = process.env.DATABASE_URL_TESTE;
const MONITOR = `🔥 Monitor LG UltraGear Tela VA FHD 32”, 144Hz nativo, 1ms (MBR), AMD FreeSync

💵 R$ 899
⭐️ 10x sem Juros
🎟 Cupom: DESCONTOSESPECIAIS
https://meli.la/1h281Ro`;

describe("regra das ofertas", () => {
  it("lê preço de oferta e valor escrito pelo dono", () => {
    expect(precos(MONITOR)).toEqual([899]);
    expect(precos("De R$ 1.530,97 por R$1.299,90 à vista")).toEqual([1530.97, 1299.9]);
    expect(precos("sem preço")).toEqual([]);
    expect(lerValor("900")).toBe(900);
    expect(lerValor("R$ 1.200,50")).toBe(1200.5);
    expect(lerValor("1,5 mil")).toBe(1500);
    expect(lerValor("2k")).toBe(2000);
    expect(lerValor("abc")).toBeNull();
  });

  it("casa todas as palavras, sem acento, número inteiro e com exclusão", () => {
    expect(casa("monitor lg 32", MONITOR)).toBe(true);
    expect(casa("MONITOR ultragear", MONITOR)).toBe(true);
    expect(casa("monitor 27", MONITOR)).toBe(false);
    expect(casa("monitor 3", MONITOR)).toBe(false);
    expect(casa("monitor -curvo", MONITOR)).toBe(true);
    expect(casa("monitor -lg", MONITOR)).toBe(false);
    expect(casa("geladeira", "Geladeira Frost Free Brastemp")).toBe(true);
    expect(casa("cafe", "Café Pilão 500g")).toBe(true);
    expect(casa("-lg", MONITOR)).toBe(false);
    // Palavra inteira: "pro" não é "promoção", "x" não é "xbox".
    const PS5 = "🔥 Console PlayStation 5 Pro 2TB Branco — promoção relâmpago R$ 4.999";
    expect(casa("playstation 5 pro", PS5)).toBe(true);
    expect(casa("ps5 pro", "Console PS5 Pro Digital R$ 4.799")).toBe(true);
    expect(casa("ps5 pro", "Console PS5 Slim, promoção do dia")).toBe(false);
    expect(casa("xbox series x", "Console Xbox Series X 1TB Preto")).toBe(true);
    expect(casa("xbox series x", "Console Xbox Series S 512GB")).toBe(false);
    expect(casa("monitor", "Monitores LG em oferta")).toBe(true);
    expect(casa("monitor", "Monitorar a entrega")).toBe(false);
    // "PlayStation 5", "Playstation5" e "PS 5" são o mesmo "ps5", dos dois lados.
    expect(casa("ps5 pro", PS5)).toBe(true);
    expect(casa("playstation 5 digital", "Console PS5 Slim Digital")).toBe(true);
    expect(casa("ps5 -pro", "Console Playstation5 Slim com leitor")).toBe(true);
    expect(casa("ps5", "Console PS 5 Slim")).toBe(true);
    expect(casa("ps5", "Monitor 55 polegadas PS 55")).toBe(false);
  });

  it("compara o preço com o menor já visto", () => {
    const em = new Date("2026-11-12T15:00:00Z");
    expect(comparacao(null, null, null, "America/Cuiaba")).toMatch(/Sem preço/);
    expect(comparacao(3000, null, 3400, "America/Cuiaba")).toMatch(/Primeiro preço.*teto de R\$ 3\.400/);
    expect(comparacao(2800, { preco: 3000, em }, null, "America/Cuiaba")).toBe("📉 *Menor preço que já vi* (antes: R$ 3.000 em 12/11).");
    expect(comparacao(3000, { preco: 3000, em }, null, "America/Cuiaba")).toMatch(/^🟰 Igual/);
    expect(comparacao(3400, { preco: 3000, em }, null, "America/Cuiaba")).toBe("📈 R$ 400 acima do menor que já vi (R$ 3.000 em 12/11).");
  });

  it("lê o interesse com e sem teto", () => {
    expect(lerInteresse("monitor 27 até 900")).toEqual({ termos: "monitor 27", preco_max: 900 });
    expect(lerInteresse("ssd 2tb ate R$ 1.200,50")).toEqual({ termos: "ssd 2tb", preco_max: 1200.5 });
    expect(lerInteresse("drone dji -mini")).toEqual({ termos: "drone dji -mini", preco_max: null });
    expect(lerInteresse("   ")).toBeNull();
  });

  it.each([
    ["interesse monitor 27 até 900", { tipo: "interesse", termos: "monitor 27", preco_max: 900 }],
    ["Interesse: drone dji", { tipo: "interesse", termos: "drone dji", preco_max: null }],
    ["interesses", { tipo: "interesses" }],
    ["ofertas", { tipo: "interesses" }],
    ["esquece interesse 3", { tipo: "esquecerInteresse", id: 3 }],
    ["promo Emipe Promoções", { tipo: "promo", nome: "Emipe Promoções" }],
    ["promo telegram Pegue Promo", { tipo: "promoTelegram", nome: "Pegue Promo", sim: true }],
    ["solta no telegram Pegue Promo", { tipo: "promoTelegram", nome: "Pegue Promo", sim: false }],
    ["esquece 4", { tipo: "esquecer", id: 4 }],
    ["acompanha Obra Largo do Rosário", { tipo: "acompanhar", nome: "Obra Largo do Rosário", sim: true }],
    ["acompanhar o grupo HIRO", { tipo: "acompanhar", nome: "HIRO", sim: true }],
    ["solta Obra Largo do Rosário", { tipo: "acompanhar", nome: "Obra Largo do Rosário", sim: false }],
    ["deixa de acompanhar HIRO", { tipo: "acompanhar", nome: "HIRO", sim: false }],
  ])("comando: %s", (texto, esperado) => {
    expect(lerComando(texto)).toEqual(esperado);
  });

  it("monta a lista sem interesses nem grupos", () => {
    const t = textoDosInteresses([], [], []);
    expect(t).toContain("nenhum (interesse");
    expect(t).toContain("nenhum (promo");
  });
});

describe.skipIf(!URL_TESTE)("ofertas com banco", () => {
  let db: Db;
  const GRUPO = "120363000000000077@g.us";
  const DONO = "5551900000000@s.whatsapp.net";
  let seq = 0;

  const oferta = (texto: string, deMim = false) =>
    ingerir(
      {
        event: "Message",
        data: {
          Info: { ID: `P${++seq}`, Chat: GRUPO, Sender: deMim ? DONO : "5551988888888@s.whatsapp.net", PushName: "Loja", IsFromMe: deMim, IsGroup: true, Timestamp: new Date().toISOString() },
          Message: { conversation: texto },
        },
      },
      {
        db,
        jidsDoDono: new Set([DONO]),
        aoComando: async () => {},
        aoOferta: async (jid, grupo, t) => {
          const a = await avaliarOferta(db, jid, grupo, t);
          if (a) avisos.push(a);
        },
      },
    );
  let avisos: string[] = [];

  beforeAll(async () => {
    db = abrirDb(URL_TESTE!);
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrar(db);
  });
  afterAll(async () => db?.end());
  beforeEach(async () => {
    avisos = [];
    await db.query("TRUNCATE contatos, mensagens, interesses, ofertas_avisadas, telegram_chats RESTART IDENTITY CASCADE");
  });

  it("grupo de promoção não grava nada, avisa uma vez e respeita o teto", async () => {
    await oferta("mensagem antes de virar promo");
    await db.query("UPDATE contatos SET nome = 'Emipe Promoções' WHERE jid = $1", [GRUPO]);
    await repo.marcarPromo(db, GRUPO);
    expect((await db.query("SELECT count(*)::int AS n FROM mensagens")).rows[0].n).toBe(0);

    await adicionarInteresse(db, "monitor 32", 900);
    await adicionarInteresse(db, "monitor lg", 800);

    expect(await oferta(MONITOR)).toBe("promo");
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain("#1 monitor 32 (até R$ 900)");
    expect(avisos[0]).not.toContain("monitor lg");
    expect(avisos[0]).toContain("no Emipe Promoções");
    expect(avisos[0]).toContain("Primeiro preço que vejo");

    // Repostada (outro id, mesmo texto e preço): não avisa de novo.
    await oferta(MONITOR);
    expect(avisos).toHaveLength(1);
    // Mais barata: é outra oferta, e agora cabe no teto de 800 também.
    await oferta(MONITOR.replace("R$ 899", "R$ 749"));
    expect(avisos).toHaveLength(2);
    expect(avisos[1]).toContain("#2 monitor lg");
    // O 899 ficou no histórico dos dois, até no #2, cujo teto (800) ele passava.
    expect(avisos[1]).toContain("#1: 📉 *Menor preço que já vi* (antes: R$ 899");
    expect(avisos[1]).toContain("#2: 📉 *Menor preço que já vi* (antes: R$ 899");

    await oferta("Geladeira Frost Free R$ 2.999");
    expect(avisos).toHaveLength(2);

    // Bem abaixo do teto é jogo ou acessório: não avisa nem vira "menor preço".
    await adicionarInteresse(db, "ps5 -digital -jogo", 3400);
    await oferta("🔥 Grand Theft Auto Vi Playstation 5 💵 R$ 349");
    expect(avisos).toHaveLength(2);
    expect((await db.query("SELECT count(*)::int AS n FROM precos_vistos WHERE interesse_id = 3")).rows[0].n).toBe(0);
    await oferta("Console PlayStation 5 com leitor 💵 R$ 3.299");
    expect(avisos).toHaveLength(3);
    expect(avisos[2]).toContain("Primeiro preço que vejo");
    expect((await db.query("SELECT count(*)::int AS n FROM mensagens")).rows[0].n).toBe(0);
    expect(await repo.gruposDePromo(db)).toEqual(["Emipe Promoções"]);

    // "volta" desfaz: o grupo grava de novo e sai da lista de promoção.
    await repo.excluirChat(db, GRUPO, false);
    expect(await oferta("agora grava")).toBe("gravado");
    expect(await repo.gruposDePromo(db)).toEqual([]);
  });
  it("chat do Telegram vira promoção pelo nome, sem acento nem caixa", async () => {
    expect(await marcarPromoTelegramPeloNome(db, "Pegue Promo")).toContain("ainda não está ligada");
    await gravarChatsTelegram(db, [
      { id: "-1001", nome: "Pegue Promo 🔥" },
      { id: "-1002", nome: "Pegue Promo Games" },
      { id: "-1003", nome: "Família" },
    ]);
    expect(await marcarPromoTelegramPeloNome(db, "pegue promo")).toContain("Achei mais de um");
    expect(await marcarPromoTelegramPeloNome(db, "Pegue Promo 🔥")).toContain("virou grupo de promoção");
    expect([...(await promoTelegram(db)).entries()]).toEqual([["-1001", "Pegue Promo 🔥"]]);
    expect(await repo.gruposDePromo(db)).toEqual(["Pegue Promo 🔥 (Telegram)"]);
    // O nome muda no Telegram: a releitura atualiza, sem perder a marca.
    await gravarChatsTelegram(db, [{ id: "-1001", nome: "Pegue Promo" }]);
    expect(await repo.gruposDePromo(db)).toEqual(["Pegue Promo (Telegram)"]);
    expect(await marcarPromoTelegramPeloNome(db, "familia", false)).toContain("saiu dos grupos");
  });
  it("foto só é lida em conversa individual ou grupo acompanhado, e PDF sempre", async () => {
    const lidas: string[] = [];
    const pdfs: string[] = [];
    const evento = (chat: string, grupo: boolean, message: object) =>
      ingerir(
        { event: "Message", data: { Info: { ID: `F${++seq}`, Chat: chat, Sender: "5551988888888@s.whatsapp.net", PushName: "Mestre", IsFromMe: false, IsGroup: grupo, Timestamp: new Date().toISOString() }, Message: message } },
        {
          db,
          jidsDoDono: new Set([DONO]),
          aoComando: async () => {},
          aoImagem: async (m) => void lidas.push(m.id),
          aoDocumento: async (m) => void pdfs.push(m.texto),
        },
      );
    const foto = { imageMessage: { caption: "laje" } };
    await evento(GRUPO, true, foto);
    expect(lidas).toHaveLength(0);
    await repo.acompanharGrupo(db, GRUPO, true);
    await evento(GRUPO, true, foto);
    expect(lidas).toHaveLength(1);

    await evento(GRUPO, true, { documentMessage: { fileName: "Proposta Obra.pdf" } });
    await evento(GRUPO, true, { documentMessage: { fileName: "planta.dwg" } });
    await new Promise((r) => setTimeout(r, 10));
    expect(pdfs).toEqual(["[arquivo: Proposta Obra.pdf]"]);
  });
});
