import { describe, expect, it } from "vitest";
import { riscoPorPalavra } from "../src/autonomia.js";
import { lerConfig } from "../src/config.js";
import { lerComando, sugerirSubir } from "../src/controle.js";
import { criarGoogle, horariosLivres } from "../src/google.js";
import { dataCurta, meiaNoiteEm } from "../src/formato.js";
import { comandoDoPainel } from "../src/painel.js";

const SP = "America/Sao_Paulo";

describe("horariosLivres", () => {
  const exp = { inicioH: 9, fimH: 18, fuso: SP };

  it("pula ocupado, fim de semana e fora do expediente", () => {
    // Sexta 23/10/2026, das 8h às 13h em SP (11h–16h UTC); ocupado 9h–10h30.
    const livres = horariosLivres(
      [{ inicio: new Date("2026-10-23T12:00:00Z"), fim: new Date("2026-10-23T13:30:00Z") }],
      { de: new Date("2026-10-23T11:00:00Z"), ate: new Date("2026-10-23T16:00:00Z") },
      60,
      exp,
    );
    expect(livres.map((l) => l.inicio.toISOString())).toEqual([
      "2026-10-23T13:30:00.000Z", // 10h30
      "2026-10-23T14:30:00.000Z", // 11h30
    ]);
    // Sábado: nada.
    expect(horariosLivres([], { de: new Date("2026-10-24T12:00:00Z"), ate: new Date("2026-10-24T20:00:00Z") }, 60, exp)).toEqual([]);
  });

  it("não passa do fim do expediente", () => {
    const livres = horariosLivres([], { de: new Date("2026-10-23T19:30:00Z"), ate: new Date("2026-10-23T23:00:00Z") }, 60, exp);
    // 16h30–17h30 cabe; 17h30–18h30 não.
    expect(livres.map((l) => l.inicio.toISOString())).toEqual(["2026-10-23T19:30:00.000Z"]);
  });
});

describe("riscoPorPalavra (barreira sem modelo)", () => {
  it.each([
    "O valor fica R$ 4.500",
    "te passo o pix",
    "o orçamento sai amanhã",
    "consigo entregar até sexta",
    "assino o contrato hoje",
    "sinto muito pela sua perda",
  ])("%s → alto", (t) => expect(riscoPorPalavra(t)).not.toBeNull());

  it.each(["Recebi, obrigado!", "Combinado, quinta às 15h então", "Bom dia! Vejo e te falo"])("%s → passa", (t) =>
    expect(riscoPorPalavra(t)).toBeNull(),
  );
});

describe("comandos novos", () => {
  it.each([
    ["cobra Fernanda", { tipo: "cobrar", nome: "Fernanda" }],
    ["autonomia", { tipo: "autonomia" }],
    ["autonomia Fernanda Moraes 2", { tipo: "autonomia", nome: "Fernanda Moraes", nivel: 2 }],
    ["pausa", { tipo: "pausa" }],
    ["retoma", { tipo: "retoma" }],
    ["veta 7", { tipo: "descartar", id: 7 }],
  ])("%s", (t, esperado) => expect(lerComando(t)).toEqual(esperado));

  it("autonomia com nível fora de 0–3 não é comando", () => {
    expect(lerComando("autonomia Fernanda 5").tipo).toBe("pedido");
  });

  it("sugere subir de nível com 10 decididos e 90% sem ajuste", () => {
    expect(sugerirSubir({ decididos: 10, sem_ajuste: 9, autonomia: 1 })).toBe(true);
    expect(sugerirSubir({ decididos: 9, sem_ajuste: 9, autonomia: 1 })).toBe(false);
    expect(sugerirSubir({ decididos: 20, sem_ajuste: 15, autonomia: 1 })).toBe(false);
    expect(sugerirSubir({ decididos: 20, sem_ajuste: 20, autonomia: 3 })).toBe(false);
  });
});

describe("comandoDoPainel", () => {
  it("botões viram os comandos do WhatsApp", () => {
    expect(comandoDoPainel({ acao: "enviar", id: "12" })).toEqual({ texto: "ok 12" });
    expect(comandoDoPainel({ acao: "descartar", id: "3" })).toEqual({ texto: "descarta 3" });
    expect(comandoDoPainel({ acao: "regra", texto: " nunca antes das 9 " })).toEqual({ texto: "regra nunca antes das 9" });
    expect(comandoDoPainel({ acao: "pausa" })).toEqual({ texto: "pausa" });
    expect(comandoDoPainel({ acao: "autonomia", jid: "x@s.whatsapp.net", nivel: "2" })).toEqual({ autonomia: { jid: "x@s.whatsapp.net", nivel: 2 } });
    expect(comandoDoPainel({ acao: "autonomia", jid: "x@s.whatsapp.net", nivel: "" })).toEqual({ autonomia: { jid: "x@s.whatsapp.net", nivel: null } });
  });

  it("recusa id que não é número e ação desconhecida", () => {
    expect(comandoDoPainel({ acao: "enviar", id: "1; drop" })).toBeNull();
    expect(comandoDoPainel({ acao: "autonomia", jid: "x", nivel: "9" })).toBeNull();
    expect(comandoDoPainel({ acao: "apagar_tudo" })).toBeNull();
  });
});

