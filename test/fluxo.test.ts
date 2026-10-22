/**
 * O fluxo inteiro contra um Postgres de verdade, com Claude e WhatsApp falsos.
 * Precisa de DATABASE_URL_TESTE (um banco vazio, que o teste limpa). Sem ela, pula.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tique } from "../src/agenda.js";
import { criarFerramentas, tratarComando, type DepsControle } from "../src/controle.js";
import { abrirDb, migrar, type Db } from "../src/db.js";
import { extrairChat } from "../src/extracao.js";
import type { EntradaExtracao, Extracao, Ia } from "../src/ia.js";
import { ingerir } from "../src/ingestao.js";
import * as repo from "../src/repo.js";
import { dadosDoResumo } from "../src/resumo.js";
import type { Evolution } from "../src/whatsapp/evolution.js";

const URL_TESTE = process.env.DATABASE_URL_TESTE;
const DONO = "5551900000000@s.whatsapp.net";
const FERNANDA = "5551911111111@s.whatsapp.net";
const GRUPO = "120363000000@g.us";

let db: Db;
let seq = 0;

function msg(chat: string, texto: string, o: { deMim?: boolean; nome?: string; quando?: string; grupo?: boolean } = {}) {
  seq++;
  return {
    event: "Message",
    data: {
      Info: {
        ID: `M${seq}`,
        Chat: chat,
        Sender: o.deMim ? DONO : chat,
        PushName: o.nome ?? "Fernanda",
        IsFromMe: !!o.deMim,
        IsGroup: !!o.grupo,
        Timestamp: o.quando ?? new Date(Date.now() - 3600_000).toISOString(),
      },
      Message: { conversation: texto },
    },
  };
}

class IaFalsa implements Ia {
  extracoes: EntradaExtracao[] = [];
  resposta: Extracao = { compromissos: [], fatos: [], precisa_resposta: false };
  textos: string[] = [];
  async extrair(e: EntradaExtracao) {
    this.extracoes.push(e);
    return this.resposta;
  }
  async escrever(p: { conteudo: string }) {
    this.textos.push(p.conteudo);
    return "Oi Fê! Amanhã te mando o orçamento.";
  }
  async agente() {
    return "resposta do agente";
  }
}

class WhatsFalso implements Evolution {
  enviadas: { destino: string; texto: string }[] = [];
  falhar = false;
  async enviarTexto(destino: string, texto: string) {
    if (this.falhar) throw new Error("engine fora");
    this.enviadas.push({ destino, texto });
    return `E${this.enviadas.length}`;
  }
  async baixarMidia() {
    return { buffer: Buffer.from(""), mimetype: "audio/ogg" };
  }
}

describe.skipIf(!URL_TESTE)("fluxo com banco", () => {
  let ia: IaFalsa;
  let whats: WhatsFalso;
  let avisos: string[];
  let comandos: string[];
  let deps: DepsControle;

  const ing = (payload: unknown) =>
    ingerir(payload, {
      db,
      jidsDoDono: new Set([DONO]),
      aoComando: async (t) => {
        comandos.push(t);
      },
    });

  beforeAll(async () => {
    db = abrirDb(URL_TESTE!);
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrar(db);
  });
  afterAll(async () => db?.end());

  beforeEach(async () => {
    await db.query("TRUNCATE contatos, mensagens, compromissos, rascunhos, enviadas, estado RESTART IDENTITY CASCADE");
    ia = new IaFalsa();
    whats = new WhatsFalso();
    avisos = [];
    comandos = [];
    deps = { db, ia, evolution: whats, dono: "Lucas", fuso: "America/Sao_Paulo", avisar: async (t) => void avisos.push(t) };
  });

  it("grava a conversa, ignora repetição e separa o canal de controle", async () => {
    const m = msg(FERNANDA, "Lucas, consegue me mandar o orçamento?");
    expect(await ing(m)).toBe("gravado");
    expect(await ing(m)).toBe("repetido");
    expect((await repo.lerContato(db, FERNANDA))?.nome_push).toBe("Fernanda");

    expect(await ing(msg(DONO, "resumo", { deMim: true }))).toBe("comando");
    expect(comandos).toEqual(["resumo"]);
    expect((await db.query("SELECT count(*)::int AS n FROM mensagens")).rows[0].n).toBe(1);
  });

  it("a própria resposta do assistente não vira comando (sem laço)", async () => {
    const eco = msg(DONO, "🤖 Bom dia!", { deMim: true });
    await repo.registrarEnviada(db, eco.data.Info.ID);
    expect(await ing(eco)).toBe("ignorado");
    expect(comandos).toEqual([]);
  });

  it("chat excluído não grava nada, e excluir apaga o que havia", async () => {
    await ing(msg(GRUPO, "bom dia grupo", { grupo: true, nome: "Tia" }));
    await tratarComando(deps, `fora ${GRUPO.split("@")[0]}`);
    expect(avisos.at(-1)).toMatch(/saiu do assistente/);
    expect((await db.query("SELECT count(*)::int AS n FROM mensagens")).rows[0].n).toBe(0);
    expect(await ing(msg(GRUPO, "alguém aí?", { grupo: true }))).toBe("excluido");

    await tratarComando(deps, `volta ${GRUPO.split("@")[0]}`);
    expect(await ing(msg(GRUPO, "voltei", { grupo: true }))).toBe("gravado");
  });

  it("extração cria compromissos, guarda fatos e avisa só o que é próximo e do dono", async () => {
    await ing(msg(FERNANDA, "Me manda o orçamento até amanhã?", { quando: new Date(Date.now() - 600_000).toISOString() }));
    await ing(msg(FERNANDA, "Meu marido Ricardo também quer ver", { quando: new Date(Date.now() - 500_000).toISOString() }));
    const amanha = new Date(Date.now() + 20 * 3600_000).toISOString();
    ia.resposta = {
      compromissos: [
        { descricao: "mandar o orçamento da cozinha", quando: amanha, responsavel: "eu" },
        { descricao: "Fernanda passar as medidas", quando: amanha, responsavel: "contato" },
        { descricao: "ver a cor da bancada", quando: null, responsavel: "eu" },
      ],
      fatos: ["marido se chama Ricardo"],
      precisa_resposta: true,
    };

    await extrairChat({ ...deps, quietoMin: 0 }, FERNANDA);
    expect(ia.extracoes[0].novas).toMatch(/Fernanda: Me manda o orçamento/);
    expect((await repo.compromissosAbertos(db)).length).toBe(3);
    expect((await repo.lerContato(db, FERNANDA))?.memoria).toBe("- marido se chama Ricardo");
    // Só o compromisso do dono com data próxima vira aviso na hora.
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatch(/mandar o orçamento da cozinha/);
    expect(avisos[0]).not.toMatch(/medidas/);

    // Rodar de novo não repete nada: o trecho já foi lido.
    await extrairChat({ ...deps, quietoMin: 0 }, FERNANDA);
    expect(ia.extracoes).toHaveLength(1);
  });

  it("resumo lista agenda, promessa sem data e quem espera resposta", async () => {
    await ing(msg(FERNANDA, "E aí, conseguiu ver?", { quando: new Date(Date.now() - 6 * 3600_000).toISOString() }));
    await repo.criarCompromisso(db, { chatJid: FERNANDA, descricao: "ligar para a marmoraria", quando: new Date(Date.now() + 3600_000), responsavel: "eu" });
    await repo.criarCompromisso(db, { chatJid: FERNANDA, descricao: "mandar fotos da obra", quando: null, responsavel: "eu" });
    const texto = await dadosDoResumo(deps);
    expect(texto).toMatch(/Agenda[\s\S]*ligar para a marmoraria/);
    expect(texto).toMatch(/Promessas sem data[\s\S]*mandar fotos da obra/);
    expect(texto).toMatch(/Esperando resposta sua[\s\S]*Fernanda/);
  });

  it("rascunho: sai só com ok, uma vez, e volta para aguardando se o envio falhar", async () => {
    await ing(msg(FERNANDA, "Consegue mandar amanhã?"));
    await ing(msg(FERNANDA, "beleza, valeu!", { deMim: true }));
    const ferramentas = criarFerramentas(deps);
    const propor = ferramentas.find((f) => f.name === "propor_resposta")!;
    await propor.run({ jid: FERNANDA, instrucao: "diz que amanhã eu mando" } as any);

    // O pedido levou exemplos de como o dono escreve.
    expect(ia.textos[0]).toMatch(/EXEMPLOS[\s\S]*beleza, valeu!/);
    expect(avisos.at(-1)).toMatch(/Rascunho #1 para \*Fernanda\*/);
    expect(whats.enviadas).toHaveLength(0);

    whats.falhar = true;
    await tratarComando(deps, "ok 1");
    expect((await repo.lerRascunho(db, 1))?.status).toBe("aguardando");

    whats.falhar = false;
    await tratarComando(deps, "ok");
    await tratarComando(deps, "ok 1");
    expect(whats.enviadas).toEqual([{ destino: FERNANDA, texto: "Oi Fê! Amanhã te mando o orçamento." }]);
    expect((await repo.lerRascunho(db, 1))?.status).toBe("enviado");
  });

  it("rascunho com [preencher] não sai", async () => {
    await ing(msg(FERNANDA, "Qual o valor?"));
    const id = await repo.criarRascunho(db, FERNANDA, "O valor fica [preencher: valor].", "responder valor");
    await tratarComando(deps, `ok ${id}`);
    expect(whats.enviadas).toHaveLength(0);
    expect(avisos.at(-1)).toMatch(/preencher/);
  });

  it("agenda manda o resumo uma vez por dia, no horário do fuso", async () => {
    let resumos = 0;
    const tarefas = { extrair: async () => 0, resumo: async () => void resumos++, limpar: async () => 0 };
    const base = { db, fuso: "America/Sao_Paulo", resumoHora: "07:30", tarefas, log: () => {} };
    await tique({ ...base, agora: new Date("2026-10-22T10:00:00Z") }); // 07:00 em SP
    expect(resumos).toBe(0);
    await tique({ ...base, agora: new Date("2026-10-22T10:31:00Z") }); // 07:31
    await tique({ ...base, agora: new Date("2026-10-22T13:00:00Z") }); // 10:00, mesmo dia
    expect(resumos).toBe(1);
    await tique({ ...base, agora: new Date("2026-10-23T10:45:00Z") }); // dia seguinte
    expect(resumos).toBe(2);
  });

  it("busca por palavra e por contato", async () => {
    await ing(msg(FERNANDA, "O orçamento da marcenaria ficou ótimo"));
    expect((await repo.buscarMensagens(db, "marcenaria"))[0].contato).toBe("Fernanda");
    expect((await repo.buscarContatos(db, "fern"))[0].jid).toBe(FERNANDA);
  });
});
