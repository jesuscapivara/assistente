/**
 * Arquivos das conversas: nome, tipo e o que guardar sem banco; a rota de download com o
 * token; a lista do MCP contra um Postgres de verdade (DATABASE_URL_TESTE).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mimeDaMidia, mimePeloNome, nomeDoArquivo, semMiniatura, tipoDeEnvio } from "../src/arquivos.js";
import { guardarArquivo } from "../src/midia.js";
import { abrirDb, migrar, type Db } from "../src/db.js";
import { ingerir } from "../src/ingestao.js";
import * as repo from "../src/repo.js";
import { criarServidor } from "../src/server.js";

const URL_TESTE = process.env.DATABASE_URL_TESTE;
const TOKEN = "t".repeat(40);
const DONO = "5551900000000@s.whatsapp.net";
const CLIENTE = "5551977777777@s.whatsapp.net";

describe("arquivo", () => {
  it("tira a miniatura e acha o tipo onde estiver", () => {
    const bruto = { documentMessage: { fileName: "a.pdf", mimetype: "application/pdf", JPEGThumbnail: "AAAA", mediaKey: "k", contextInfo: { thumbnailUrl: "x" } } };
    expect(semMiniatura(bruto)).toEqual({ documentMessage: { fileName: "a.pdf", mimetype: "application/pdf", mediaKey: "k", contextInfo: {} } });
    expect(mimeDaMidia(bruto)).toBe("application/pdf");
    expect(mimeDaMidia({ ImageMessage: { Mimetype: "image/jpeg; x=1" } })).toBe("image/jpeg");
    expect(mimeDaMidia({})).toBeNull();
  });

  it("dá nome ao arquivo pelo documento ou pelo tipo", () => {
    expect(nomeDoArquivo({ id: "M1", tipo: "documento", texto: "[arquivo: Proposta: obra/2.pdf] segue" }, "application/pdf")).toBe("Proposta_ obra_2.pdf");
    expect(nomeDoArquivo({ id: "M2", tipo: "imagem", texto: "laje" }, "image/jpeg")).toBe("imagem-M2.jpg");
    expect(nomeDoArquivo({ id: "M3", tipo: "audio", texto: "[áudio] oi" }, "audio/ogg")).toBe("audio-M3.ogg");
    expect(nomeDoArquivo({ id: "M4", tipo: "video", texto: "" }, null)).toBe("video-M4.bin");
  });

  it("tipo pelo nome e como o WhatsApp mostra; /midia serve o anexo com o tipo dele", async () => {
    expect(mimePeloNome("Proposta.PDF")).toBe("application/pdf");
    expect(mimePeloNome("foto.jpeg")).toBe("image/jpeg");
    expect(mimePeloNome("planta.dwg")).toBe("application/octet-stream");
    expect(tipoDeEnvio("image/jpeg")).toBe("image");
    expect(tipoDeEnvio("application/pdf")).toBe("document");
    expect(tipoDeEnvio("image/webp")).toBe("document");
    const app = criarServidor({ webhookToken: "w".repeat(20), aoEvento: async () => {} });
    const id = guardarArquivo(Buffer.from("%PDF"), "application/pdf");
    const r = await app.inject({ method: "GET", url: `/midia/${id}.pdf` });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("application/pdf");
  });

  it("a rota de download pede o token e devolve o arquivo com o nome", async () => {
    const app = criarServidor({
      webhookToken: "w".repeat(20),
      aoEvento: async () => {},
      arquivos: {
        token: TOKEN,
        baixar: async (id) =>
          id === "M1" ? { buffer: Buffer.from("%PDF"), mimetype: "application/pdf", nome: "Proposta Obra.pdf" } : id === "M2" ? null : Promise.reject(new Error("expirou")),
      },
    });
    expect((await app.inject({ method: "GET", url: "/arquivo/M1" })).statusCode).toBe(401);
    const ok = await app.inject({ method: "GET", url: "/arquivo/M1", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toBe("application/pdf");
    expect(ok.headers["content-disposition"]).toBe("attachment; filename*=UTF-8''Proposta%20Obra.pdf");
    expect(ok.body).toBe("%PDF");
    expect((await app.inject({ method: "GET", url: "/arquivo/M2", headers: { authorization: `Bearer ${TOKEN}` } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/arquivo/M3", headers: { authorization: `Bearer ${TOKEN}` } })).statusCode).toBe(502);
  });
});

describe.skipIf(!URL_TESTE)("arquivos com banco", () => {
  let db: Db;
  let seq = 0;
  const receber = (message: object, chat = CLIENTE) =>
    ingerir(
      {
        event: "Message",
        data: {
          Info: { ID: `A${++seq}`, Chat: chat, Sender: chat, PushName: "Cliente", IsFromMe: false, IsGroup: false, Timestamp: new Date().toISOString() },
          Message: message,
        },
      },
      { db, jidsDoDono: new Set([DONO]), aoComando: async () => {} },
    );

  beforeAll(async () => {
    db = abrirDb(URL_TESTE!);
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrar(db);
  });
  afterAll(async () => db?.end());
  beforeEach(async () => {
    seq = 0;
    await db.query("TRUNCATE contatos, mensagens, rascunhos, anexos RESTART IDENTITY CASCADE");
  });

  it("sobe o arquivo, prepara com anexo e só envia pelo #id, nunca pela autonomia", async () => {
    await receber({ conversation: "me manda a proposta?" });
    const enviadas: { destino: string; nome: string; legenda: string }[] = [];
    const avisos: string[] = [];
    const evolution = {
      enviarTexto: async () => "T1",
      enviarImagem: async () => null,
      enviarArquivo: async (destino: string, a: { nome: string; dados: Buffer }, legenda: string) => {
        enviadas.push({ destino, nome: a.nome, legenda });
        return "D1";
      },
      criarGrupo: async () => "",
      contatos: async () => [],
      grupos: async () => [],
      baixarMidia: async () => ({ buffer: Buffer.from(""), mimetype: "" }),
    };
    const app = criarServidor({
      webhookToken: "w".repeat(20),
      aoEvento: async () => {},
      mcp: { token: TOKEN, db, dono: "Lucas", fuso: "America/Sao_Paulo", envio: { evolution, avisar: async (x) => void avisos.push(x) } },
      arquivos: {
        token: TOKEN,
        baixar: async () => null,
        receber: async ({ dados, nome }) => ({ id: await repo.criarAnexo(db, { nome, mimetype: mimePeloNome(nome), dados }), nome, mimetype: mimePeloNome(nome) }),
      },
    });
    const sobe = (corpo: Buffer, nome?: string, token = TOKEN) =>
      app.inject({
        method: "POST",
        url: "/arquivo",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", ...(nome ? { "x-nome-arquivo": encodeURIComponent(nome) } : {}) },
        payload: corpo,
      });
    expect((await sobe(Buffer.from("%PDF"), "a.pdf", "errado")).statusCode).toBe(401);
    expect((await sobe(Buffer.from("%PDF"))).statusCode).toBe(400);
    const subiu = await sobe(Buffer.from("%PDF-1.4 proposta"), "Proposta Obra Ç.pdf");
    expect(subiu.json()).toEqual({ id: 1, nome: "Proposta Obra Ç.pdf", mimetype: "application/pdf" });

    const mcp = async (name: string, args: object) =>
      (
        await app.inject({
          method: "POST",
          url: "/mcp",
          headers: { authorization: `Bearer ${TOKEN}` },
          payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        })
      ).json().result.content[0].text as string;
    expect(await mcp("preparar_mensagem", { contato: CLIENTE, anexo: 99 })).toMatch(/Anexo 99 não existe/);
    expect(await mcp("preparar_mensagem", { contato: CLIENTE })).toMatch(/Falta o texto/);
    const prep = await mcp("preparar_mensagem", { contato: CLIENTE, texto: "Segue a proposta", anexo: 1 });
    expect(prep).toContain("📎 Proposta Obra Ç.pdf (1 KB)\nSegue a proposta");
    expect(avisos[0]).toContain("📎 Proposta Obra Ç.pdf");
    expect(enviadas).toHaveLength(0);

    // Autonomia não leva anexo, nem no nível mais alto.
    await db.query("UPDATE contatos SET autonomia = 3 WHERE jid = $1", [CLIENTE]);
    await db.query("UPDATE rascunhos SET risco = 'baixo' WHERE id = 1");
    expect(await repo.reservarEnvio(db, 1, { nivelMinimo: 3, padrao: 0, agendado: false, agora: new Date() })).toBeNull();

    expect(await mcp("enviar_rascunho", { id: 1 })).toBe("Enviado o #1.");
    expect(enviadas).toEqual([{ destino: CLIENTE, nome: "Proposta Obra Ç.pdf", legenda: "Segue a proposta" }]);
    const gravada = (await db.query("SELECT tipo, texto FROM mensagens WHERE id = 'D1'")).rows[0];
    expect(gravada).toEqual({ tipo: "documento", texto: "[arquivo: Proposta Obra Ç.pdf] Segue a proposta" });
    expect(await mcp("enviar_rascunho", { id: 1 })).toMatch(/não está aguardando/);
  });

  it("guarda a mídia sem miniatura, lista pelo MCP e esconde conversa tirada", async () => {
    await receber({ conversation: "bom dia" });
    await receber({ documentMessage: { fileName: "Proposta.pdf", mimetype: "application/pdf", mediaKey: "k1", JPEGThumbnail: "AAAA" } });
    await receber({ imageMessage: { caption: "laje", mimetype: "image/jpeg", mediaKey: "k2" } });

    const guardadas = (await db.query("SELECT tipo, midia FROM mensagens ORDER BY id")).rows;
    expect(guardadas.find((m) => m.tipo === "texto")?.midia).toBeNull();
    expect(guardadas.find((m) => m.tipo === "documento")?.midia).toEqual({ documentMessage: { fileName: "Proposta.pdf", mimetype: "application/pdf", mediaKey: "k1" } });

    const app = criarServidor({ webhookToken: "w".repeat(20), aoEvento: async () => {}, mcp: { token: TOKEN, db, dono: "Lucas", fuso: "America/Sao_Paulo" } });
    const chamar = async (args: object) =>
      (
        await app.inject({
          method: "POST",
          url: "/mcp",
          headers: { authorization: `Bearer ${TOKEN}` },
          payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "arquivos", arguments: args } },
        })
      ).json().result.content[0].text as string;

    const texto = await chamar({});
    expect(texto).toContain("Cliente · documento · Proposta.pdf → /arquivo/A2");
    expect(texto).toContain("imagem · imagem-A3.jpg");
    const json = JSON.parse(await chamar({ tipo: "documento", formato: "json" }));
    expect(json).toEqual([expect.objectContaining({ id: "A2", nome: "Proposta.pdf", mime: "application/pdf", jid: CLIENTE })]);
    expect((await repo.lerArquivo(db, "A2"))?.tipo).toBe("documento");
    expect(await repo.lerArquivo(db, "A1")).toBeNull();

    await repo.excluirChat(db, CLIENTE, true);
    expect(await chamar({})).toMatch(/Nenhum arquivo/);
    expect(await repo.lerArquivo(db, "A2")).toBeNull();
  });
});