describe("config", () => {
  const base = {
    DATABASE_URL: "postgres://x",
    EVOLUTION_API_URL: "http://evolution:8080",
    EVOLUTION_INSTANCE_TOKEN: "t",
    WEBHOOK_TOKEN: "0123456789abcdef",
    DONO_NUMERO: "5551999990000",
  };
  it("chave em branco no .env vale como ausente", () => {
    const c = lerConfig({ ...base, KOREOS_MCP_URL: "", GOOGLE_CLIENT_ID: "  ", PAINEL_TOKEN: "" });
    expect(c.KOREOS_MCP_URL).toBeUndefined();
    expect(c.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(c.AUTONOMIA_PADRAO).toBe(0);
    expect(c.AGENDA_SINCRONIZAR).toBe(true);
  });
});

describe("cliente do Google", () => {
  function fetchFalso() {
    const chamadas: { url: string; init?: RequestInit }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      chamadas.push({ url, init });
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.includes("oauth2.googleapis.com/token")) return json({ access_token: "AT", expires_in: 3600 });
      if (url.includes("/calendars/primary/events?") && (!init?.method || init.method === "GET")) {
        return json({
          items: [
            { id: "e1", summary: "Reunião com Fernanda", start: { dateTime: "2026-10-23T14:00:00-03:00" }, end: { dateTime: "2026-10-23T15:00:00-03:00" }, attendees: [{ email: "fe@x.com", displayName: "Fernanda Moraes" }, { email: "eu@x.com", self: true }] },
            { id: "e2", status: "cancelled", summary: "cancelado", start: { dateTime: "2026-10-23T16:00:00-03:00" }, end: { dateTime: "2026-10-23T17:00:00-03:00" } },
            { id: "e3", summary: "Feriado", start: { date: "2026-11-02" }, end: { date: "2026-11-03" } },
          ],
        });
      }
      if (url.includes("/drafts")) return json({ id: "d1" });
      return json({});
    }) as unknown as typeof fetch;
    return { f, chamadas };
  }

  it("renova o token uma vez e lê os eventos (sem cancelados, sem o próprio dono)", async () => {
    const { f, chamadas } = fetchFalso();
    const g = criarGoogle({ clientId: "c", clientSecret: "s", refreshToken: "r", fuso: SP }, f);
    const evs = await g.eventos(new Date(), new Date());
    await g.eventos(new Date(), new Date());
    expect(chamadas.filter((c) => c.url.includes("oauth2")).length).toBe(1);
    expect(evs.map((e) => e.id)).toEqual(["e1", "e3"]);
    expect(evs[0].convidados).toEqual([{ email: "fe@x.com", nome: "Fernanda Moraes" }]);
    expect(evs[1].diaInteiro).toBe(true);
    // Dia inteiro é meia-noite em São Paulo, não 21h da véspera (container em UTC).
    expect(evs[1].inicio.toISOString()).toBe("2026-11-02T03:00:00.000Z");
    expect(dataCurta(evs[1].inicio, SP).slice(0, 5)).toBe("02/11");
    expect((chamadas[1].init?.headers as Record<string, string>).Authorization).toBe("Bearer AT");
  });

  it("rascunho de e-mail com acento no assunto e na mesma conversa", async () => {
    const { f, chamadas } = fetchFalso();
    const g = criarGoogle({ clientId: "c", clientSecret: "s", refreshToken: "r", fuso: SP }, f);
    await g.rascunhoEmail({ para: "fe@x.com", assunto: "Orçamento", corpo: "Olá", threadId: "t1", emResposta: "m1" });
    const corpo = JSON.parse(String(chamadas.at(-1)!.init!.body));
    expect(corpo.message.threadId).toBe("t1");
    const raw = Buffer.from(corpo.message.raw, "base64url").toString("utf8");
    expect(raw).toContain("Subject: =?UTF-8?B?");
    expect(raw).toContain("In-Reply-To: m1");
    expect(raw.endsWith("\r\n\r\nOlá")).toBe(true);
  });
});

describe("meiaNoiteEm", () => {
  it("meia-noite no fuso do dono", () => {
    expect(meiaNoiteEm("2026-10-22", SP).toISOString()).toBe("2026-10-22T03:00:00.000Z");
    expect(meiaNoiteEm("2026-10-22", "UTC").toISOString()).toBe("2026-10-22T00:00:00.000Z");
    expect(meiaNoiteEm("2026-07-01", "Europe/Lisbon").toISOString()).toBe("2026-06-30T23:00:00.000Z");
  });
});

describe("log sem segredo", () => {
  it("o token do caminho some da URL registrada", async () => {
    const { ocultarToken } = await import("../src/server.js");
    expect(ocultarToken("/webhook/segredo123")).toBe("/webhook/***");
    expect(ocultarToken("/painel/abc/acao")).toBe("/painel/***/acao");
    expect(ocultarToken("/saude")).toBe("/saude");
  });
});
