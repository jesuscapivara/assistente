/**
 * O fluxo inteiro contra um Postgres de verdade, com Claude e WhatsApp falsos.
 * Precisa de DATABASE_URL_TESTE (um banco vazio, que o teste limpa). Sem ela, pula.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tique } from "../src/agenda.js";
import { aprenderComCorrecoes, conhecerContato } from "../src/conhecer.js";
import { criarFerramentas, tratarComando, type DepsControle } from "../src/controle.js";
import { abrirDb, gravarEstado, migrar, type Db } from "../src/db.js";
import { extrairChat } from "../src/extracao.js";
import type { EntradaExtracao, Extracao, Ia } from "../src/ia.js";
import { ingerir, ingerirHistorico } from "../src/ingestao.js";
import * as repo from "../src/repo.js";
import { gravarPauta } from "../src/pauta.js";
import { montarResumo } from "../src/resumo.js";
import type { Evolution } from "../src/whatsapp/evolution.js";

const URL_TESTE = process.env.DATABASE_URL_TESTE;
const DONO = "5551900000000@s.whatsapp.net";
const FERNANDA = "5551911111111@s.whatsapp.net";
const GRUPO = "120363000000@g.us";
const JOAO = "5551922222222@s.whatsapp.net";

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
  resposta: Extracao = { compromissos: [], fatos: [], precisa_resposta: false, urgente: false, motivo_urgencia: "", aguardando: null, situacao: "", automatica: false };
  textos: string[] = [];
  sistemas: string[] = [];
  estruturados: unknown[] = [];
  pedidosEstruturados: string[] = [];
  async estruturar(_schema: unknown, p: { conteudo: string }) {
    this.pedidosEstruturados.push(p.conteudo);
    return (this.estruturados.shift() ?? null) as any;
  }
  async extrair(e: EntradaExtracao) {
    this.extracoes.push(e);
    return this.resposta;
  }
  async escrever(p: { conteudo: string; sistema: string }) {
    this.textos.push(p.conteudo);
    this.sistemas.push(p.sistema);
    return "Oi Fê! Amanhã te mando o orçamento.";
  }
  agentes: string[] = [];
  async agente(p: { conteudo: string }) {
    this.agentes.push(p.conteudo);
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
  async enviarImagem(destino: string, url: string, legenda: string) {
    this.enviadas.push({ destino, texto: `[imagem ${url}] ${legenda}` });
    return `I${this.enviadas.length}`;
  }
  async contatos() {
    return [];
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
    await db.query("TRUNCATE contatos, mensagens, compromissos, rascunhos, enviadas, estado, apelidos, perfil, dialogo, consumo RESTART IDENTITY CASCADE");
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
        { descricao: "mandar o orçamento da cozinha", quando: amanha, quem_faz: "dono" },
        { descricao: "Fernanda passar as medidas", quando: amanha, quem_faz: "contato" },
        { descricao: "ver a cor da bancada", quando: null, quem_faz: "dono" },
      ],
      fatos: ["marido se chama Ricardo"],
      precisa_resposta: true,
      urgente: false,
      motivo_urgencia: "",
      aguardando: null,
      situacao: "Ela pediu o orçamento até amanhã.",
      automatica: false,
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
    // Quem espera é quem a leitura da conversa disse que espera, com a situação junto.
    await repo.atualizarConversa(db, FERNANDA, { situacao: "Ela perguntou se você viu o orçamento.", esperaResposta: true });
    const { texto, refs } = await montarResumo(deps);
    expect(texto).toMatch(/Compromissos[\s\S]*ligar para a marmoraria/);
    expect(texto).toMatch(/Promessas sem data[\s\S]*mandar fotos da obra/);
    expect(texto).toMatch(/Esperando resposta sua[\s\S]*Fernanda[\s\S]*perguntou se você viu o orçamento/);
    expect(refs).toMatch(new RegExp(`Fernanda = ${FERNANDA}`));

    // Respondeu pelo celular: sai da lista na hora.
    await ing(msg(FERNANDA, "vi sim, te mando hoje", { deMim: true }));
    expect((await montarResumo(deps)).texto).not.toMatch(/Esperando resposta sua/);
  });

  it("'tá ok' e figurinha não chamam o Claude e encerram a espera", async () => {
    await ing(msg(FERNANDA, "Pode ser sábado?", { quando: new Date(Date.now() - 600_000).toISOString() }));
    ia.resposta = { ...ia.resposta, precisa_resposta: true, situacao: "Ela perguntou se pode ser sábado." };
    await extrairChat({ ...deps, quietoMin: 0 }, FERNANDA);
    expect((await repo.lerContato(db, FERNANDA))?.espera_resposta).toBe(true);

    await ing(msg(FERNANDA, "Tá ok 👍", { quando: new Date(Date.now() - 300_000).toISOString() }));
    await extrairChat({ ...deps, quietoMin: 0 }, FERNANDA);
    expect(ia.extracoes).toHaveLength(1);
    expect((await repo.lerContato(db, FERNANDA))?.espera_resposta).toBe(false);
  });

  it("grupo só é lido quando envolve o dono; robô não espera resposta", async () => {
    await ing(msg(GRUPO, "alguém viu a chave do carro?", { grupo: true, quando: new Date(Date.now() - 600_000).toISOString() }));
    await extrairChat({ ...deps, quietoMin: 0, mencoes: ["Lucas"] }, GRUPO);
    expect(ia.extracoes).toHaveLength(0);
    await ing(msg(GRUPO, "Lucas, consegue amanhã?", { grupo: true, quando: new Date(Date.now() - 500_000).toISOString() }));
    await extrairChat({ ...deps, quietoMin: 0, mencoes: ["Lucas"] }, GRUPO);
    expect(ia.extracoes).toHaveLength(1);

    await ing(msg(JOAO, "Seu código de acesso é 123. Confirma?", { quando: new Date(Date.now() - 600_000).toISOString() }));
    ia.resposta = { ...ia.resposta, precisa_resposta: true, automatica: true, situacao: "" };
    await extrairChat({ ...deps, quietoMin: 0 }, JOAO);
    expect(await repo.lerContato(db, JOAO)).toMatchObject({ sistema: true, espera_resposta: false });
  });

  it("errado N corrige o compromisso e a lição vai nas próximas leituras", async () => {
    await ing(msg(FERNANDA, "não terminei de ler, vou ler hoje", { quando: new Date(Date.now() - 600_000).toISOString() }));
    const id = (await repo.criarCompromisso(db, { chatJid: FERNANDA, descricao: "ler o projeto", quando: null, responsavel: "eu" }))!;
    ia.estruturados.push({
      compromisso: { acao: "corrigir", descricao: "Fernanda ler o projeto que você mandou", quem_faz: "contato" },
      conversa: null,
      licao: "Quem escreve 'vou ler' é quem lê, mesmo que o arquivo tenha vindo do dono.",
    });
    await tratarComando(deps, `errado ${id} quem vai ler é ela`);
    expect(ia.pedidosEstruturados.at(-1)).toMatch(/CORREÇÃO DE LUCAS: quem vai ler é ela[\s\S]*vou ler hoje/);
    expect((await repo.compromissosAbertos(db)).find((k) => k.id === id)).toMatchObject({ responsavel: "contato", descricao: "Fernanda ler o projeto que você mandou" });
    expect(avisos.at(-1)).toMatch(/agora é de Fernanda[\s\S]*Aprendi \(#\d+\): Quem escreve 'vou ler'/);

    await ing(msg(FERNANDA, "Pode ser sábado?", { quando: new Date(Date.now() - 300_000).toISOString() }));
    await extrairChat({ ...deps, quietoMin: 0 }, FERNANDA);
    expect(ia.extracoes.at(-1)?.licoes).toMatch(/Quem escreve 'vou ler' é quem lê/);
  });

  it("pelas letras do resumo: resolvi, adia (e volta se escrever), ignora e responde", async () => {
    await ing(msg(FERNANDA, "Me liga quando puder?", { quando: new Date(Date.now() - 5 * 86400_000).toISOString() }));
    await repo.atualizarConversa(db, FERNANDA, { situacao: "Ela pediu que você ligue.", esperaResposta: true });
    const id = (await repo.criarCompromisso(db, { chatJid: FERNANDA, descricao: "mandar a planta", quando: new Date(Date.now() + 3600_000), responsavel: "eu" }))!;
    const { pauta } = await montarResumo(deps);
    await gravarPauta(db, [...pauta, { letra: "B", tipo: "compromisso", titulo: "mandar a planta", compromissoId: id, jid: FERNANDA }]);
    expect(pauta[0]).toMatchObject({ letra: "A", jid: FERNANDA });
    const esperando = async () => (await repo.esperandoResposta(db, 0)).map((e) => e.jid);

    await tratarComando(deps, "adia A sábado");
    expect(avisos.at(-1)).toMatch(/Fernanda volta no resumo de \d\d\/\d\d/);
    expect(await esperando()).toEqual([]);
    // Escreveu de novo antes do sábado: volta na hora.
    await ing(msg(FERNANDA, "Oi, conseguiu ver?", { quando: new Date(Date.now() - 60_000).toISOString() }));
    expect(await esperando()).toEqual([FERNANDA]);

    await tratarComando(deps, "resolvi A");
    expect(await esperando()).toEqual([]);
    await tratarComando(deps, "feito B");
    expect((await repo.compromissosAbertos(db)).find((k) => k.id === id)).toBeUndefined();

    await repo.atualizarConversa(db, FERNANDA, { situacao: "Ela mandou um meme.", esperaResposta: true });
    ia.estruturados.push({ compromisso: null, conversa: { situacao: "Ela mandou um meme.", espera_resposta: false, sistema: false }, licao: "Meme não pede resposta." });
    await tratarComando(deps, "ignora A");
    expect(await esperando()).toEqual([]);
    expect(avisos.at(-1)).toMatch(/saiu da lista[\s\S]*Aprendi \(#\d+\): Meme não pede resposta/);

    await tratarComando(deps, "responde A diz que ligo amanhã cedo");
    expect(ia.textos.at(-1)).toMatch(/PEDIDO de Lucas: diz que ligo amanhã cedo/);
    expect(avisos.at(-1)).toMatch(/Rascunho #\d+ para \*Fernanda\*/);

    await tratarComando(deps, "resolvi Z");
    expect(avisos.at(-1)).toMatch(/Não há item Z no último resumo \(A, B\)/);
  });

  it("o pedido livre leva o diálogo recente e o caderno", async () => {
    await repo.registrarFala(db, "assistente", "Posso refazer o resumo com os nomes. Quer?");
    await gravarEstado(db, "caderno", "- propus refazer o resumo com nomes");
    await repo.registrarFala(db, "dono", "Sim");
    await tratarComando(deps, "Sim");
    const conteudo = ia.agentes[0];
    expect(conteudo).toMatch(/CADERNO[\s\S]*propus refazer o resumo/);
    expect(conteudo).toMatch(/CONVERSA RECENTE[\s\S]*Posso refazer o resumo com os nomes/);
    // O "Sim" de agora vai como pedido, não repetido no diálogo.
    expect(conteudo.match(/Lucas: Sim/g) ?? []).toHaveLength(0);
    expect(conteudo).toMatch(/PEDIDO AGORA:\nSim$/);
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

  it("agenda: diária uma vez por dia no fuso, e semanal só no dia certo", async () => {
    let resumos = 0;
    let semanais = 0;
    const diarias = [
      { chave: "resumo", hora: "07:30", rodar: async () => void resumos++ },
      { chave: "semanal", hora: "18:30", diaDaSemana: 0, rodar: async () => void semanais++ },
    ];
    const base = { db, fuso: "America/Sao_Paulo", diarias, log: () => {} };
    await tique({ ...base, agora: new Date("2026-10-22T10:00:00Z") }); // qui 07:00 em SP
    expect(resumos).toBe(0);
    await tique({ ...base, agora: new Date("2026-10-22T10:31:00Z") }); // 07:31
    await tique({ ...base, agora: new Date("2026-10-22T13:00:00Z") }); // 10:00, mesmo dia
    expect(resumos).toBe(1);
    await tique({ ...base, agora: new Date("2026-10-23T10:45:00Z") }); // sexta
    expect(resumos).toBe(2);
    await tique({ ...base, agora: new Date("2026-10-23T22:00:00Z") }); // sexta 19h: não é domingo
    expect(semanais).toBe(0);
    await tique({ ...base, agora: new Date("2026-10-25T21:40:00Z") }); // domingo 18:40
    await tique({ ...base, agora: new Date("2026-10-25T22:40:00Z") });
    expect(semanais).toBe(1);
  });

  it("busca por palavra e por contato", async () => {
    await ing(msg(FERNANDA, "O orçamento da marcenaria ficou ótimo"));
    expect((await repo.buscarMensagens(db, "marcenaria"))[0].contato).toBe("Fernanda");
    expect((await repo.buscarContatos(db, "fern"))[0].jid).toBe(FERNANDA);
  });

  it("número e LID viram uma pessoa só, com as mensagens juntas", async () => {
    const LID = "987654@lid";
    const viaLid = msg(LID, "oi, é a Fernanda");
    await ing(viaLid);
    await repo.lembrar(db, LID, ["arquiteta"]);
    expect((await repo.lerContato(db, LID))?.jid).toBe(LID);

    // Chega uma mensagem com o número no SenderAlt: junta tudo no número.
    const comAlt = msg(LID, "segue o projeto");
    (comAlt.data.Info as any).SenderAlt = FERNANDA;
    await ing(comAlt);
    expect(await repo.lerContato(db, LID)).toBeNull();
    const f = await repo.lerContato(db, FERNANDA);
    expect(f?.memoria).toMatch(/arquiteta/);
    const n = (await db.query("SELECT count(*)::int AS n FROM mensagens WHERE chat_jid = $1", [FERNANDA])).rows[0].n;
    expect(n).toBe(2);

    // Daí em diante, o LID sozinho já cai no número.
    await ing(msg(LID, "e aí?"));
    expect((await db.query("SELECT count(*)::int AS n FROM mensagens WHERE chat_jid = $1", [FERNANDA])).rows[0].n).toBe(3);
  });

  it("histórico grava em lote, com nome, sem virar extração nem gravar o chat do dono", async () => {
    await ing(msg(GRUPO, "x", { grupo: true }));
    await tratarComando(deps, `fora ${GRUPO.split("@")[0]}`);
    const payload = {
      event: "HistorySync",
      data: {
        Data: {
          conversations: [
            {
              id: FERNANDA,
              name: "Fernanda Moraes",
              messages: [
                { message: { key: { fromMe: false, ID: "H1" }, message: { conversation: "Oi Lucas" }, messageTimestamp: 1760000000 } },
                { message: { key: { fromMe: true, ID: "H2" }, message: { conversation: "Oi Fê!" }, messageTimestamp: 1760000060 } },
              ],
            },
            { id: DONO, messages: [{ message: { key: { fromMe: true, ID: "H3" }, message: { conversation: "nota" }, messageTimestamp: 1760000100 } }] },
            { id: GRUPO, messages: [{ message: { key: { fromMe: false, ID: "H4" }, message: { conversation: "grupo" }, messageTimestamp: 1760000200 } }] },
          ],
        },
      },
    };
    let estudos = 0;
    const r = await ingerir(payload, { db, jidsDoDono: new Set([DONO]), aoComando: async () => {}, aoHistorico: async () => void estudos++ });
    expect(r).toBe("historico");
    expect(estudos).toBe(1);
    const linhasDb = (await db.query("SELECT id, extraida FROM mensagens ORDER BY id")).rows;
    expect(linhasDb).toEqual([
      { id: "H1", extraida: true },
      { id: "H2", extraida: true },
    ]);
    expect((await repo.lerContato(db, FERNANDA))?.nome_push).toBe("Fernanda Moraes");
    expect(await repo.chatsParaExtrair(db, 0)).toEqual([]);
    // Repetir o mesmo histórico não duplica.
    expect(await ingerirHistorico(payload, { db, jidsDoDono: new Set([DONO]) })).toBe(0);
  });

  it("ficha da pessoa sai da conversa e entra no rascunho", async () => {
    await ing(msg(FERNANDA, "Lucas, aprovamos o layout B!"));
    ia.estruturados.push({
      relacao: "cliente",
      resumo: "Cliente do apartamento Bela Vista",
      tom: "Cordial, sem gíria, chama de Fê",
      assuntos_abertos: "orçamento da marcenaria",
      fatos: ["mora em Porto Alegre"],
    });
    expect(await conhecerContato(deps, FERNANDA)).toBe(true);
    const f = await repo.lerContato(db, FERNANDA);
    expect(f).toMatchObject({ relacao: "cliente", tom: "Cordial, sem gíria, chama de Fê", assuntos_abertos: "orçamento da marcenaria" });
    expect(f?.memoria).toMatch(/Porto Alegre/);
    expect((await repo.contatosParaConhecer(db, 10, 1))).toEqual([]);

    await tratarComando(deps, "regra: nunca prometo prazo por mensagem");
    await criarFerramentas(deps).find((t) => t.name === "propor_resposta")!.run({ jid: FERNANDA, instrucao: "agradece" } as any);
    expect(ia.textos.at(-1)).toMatch(/FICHA de Fernanda[\s\S]*Relação: cliente[\s\S]*chama de Fê/);
    expect(ia.sistemas.at(-1)).toMatch(/Regras que ele mesmo deu[\s\S]*nunca prometo prazo por mensagem/);
  });

  it("aprende com a resposta que o dono escreveu no lugar do rascunho, e com os ajustes", async () => {
    await ing(msg(FERNANDA, "Pode ser quinta?"));
    const antigo = new Date(Date.now() - 3 * 3600_000);
    // Rascunho descartado, e o dono escreveu a dele à mão logo depois.
    const r1 = await repo.criarRascunho(db, FERNANDA, "Olá Fernanda! Quinta-feira está ótimo para mim. Abraços!", "aceitar quinta");
    await repo.decidirRascunho(db, r1, "descartado");
    await db.query("UPDATE rascunhos SET criado_em = $2 WHERE id = $1", [r1, antigo]);
    await ing(msg(FERNANDA, "fechado, quinta 👍", { deMim: true, quando: new Date(antigo.getTime() + 10 * 60_000).toISOString() }));
    // Rascunho enviado depois de um ajuste.
    const r2 = await repo.criarRascunho(db, FERNANDA, "ok", "confirmar\nAjuste: sem 'abraços' no fim");
    await repo.decidirRascunho(db, r2, "enviado");
    await db.query("UPDATE rascunhos SET criado_em = $2 WHERE id = $1", [r2, antigo]);

    ia.estruturados.push({ licoes: ["Mensagens curtas, sem saudação formal"] }, { licoes: ["Não termina com 'abraços'"] });
    expect(await aprenderComCorrecoes(deps)).toBe(2);
    expect(ia.pedidosEstruturados[0]).toMatch(/O QUE ELE MANDOU NO LUGAR:\nfechado, quinta/);
    expect(ia.pedidosEstruturados[1]).toMatch(/AJUSTES QUE ELE PEDIU:\n- sem 'abraços'/);
    const p = await repo.lerPerfil(db);
    expect(p.licoes.map((l) => l.texto)).toEqual(["Mensagens curtas, sem saudação formal", "Não termina com 'abraços'"]);
    // Não reaprende o mesmo rascunho.
    expect(await aprenderComCorrecoes(deps)).toBe(0);

    await tratarComando(deps, `esquece ${p.licoes[0].id}`);
    expect((await repo.lerPerfil(db)).licoes).toHaveLength(1);
  });

  it("o ok guarda o id da mensagem enviada (o que separa o rascunho do que o dono escreveu)", async () => {
    await ing(msg(FERNANDA, "oi"));
    const id = await repo.criarRascunho(db, FERNANDA, "oi Fê", "cumprimentar");
    await tratarComando(deps, `ok ${id}`);
    expect((await db.query("SELECT mensagem_id FROM rascunhos WHERE id = $1", [id])).rows[0].mensagem_id).toBe("E1");
  });
});
