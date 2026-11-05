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

class EnvioFalso {
  enviadas: { destino: string; texto: string }[] = [];
  grupos: { nome: string; participantes: string[] }[] = [];
  avisos: string[] = [];
  evolution = {
    enviarTexto: async (destino: string, texto: string) => {
      this.enviadas.push({ destino, texto });
      return `E${this.enviadas.length}`;
    },
    enviarImagem: async () => null,
    enviarArquivo: async (destino: string, a: { nome: string }, legenda: string) => {
      this.enviadas.push({ destino, texto: `[arquivo ${a.nome}] ${legenda}` });
      return `D${this.enviadas.length}`;
    },
    criarGrupo: async (nome: string, participantes: string[]) => {
      this.grupos.push({ nome, participantes });
      return "120363000000000009@g.us";
    },
    contatos: async () => [],
    grupos: async () => [],
    baixarMidia: async () => ({ buffer: Buffer.from(""), mimetype: "" }),
  };
  avisar = async (t: string) => void this.avisos.push(t);
}

function servidor(db: Db, envio?: EnvioFalso) {
  return criarServidor({
    webhookToken: "w".repeat(20),
    aoEvento: async () => {},
    mcp: { token: TOKEN, db, dono: "Lucas", fuso: "America/Sao_Paulo", envio: envio && { evolution: envio.evolution, avisar: envio.avisar } },
  });
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
    expect(lista.map((t: any) => t.name).sort()).toEqual(["arquivos", "buscar_contato", "buscar_mensagens", "conversas_recentes", "exportar", "interesses", "ler_conversa", "novidades", "pendencias"]);
    expect(lista.every((t: any) => t.annotations.readOnlyHint && t.inputSchema.type === "object")).toBe(true);
    // Nada que envie: o envio só sai por executarEnvio, com as travas.
    expect(lista.some((t: any) => /envi|respond|propor/.test(t.name))).toBe(false);
  });

  it("com envio ligado, lista as ferramentas de envio sem a marca de leitura", async () => {
    const comEnvio = servidor({} as Db, new EnvioFalso());
    const lista = (await chamar(comEnvio, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json().result.tools;
    const envio = lista.filter((t: any) => !t.annotations.readOnlyHint).map((t: any) => t.name).sort();
    expect(envio).toEqual(["acompanhar_grupo", "adicionar_interesse", "anotar_aguardando", "concluir_compromisso", "criar_grupo", "enviar_rascunho", "marcar_promocao", "preparar_mensagem", "remover_interesse"]);
    const ini = (await chamar(comEnvio, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).json();
    expect(ini.result.instructions).toMatch(/só depois do sim dele/);
  });

  it("resumo_do_dia só existe com o resumo nas deps e devolve o texto dele", async () => {
    const semResumo = (await chamar(app, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json().result.tools;
    expect(semResumo.some((t: any) => t.name === "resumo_do_dia")).toBe(false);
    const comResumo = criarServidor({
      webhookToken: "w".repeat(20),
      aoEvento: async () => {},
      mcp: { token: TOKEN, db: {} as Db, dono: "Lucas", fuso: "America/Sao_Paulo", resumo: async () => "☀️ Bom dia, Lucas" },
    });
    const r = await chamar(comResumo, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "resumo_do_dia", arguments: {} } });
    expect(r.json().result.content[0].text).toBe("☀️ Bom dia, Lucas");
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

  it("lê só o que é novo com `desde` e junta as novidades de todas as conversas", async () => {
    await msg(FERNANDA, "mensagem velha", { horasAtras: 30 });
    await msg(FERNANDA, "mensagem nova", { horasAtras: 2 });
    await msg(ANA_1, "oi, tudo bem?", { nome: "Ana Paula", horasAtras: 1 });
    const corte = new Date(Date.now() - 10 * 3600_000).toISOString();

    const depois = (await ferramenta(app, "ler_conversa", { contato: FERNANDA, desde: corte })).content[0].text;
    expect(depois).toContain("mensagem nova");
    expect(depois).not.toContain("mensagem velha");
    expect((await ferramenta(app, "ler_conversa", { contato: FERNANDA, desde: corte, ate: corte })).content[0].text).toMatch(/não os dois/);

    const tudo = (await ferramenta(app, "novidades", { desde: corte })).content[0].text;
    expect(tudo).toMatch(/^2 conversa\(s\) com novidade/);
    expect(tudo).toContain("mensagem nova");
    expect(tudo).toContain("oi, tudo bem?");
    expect(tudo).not.toContain("mensagem velha");

    const semAna = (await ferramenta(app, "novidades", { desde: corte, ignorar: [ANA_1] })).content[0].text;
    expect(semAna).not.toContain("oi, tudo bem?");

    const corta = (await ferramenta(app, "novidades", { desde: new Date(Date.now() - 40 * 3600_000).toISOString(), por_conversa: 1 })).content[0].text;
    expect(corta).toContain("mensagem velha");
    expect(corta).toContain("(+1 mensagens depois destas");

    expect((await ferramenta(app, "conversas_recentes", { desde: corte })).content[0].text).toContain("Ana Paula");
    expect((await ferramenta(app, "novidades", { desde: new Date().toISOString() })).content[0].text).toBe("Nada novo depois desse instante.");
  });

  it("o nome do grupo vem do WhatsApp e acompanha a troca", async () => {
    const GRUPO = "120363000000000042@g.us";
    await repo.garantirContato(db, GRUPO, { grupo: true });
    expect(await repo.gravarNomesDeGrupos(db, [{ jid: GRUPO, nome: "Obra Florais" }, { jid: "120363000000000043@g.us", nome: "Não conhecido" }])).toBe(1);
    expect(await repo.gravarNomesDeGrupos(db, [{ jid: GRUPO, nome: "Obra Florais" }])).toBe(0);
    expect(await repo.gravarNomesDeGrupos(db, [{ jid: GRUPO, nome: "Obra Florais · Entrega" }])).toBe(1);
    expect((await repo.lerContato(db, GRUPO))?.nome).toBe("Obra Florais · Entrega");
    // Pessoa não é tocada, mesmo com o jid na lista.
    await msg(FERNANDA, "oi");
    expect(await repo.gravarNomesDeGrupos(db, [{ jid: FERNANDA, nome: "Outro nome" }])).toBe(0);
  });

  it("exporta as fichas e fecha compromisso e espera pelo MCP", async () => {
    await msg(FERNANDA, "Te mando as medidas na sexta");
    await db.query("UPDATE contatos SET relacao = 'cliente', resumo = 'cliente da reforma', situacao = 'vai mandar as medidas' WHERE jid = $1", [FERNANDA]);
    const k = await db.query<{ id: number }>(
      "INSERT INTO compromissos (chat_jid, descricao, responsavel) VALUES ($1, 'mandar as medidas', 'contato') RETURNING id",
      [FERNANDA],
    );
    const id = k.rows[0].id;

    const fichas = JSON.parse((await ferramenta(app, "exportar")).content[0].text);
    const f = fichas.find((x: any) => x.jid === FERNANDA);
    expect(f).toMatchObject({ nome: "Fernanda", relacao: "cliente", quem_e: "cliente da reforma", mensagens: 1 });
    expect(f.compromissos).toEqual([expect.objectContaining({ id, descricao: "mandar as medidas", status: "sugerido" })]);

    const comEnvio = servidor(db, new EnvioFalso());
    expect((await ferramenta(comEnvio, "concluir_compromisso", { id })).content[0].text).toBe(`Compromisso #${id}: feito.`);
    expect((await ferramenta(comEnvio, "concluir_compromisso", { id: 9999 })).content[0].text).toMatch(/Não achei/);
    expect(await repo.compromissosAbertos(db)).toHaveLength(0);

    expect((await ferramenta(comEnvio, "anotar_aguardando", { contato: "Fernanda", texto: "as medidas da cozinha" })).content[0].text).toContain("as medidas da cozinha");
    expect((await repo.lerContato(db, FERNANDA))?.aguardando).toBe("as medidas da cozinha");
    await ferramenta(comEnvio, "anotar_aguardando", { contato: FERNANDA, texto: "" });
    expect((await repo.lerContato(db, FERNANDA))?.aguardando).toBe("");
    // Sem envio, o MCP é só leitura: as de escrita nem existem.
    const semEnvio = await chamar(app, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "concluir_compromisso", arguments: { id } } });
    expect(semEnvio.json().error.message).toMatch(/ferramenta desconhecida/);
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

  it("prepara sem enviar, envia só pelo #id e não envia duas vezes", async () => {
    await msg(FERNANDA, "Oi Lucas");
    const envio = new EnvioFalso();
    const app2 = servidor(db, envio);
    const prep = (await ferramenta(app2, "preparar_mensagem", { contato: "Fernanda", texto: "Oi Fernanda, tudo certo." })).content[0].text;
    expect(prep).toMatch(/Rascunho #1 para Fernanda/);
    expect(envio.enviadas).toHaveLength(0);
    expect(envio.avisos[0]).toContain("Oi Fernanda, tudo certo.");

    expect((await ferramenta(app2, "enviar_rascunho", { id: 1 })).content[0].text).toBe("Enviado o #1.");
    expect(envio.enviadas).toEqual([{ destino: FERNANDA, texto: "Oi Fernanda, tudo certo." }]);
    expect((await ferramenta(app2, "ler_conversa", { contato: FERNANDA })).content[0].text).toContain("Lucas: Oi Fernanda, tudo certo.");
    expect((await ferramenta(app2, "enviar_rascunho", { id: 1 })).content[0].text).toMatch(/não está aguardando/);
    expect(envio.enviadas).toHaveLength(1);
  });

  it("cria grupo só com confirmar, e o grupo já serve de destino", async () => {
    await msg(FERNANDA, "Oi");
    await msg(ANA_1, "olá", { nome: "Ana Paula" });
    const envio = new EnvioFalso();
    const app2 = servidor(db, envio);
    const previa = (await ferramenta(app2, "criar_grupo", { nome: "Obra Teste", participantes: ["Fernanda", ANA_1] })).content[0].text;
    expect(previa).toMatch(/confirmar: true/);
    expect(envio.grupos).toHaveLength(0);

    await ferramenta(app2, "criar_grupo", { nome: "Obra Teste", participantes: ["Fernanda", ANA_1], confirmar: true });
    expect(envio.grupos).toEqual([{ nome: "Obra Teste", participantes: [FERNANDA, ANA_1] }]);
    expect((await ferramenta(app2, "preparar_mensagem", { contato: "Obra Teste", texto: "Bem-vindas" })).content[0].text).toMatch(/\(grupo\)/);
  });
});
