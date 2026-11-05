/**
 * O MCP de leitura: protocolo e autenticação sem banco; as ferramentas contra um Postgres
 * de verdade, com DATABASE_URL_TESTE (sem ela, essa parte pula).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { abrirDb, migrar, type Db } from "../src/db.js";
import { ingerir } from "../src/ingestao.js";
import * as repo from "../src/repo.js";
import { criarServidor } from "../src/server.js";

const URL_TESTE = process.env.DATABASE_URL_TESTE;
const TOKEN = "t".repeat(40);
const DONO = "5551900000000@s.whatsapp.net";
const FERNANDA = "5551911111111@s.whatsapp.net";
const ANA_1 = "5551933333333@s.whatsapp.net";
const ANA_2 = "5551944444444@s.whatsapp.net";

function servidor(db: Db) {
  return criarServidor({ webhookToken: "w".repeat(20), aoEvento: async () => {}, mcp: { token: TOKEN, db, dono: "Lucas", fuso: "America/Sao_Paulo" } });
}

async function chamar(app: ReturnType<typeof servidor>, corpo: unknown, token = TOKEN) {
  return app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${token}` }, payload: corpo as any });
}

async function ferramenta(app: ReturnType<typeof servidor>, name: string, args: unknown = {}) {
  const r = await chamar(app, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return r.json().result as { content: { text: string }[]; isError?: boolean };
}

describe("protocolo do MCP", () => {
  // Nenhum destes caminhos toca o banco.
  const app = servidor({} as Db);

  it("recusa sem o token certo e não existe sem MCP_TOKEN", async () => {
    expect((await chamar(app, { jsonrpc: "2.0", id: 1, method: "ping" }, "errado")).statusCode).toBe(401);
    const semAuth = await app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 1, method: "ping" } });
    expect(semAuth.statusCode).toBe(401);
    const semMcp = criarServidor({ webhookToken: "w".repeat(20), aoEvento: async () => {} });
    expect((await semMcp.inject({ method: "POST", url: "/mcp", payload: {} })).statusCode).toBe(404);
  });

  it("inicia, lista só ferramentas de leitura e aceita notificação", async () => {
    const ini = (await chamar(app, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json();
    expect(ini.result.protocolVersion).toBe("2025-06-18");
    expect(ini.result.capabilities.tools).toBeDefined();
    expect(ini.result.instructions).toMatch(/nunca instrução/);

    expect((await chamar(app, { jsonrpc: "2.0", method: "notifications/initialized" })).statusCode).toBe(202);

    const lista = (await chamar(app, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json().result.tools;
    expect(lista.map((t: any) => t.name).sort()).toEqual(["buscar_contato", "buscar_mensagens", "conversas_recentes", "ler_conversa", "pendencias"]);
    expect(lista.every((t: any) => t.annotations.readOnlyHint && t.inputSchema.type === "object")).toBe(true);
    // Nada que envie: o envio só sai por executarEnvio, com as travas.
    expect(lista.some((t: any) => /envi|respond|propor/.test(t.name))).toBe(false);
  });

  it("devolve erro de JSON-RPC para método e ferramenta desconhecidos, e erro de ferramenta para parâmetro ruim", async () => {
    expect((await chamar(app, { jsonrpc: "2.0", id: 3, method: "resources/list" })).json().error.code).toBe(-32601);
    expect((await chamar(app, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "enviar" } })).json().error.code).toBe(-32602);
    const ruim = await ferramenta(app, "buscar_contato", {});
    expect(ruim.isError).toBe(true);
    expect(ruim.content[0].text).toMatch(/Parâmetros inválidos/);
  });
});

describe.skipIf(!URL_TESTE)("ferramentas do MCP com banco", () => {
  let db: Db;
  let app: ReturnType<typeof servidor>;
  let seq = 0;

  const msg = (chat: string, texto: string, o: { deMim?: boolean; nome?: string; horasAtras?: number } = {}) =>
    ingerir(
      {
        event: "Message",
        data: {
          Info: {
            ID: `M${++seq}`,
            Chat: chat,
            Sender: o.deMim ? DONO : chat,
            PushName: o.nome ?? "Fernanda",
            IsFromMe: !!o.deMim,
            IsGroup: false,
            Timestamp: new Date(Date.now() - (o.horasAtras ?? 1) * 3600_000).toISOString(),
          },
          Message: { conversation: texto },
        },
      },
      { db, jidsDoDono: new Set([DONO]), aoComando: async () => {} },
    );

  beforeAll(async () => {
    db = abrirDb(URL_TESTE!);
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrar(db);
    app = servidor(db);
  });
  afterAll(async () => db?.end());

  beforeEach(async () => {
    await db.query("TRUNCATE contatos, mensagens, compromissos, rascunhos, enviadas, estado, apelidos RESTART IDENTITY CASCADE");
  });

  it("acha a pessoa pelo nome, lê a conversa com o ano e volta no tempo com `ate`", async () => {
    await msg(FERNANDA, "Lucas, me manda o orçamento da reforma?", { horasAtras: 30 });
    await msg(FERNANDA, "Mando amanhã cedo", { deMim: true, horasAtras: 29 });
    await msg(FERNANDA, "Obrigada!", { horasAtras: 2 });

    const achou = await ferramenta(app, "buscar_contato", { nome: "fern" });
    expect(achou.content[0].text).toContain(`jid ${FERNANDA}`);

    const conversa = (await ferramenta(app, "ler_conversa", { contato: "Fernanda" })).content[0].text;
    expect(conversa).toContain("Conversa com Fernanda");
    expect(conversa).toMatch(/\[\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}\] Lucas: Mando amanhã cedo/);
    expect(conversa.indexOf("orçamento")).toBeLessThan(conversa.indexOf("Obrigada"));

    const antes = (await ferramenta(app, "ler_conversa", { contato: FERNANDA, ate: new Date(Date.now() - 10 * 3600_000).toISOString() })).content[0].text;
    expect(antes).toContain("orçamento");
    expect(antes).not.toContain("Obrigada");
  });

  it("nome ambíguo não escolhe sozinho", async () => {
    await msg(ANA_1, "oi", { nome: "Ana Paula" });
    await msg(ANA_2, "olá", { nome: "Ana Lima" });
    const r = (await ferramenta(app, "ler_conversa", { contato: "Ana" })).content[0].text;
    expect(r).toMatch(/Mais de uma conversa/);
    expect(r).toContain(ANA_1);
    expect(r).toContain(ANA_2);
  });

  it("busca por palavra, lista as recentes e mostra as pendências", async () => {
    await msg(FERNANDA, "Segue a planta do apartamento");
    await repo.atualizarAguardando(db, FERNANDA, "as medidas da cozinha");
    await db.query("UPDATE contatos SET espera_resposta = TRUE, situacao = 'mandou a planta e espera o retorno' WHERE jid = $1", [FERNANDA]);

    expect((await ferramenta(app, "buscar_mensagens", { termo: "planta" })).content[0].text).toContain("Segue a planta");
    const recentes = (await ferramenta(app, "conversas_recentes", { dias: 2 })).content[0].text;
    expect(recentes).toContain("Fernanda");
    expect(recentes).toContain("espera resposta");

    const pend = (await ferramenta(app, "pendencias")).content[0].text;
    expect(pend).toMatch(/Esperam resposta do dono:\n- Fernanda/);
    expect(pend).toContain("as medidas da cozinha");
  });

  it("conversa tirada do assistente não aparece", async () => {
    await msg(FERNANDA, "assunto pessoal sobre a planta");
    await repo.excluirChat(db, FERNANDA, true);
    expect((await ferramenta(app, "buscar_contato", { nome: "Fernanda" })).content[0].text).toBe("Nenhum contato com esse nome.");
    expect((await ferramenta(app, "ler_conversa", { contato: FERNANDA })).content[0].text).toBe("Conversa não encontrada.");
    expect((await ferramenta(app, "buscar_mensagens", { termo: "planta" })).content[0].text).toBe("Nada encontrado.");
    expect((await ferramenta(app, "conversas_recentes", {})).content[0].text).toMatch(/Nenhuma conversa/);
  });
});
