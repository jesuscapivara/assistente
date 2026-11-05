/**
 * Fases 2 a 5 contra um Postgres de verdade (DATABASE_URL_TESTE), com Claude, WhatsApp
 * e Google falsos: cobrança, urgência, autonomia, agenda, briefing, revisão e painel.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { enviarAgendados, responderSozinho, type DepsAutonomia } from "../src/autonomia.js";
import { criarFerramentas, executarEnvio, tratarComando, type DepsControle } from "../src/controle.js";
import { abrirDb, migrar, type Db } from "../src/db.js";
import { extrairChat } from "../src/extracao.js";
import type { Evento, Google } from "../src/google.js";
import type { EntradaExtracao, Extracao, Ia } from "../src/ia.js";
import { ingerir } from "../src/ingestao.js";
import { paginaDoPainel } from "../src/painel.js";
import { briefings, cobrancas, fimDoDia, lembretesNaHora, radar, revisaoSemanal } from "../src/proativo.js";
import * as repo from "../src/repo.js";
import { montarResumo } from "../src/resumo.js";
import { criarServidor } from "../src/server.js";
import type { Evolution } from "../src/whatsapp/evolution.js";

const URL_TESTE = process.env.DATABASE_URL_TESTE;
const DONO = "5551900000000@s.whatsapp.net";
const FERNANDA = "5551911111111@s.whatsapp.net";
const JOAO = "5551922222222@s.whatsapp.net";
const GRUPO = "120363000000@g.us";
const SP = "America/Sao_Paulo";

let db: Db;
let seq = 0;

function msg(chat: string, texto: string, o: { deMim?: boolean; nome?: string; quando?: Date } = {}) {
  seq++;
  return {
    event: "Message",
    data: {
      Info: {
        ID: `P${seq}`,
        Chat: chat,
        PushName: o.nome ?? (chat === JOAO ? "João" : "Fernanda"),
        IsFromMe: !!o.deMim,
        IsGroup: chat.endsWith("@g.us"),
        Timestamp: (o.quando ?? new Date(Date.now() - 3600_000)).toISOString(),
      },
      Message: { conversation: texto },
    },
  };
}

const vazio: Extracao = { compromissos: [], fatos: [], precisa_resposta: false, reacao: false, urgente: false, motivo_urgencia: "", aguardando: null, situacao: "", automatica: false, sugestoes: [] };

class IaFalsa implements Ia {
  extracao: Extracao = vazio;
  rascunho = "Combinado, quinta às 15h então!";
  risco: { risco: "baixo" | "alto"; motivo: string; sem_resposta?: string[] } = { risco: "baixo", motivo: "resposta simples" };
  escritos: { sistema: string; conteudo: string }[] = [];
  async extrair(_e: EntradaExtracao) {
    return this.extracao;
  }
  async escrever(p: { sistema: string; conteudo: string }) {
    this.escritos.push(p);
    // O rascunho e os textos de resumo passam por aqui; o rascunho tem PEDIDO.
    return p.conteudo.includes("PEDIDO de") ? this.rascunho : `resumo: ${p.conteudo.length} caracteres`;
  }
  async agente() {
    return "";
  }
  async verImagem() {
    return "";
  }
  async estruturar() {
    return this.risco as any;
  }
}

class WhatsFalso implements Evolution {
  enviadas: { destino: string; texto: string }[] = [];
  async enviarTexto(destino: string, texto: string) {
    this.enviadas.push({ destino, texto });
    return `W${this.enviadas.length}`;
  }
  async enviarImagem(destino: string, url: string, legenda: string) {
    this.enviadas.push({ destino, texto: `[imagem ${url}] ${legenda}` });
    return `I${this.enviadas.length}`;
  }
  async enviarArquivo(destino: string, a: { nome: string }, legenda: string) {
    this.enviadas.push({ destino, texto: `[arquivo ${a.nome}] ${legenda}` });
    return `D${this.enviadas.length}`;
  }
  async criarGrupo(nome: string, participantes: string[]) {
    this.enviadas.push({ destino: participantes.join(","), texto: `[grupo ${nome}]` });
    return "120363000000000001@g.us";
  }
  async contatos() {
    return [];
  }
  async grupos() {
    return [];
  }
  async baixarMidia() {
    return { buffer: Buffer.from(""), mimetype: "audio/ogg" };
  }
}

class GoogleFalso implements Google {
  evs: Evento[] = [];
  criados: { titulo: string; inicio: Date }[] = [];
  async eventos(de: Date, ate: Date) {
    return this.evs.filter((e) => e.inicio < ate && e.fim > de);
  }
  async ocupado() {
    return [];
  }
  async criarEvento(e: { titulo: string; inicio: Date }) {
    this.criados.push(e);
    return `ev${this.criados.length}`;
  }
  async emails() {
    return [];
  }
  async email(): Promise<any> {
    return {};
  }
  async convidar(): Promise<any> {
    return {};
  }
  async enviarEmail() {
    return "s";
  }
  async rascunhoEmail() {
    return "d";
  }
}

describe.skipIf(!URL_TESTE)("fases 2 a 5 com banco", () => {
  let ia: IaFalsa;
  let whats: WhatsFalso;
  let google: GoogleFalso;
  let avisos: string[];
  let deps: DepsControle;
  let auto: DepsAutonomia;
  let agora: Date;

  const ing = (p: unknown) => ingerir(p, { db, jidsDoDono: new Set([DONO]), aoComando: async () => {} });

  beforeAll(async () => {
    db = abrirDb(URL_TESTE!);
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrar(db);
  });
  afterAll(async () => db?.end());

  beforeEach(async () => {
    await db.query(
      "TRUNCATE contatos, mensagens, compromissos, rascunhos, enviadas, estado, apelidos, perfil, datas, alertas, dialogo, consumo RESTART IDENTITY CASCADE",
    );
    ia = new IaFalsa();
    whats = new WhatsFalso();
    google = new GoogleFalso();
    avisos = [];
    // Quinta, 22/10/2026, 11h em São Paulo: horário em que mensagem automática pode sair.
    agora = new Date("2026-10-22T14:00:00Z");
    deps = {
      db,
      ia,
      evolution: whats,
      dono: "Lucas",
      fuso: SP,
      avisar: async (t) => void avisos.push(t),
      google,
      sincronizarAgenda: true,
    };
    auto = { db, ia, evolution: whats, dono: "Lucas", fuso: SP, avisar: deps.avisar, padrao: 0, janelaMin: 10, agora: () => agora };
  });

  it("extração: o que o dono espera do contato, urgência uma vez só, e chama a autonomia", async () => {
    await ing(msg(FERNANDA, "Te mando as medidas da cozinha amanhã. Urgente: vazou água na obra!", { quando: new Date(Date.now() - 600_000) }));
    ia.extracao = { ...vazio, urgente: true, motivo_urgencia: "vazamento na obra", aguardando: "as medidas da cozinha", precisa_resposta: true };
    const pediram: string[] = [];
    await extrairChat({ ...deps, quietoMin: 0, aoPrecisarResposta: async (j) => void pediram.push(j) }, FERNANDA);
    const f = await repo.lerContato(db, FERNANDA);
    expect(f?.aguardando).toBe("as medidas da cozinha");
    expect(avisos.filter((a) => a.startsWith("⚡"))).toHaveLength(1);
    expect(avisos[0]).toMatch(/Fernanda.*vazamento na obra/);
    expect(pediram).toEqual([FERNANDA]);

    // Ela entregou: a próxima extração limpa o "aguardando".
    await ing(msg(FERNANDA, "segue as medidas", { quando: new Date(Date.now() - 300_000) }));
    ia.extracao = { ...vazio, aguardando: null };
    await extrairChat({ ...deps, quietoMin: 0 }, FERNANDA);
    expect((await repo.lerContato(db, FERNANDA))?.aguardando).toBe("");
  });

  it("foto compartilhada pede reação: chama a autonomia, mas não entra nas pendências", async () => {
    await ing(msg(FERNANDA, "olha o boné novo da empresa", { quando: new Date(Date.now() - 600_000) }));
    ia.extracao = { ...vazio, reacao: true, situacao: "Mandou a foto do boné novo da empresa." };
    const pediram: string[] = [];
    await extrairChat({ ...deps, quietoMin: 0, aoPrecisarResposta: async (j) => void pediram.push(j) }, FERNANDA);
    expect(pediram).toEqual([FERNANDA]);
    expect((await repo.lerContato(db, FERNANDA))?.espera_resposta).toBe(false);
  });

  it("cobrança: pergunta uma vez por assunto, e 'cobra' propõe o rascunho", async () => {
    await ing(msg(JOAO, "te mando o projeto elétrico"));
    await repo.atualizarAguardando(db, JOAO, "o projeto elétrico");
    await db.query("UPDATE contatos SET aguardando_desde = now() - interval '5 days' WHERE jid = $1", [JOAO]);
    expect(await cobrancas(deps, 3)).toBe(1);
    expect(avisos.at(-1)).toMatch(/João\* ficou de mandar o projeto elétrico \(há 5 dias\)/);
    expect(await cobrancas(deps, 3)).toBe(0);

    await tratarComando(deps, "cobra João");
    expect(ia.escritos.at(-1)!.conteudo).toMatch(/PEDIDO de Lucas: Cobrar com educação[\s\S]*projeto elétrico/);
    expect(avisos.at(-1)).toMatch(/Rascunho #1 para \*João\*/);
    expect(await repo.paraCobrar(db, 3)).toEqual([]);
  });

  it("autonomia 0 não faz nada; 1 propõe e espera ok", async () => {
    await ing(msg(FERNANDA, "Pode ser quinta às 15h?"));
    expect(await responderSozinho(auto, FERNANDA)).toBe("nada");
    await repo.definirAutonomia(db, FERNANDA, 1);
    expect(await responderSozinho(auto, FERNANDA)).toBe("proposto");
    expect(avisos.at(-1)).toMatch(/Fernanda espera resposta[\s\S]*Rascunho #1/);
    expect(whats.enviadas).toHaveLength(0);
    // Já tem rascunho aberto: não propõe outro.
    expect(await responderSozinho(auto, FERNANDA)).toBe("nada");
  });

  it("autonomia 2: agenda, sai depois da janela; veto e pausa seguram", async () => {
    await ing(msg(FERNANDA, "Pode ser quinta às 15h?"));
    await repo.definirAutonomia(db, FERNANDA, 2);
    expect(await responderSozinho(auto, FERNANDA)).toBe("agendado");
    expect(avisos.at(-1)).toMatch(/Respondo \*Fernanda\* em 10 min se você não vetar/);

    expect(await enviarAgendados(auto)).toBe(0); // ainda na janela
    agora = new Date(agora.getTime() + 11 * 60_000);
    expect(await enviarAgendados(auto)).toBe(1);
    expect(whats.enviadas).toEqual([{ destino: FERNANDA, texto: "Combinado, quinta às 15h então!" }]);

    // Segundo rascunho: vetado na janela.
    await ing(msg(FERNANDA, "e sexta?"));
    expect(await responderSozinho(auto, FERNANDA)).toBe("agendado");
    await tratarComando(deps, "veta 2");
    agora = new Date(agora.getTime() + 11 * 60_000);
    expect(await enviarAgendados(auto)).toBe(0);

    // Terceiro: pausa geral tira o agendamento.
    await ing(msg(FERNANDA, "e sábado?"));
    expect(await responderSozinho(auto, FERNANDA)).toBe("agendado");
    await tratarComando(deps, "pausa");
    agora = new Date(agora.getTime() + 11 * 60_000);
    expect(await enviarAgendados(auto)).toBe(0);
    expect(whats.enviadas).toHaveLength(1);
    expect((await repo.lerRascunho(db, 3))?.status).toBe("aguardando");
  });

  it("autonomia 2: não sai se o dono respondeu à mão, ajustou ou pausou durante a janela", async () => {
    await ing(msg(FERNANDA, "Pode ser quinta às 15h?"));
    await repo.definirAutonomia(db, FERNANDA, 2);
    expect(await responderSozinho(auto, FERNANDA)).toBe("agendado");
    // Ele respondeu pelo celular antes de a janela acabar.
    await ing(msg(FERNANDA, "Fechado, quinta 15h", { deMim: true, quando: new Date(Date.now() + 1000) }));
    agora = new Date(agora.getTime() + 11 * 60_000);
    expect(await enviarAgendados(auto)).toBe(0);
    expect(whats.enviadas).toHaveLength(0);
    expect((await repo.lerRascunho(db, 1))?.status).toBe("aguardando");

    // Rascunho agendado que o dono ajusta: o prazo vencido não manda o texto antigo.
    await ing(msg(FERNANDA, "e sexta?", { quando: new Date(Date.now() + 2000) }));
    await tratarComando(deps, "descarta 1");
    expect(await responderSozinho(auto, FERNANDA)).toBe("agendado");
    ia.rascunho = "Sexta não consigo, pode ser segunda?";
    await tratarComando(deps, "ajusta 2 diz que sexta não dá");
    agora = new Date(agora.getTime() + 11 * 60_000);
    expect(await enviarAgendados(auto)).toBe(0);
    expect(whats.enviadas).toHaveLength(0);
    const r2 = await db.query("SELECT texto, pedido, ajustado, enviar_em FROM rascunhos WHERE id = 2");
    expect(r2.rows[0]).toMatchObject({ texto: "Sexta não consigo, pode ser segunda?", ajustado: true, enviar_em: null });
    // O ajuste fica no pedido: é dele que saem as lições.
    expect(r2.rows[0].pedido).toMatch(/Ajuste: diz que sexta não dá/);

    // Pausado entre o agendamento e o envio, mesmo com o horário ainda gravado.
    await tratarComando(deps, "descarta 2");
    await ing(msg(FERNANDA, "e sábado?", { quando: new Date(Date.now() + 3000) }));
    ia.rascunho = "Sábado pode!";
    expect(await responderSozinho(auto, FERNANDA)).toBe("agendado");
    await db.query("INSERT INTO estado (chave, valor) VALUES ('autonomia:pausada', '1')");
    agora = new Date(agora.getTime() + 11 * 60_000);
    const [r3] = await repo.rascunhosParaEnviar(db, agora);
    expect(await executarEnvio(deps, r3, "", { padrao: 0, nivelMinimo: 2, agendado: true, agora })).toBe(false);
    expect(whats.enviadas).toHaveLength(0);
  });

  it("ok sem número só vale com um rascunho aguardando", async () => {
    await ing(msg(FERNANDA, "oi"));
    await repo.criarRascunho(db, FERNANDA, "r1", "x");
    await repo.criarRascunho(db, FERNANDA, "r2", "x");
    await tratarComando(deps, "ok");
    expect(avisos.at(-1)).toMatch(/Há 2 rascunhos aguardando: diga o número \(#2, #1\)/);
    await tratarComando(deps, "descarta");
    expect(whats.enviadas).toHaveLength(0);
    await tratarComando(deps, "descarta 2");
    await tratarComando(deps, "ok");
    expect(whats.enviadas).toEqual([{ destino: FERNANDA, texto: "r1" }]);
    await tratarComando(deps, "ok 1");
    expect(avisos.at(-1)).toMatch(/Não há rascunho aguardando com esse número/);
  });

  it("fora apaga ficha, compromissos, datas e rascunhos, e a autonomia deixa de valer", async () => {
    await ing(msg(FERNANDA, "oi"));
    await repo.definirAutonomia(db, FERNANDA, 3);
    await repo.lembrar(db, FERNANDA, ["filha se chama Ana"]);
    await repo.atualizarFicha(db, FERNANDA, { relacao: "cliente", resumo: "cliente da cozinha" });
    await repo.criarCompromisso(db, { chatJid: FERNANDA, descricao: "visita", quando: null, responsavel: "eu" });
    await repo.gravarDatas(db, FERNANDA, [{ descricao: "aniversário", mes: 10, dia: 24 }]);
    const id = await repo.criarRascunho(db, FERNANDA, "Combinado!", "x");
    await db.query("UPDATE rascunhos SET risco = 'baixo', enviar_em = $2 WHERE id = $1", [id, agora]);

    await tratarComando(deps, "fora Fernanda");
    const f = await repo.lerContato(db, FERNANDA);
    expect(f).toMatchObject({ excluido: true, memoria: "", relacao: null, resumo: "", autonomia: null });
    expect(await repo.compromissosAbertos(db)).toEqual([]);
    expect(await repo.datasProximas(db, { ano: 2026, mes: 10, dia: 22 }, 7)).toEqual([]);
    expect(await repo.rascunhosParaEnviar(db, new Date(agora.getTime() + 60_000))).toEqual([]);
    expect(await repo.nivelDeAutonomia(db, FERNANDA, 3)).toBe(0);
    expect(await enviarAgendados({ ...auto, padrao: 3 })).toBe(0);
    expect(whats.enviadas).toHaveLength(0);
  });

  it("juntar LID e número mantém o nível mais cauteloso e as datas", async () => {
    const LID = "99887766@lid";
    await repo.garantirContato(db, FERNANDA, { grupo: false });
    await repo.garantirContato(db, LID, { grupo: false, nomePush: "Fernanda" });
    await repo.definirAutonomia(db, LID, 0);
    await repo.definirAutonomia(db, FERNANDA, 2);
    await repo.gravarDatas(db, LID, [{ descricao: "aniversário", mes: 10, dia: 24 }]);
    await repo.atualizarAguardando(db, LID, "as medidas");
    await repo.registrarApelido(db, LID, FERNANDA);
    const f = await repo.lerContato(db, FERNANDA);
    expect(f).toMatchObject({ autonomia: 0, aguardando: "as medidas" });
    expect((await repo.datasProximas(db, { ano: 2026, mes: 10, dia: 22 }, 7)).map((d) => d.jid)).toEqual([FERNANDA]);
  });

  it("ferramentas do agente: LID vira o número e conversa excluída não existe", async () => {
    const LID = "99887766@lid";
    await ing(msg(FERNANDA, "oi"));
    await repo.registrarApelido(db, LID, FERNANDA);
    const ferramentas = criarFerramentas(deps) as unknown as { name: string; run(x: any): Promise<string> }[];
    const lembrar = ferramentas.find((f) => f.name === "lembrar_fato")!;
    expect(await lembrar.run({ jid: LID, fato: "filha se chama Ana" })).toBe("Guardado.");
    expect((await repo.lerContato(db, FERNANDA))?.memoria).toMatch(/Ana/);
    expect(await lembrar.run({ jid: "000@s.whatsapp.net", fato: "x" })).toMatch(/não encontrada/);
    await tratarComando(deps, "fora Fernanda");
    expect(await lembrar.run({ jid: FERNANDA, fato: "y" })).toMatch(/não encontrada/);
    expect((await repo.lerContato(db, FERNANDA))?.memoria).toBe("");
  });

  it("risco alto nunca sai sozinho: palavra de dinheiro, classificador e [preencher]", async () => {
    await repo.garantirContato(db, FERNANDA, { grupo: false });
    await repo.definirAutonomia(db, FERNANDA, 3);
    await ing(msg(FERNANDA, "quanto fica?"));
    ia.rascunho = "Fica R$ 4.500 o projeto.";
    expect(await responderSozinho(auto, FERNANDA)).toBe("proposto");
    expect(avisos.at(-1)).toMatch(/precisa de você: fala de "R\$"/);
    await tratarComando(deps, "descarta");

    ia.rascunho = "Acho que dá sim.";
    ia.risco = { risco: "alto", motivo: "opinião técnica" };
    expect(await responderSozinho(auto, FERNANDA)).toBe("proposto");
    await tratarComando(deps, "descarta");

    ia.rascunho = "Te confirmo [preencher: horário].";
    expect(await responderSozinho(auto, FERNANDA)).toBe("proposto");
    await tratarComando(deps, "descarta");

    // Resposta "segura" que só pula o assunto de trabalho também espera o dono.
    ia.rascunho = "Ficou linda a camisa! Que o alvará saia logo, se Deus quiser";
    ia.risco = { risco: "baixo", motivo: "resposta simples", sem_resposta: ["os projetistas não entregarem o executivo"] };
    expect(await responderSozinho(auto, FERNANDA)).toBe("proposto");
    expect(avisos.at(-1)).toMatch(/precisa de você: não responde: os projetistas não entregarem o executivo/);
    expect(whats.enviadas).toHaveLength(0);
  });

  it("autonomia 3 envia direto o simples, mas não de madrugada nem em grupo", async () => {
    await ing(msg(FERNANDA, "obrigada!"));
    await repo.definirAutonomia(db, FERNANDA, 3);
    ia.rascunho = "Imagina! 😊";
    expect(await responderSozinho(auto, FERNANDA)).toBe("enviado");
    expect(whats.enviadas[0]).toEqual({ destino: FERNANDA, texto: "Imagina! 😊" });
    // O envio fica na conversa (a Evolution não devolve o eco): o próximo rascunho o vê.
    const ultima = (await repo.ultimasMensagens(db, FERNANDA, 1))[0];
    expect(ultima).toMatchObject({ de_mim: true, texto: "Imagina! 😊" });

    await ing(msg(FERNANDA, "boa noite!"));
    agora = new Date("2026-10-23T05:00:00Z"); // 02h em SP
    expect(await responderSozinho(auto, FERNANDA)).toBe("proposto");

    await ing(msg(GRUPO, "alguém?"));
    await repo.definirAutonomia(db, GRUPO, 3);
    expect(await repo.nivelDeAutonomia(db, GRUPO, 3)).toBe(0);
  });

  it("taxa de acerto: ajuste conta contra", async () => {
    await ing(msg(FERNANDA, "oi"));
    for (let i = 0; i < 3; i++) await repo.criarRascunho(db, FERNANDA, `r${i}`, "x");
    await tratarComando(deps, "ok 1");
    await tratarComando(deps, "ajusta 2 mais curto");
    await tratarComando(deps, "ok 2");
    await tratarComando(deps, "descarta 3");
    const [a] = await repo.acertos(db, FERNANDA);
    expect(a).toMatchObject({ decididos: 3, sem_ajuste: 1 });
    await tratarComando(deps, "autonomia");
    expect(avisos.at(-1)).toMatch(/Fernanda: 1\/3/);
    await tratarComando(deps, "autonomia Fernanda 2");
    expect(avisos.at(-1)).toMatch(/nível 2 \(envia se você não vetar\)/);
  });

  it("confirma leva o compromisso do dono para a agenda, uma vez", async () => {
    await ing(msg(FERNANDA, "oi"));
    const quando = new Date("2026-10-23T18:00:00Z");
    const id = (await repo.criarCompromisso(db, { chatJid: FERNANDA, descricao: "visita à obra", quando, responsavel: "eu" }))!;
    await tratarComando(deps, `confirma ${id}`);
    expect(google.criados).toEqual([expect.objectContaining({ titulo: "visita à obra (Fernanda)", inicio: quando })]);
    expect(avisos.at(-1)).toMatch(/Coloquei na agenda/);
    await tratarComando(deps, `confirma ${id}`);
    expect(google.criados).toHaveLength(1);
  });

  it("briefing antes da reunião, com a ficha de quem vai estar", async () => {
    await ing(msg(FERNANDA, "Amanhã a gente fecha a marcenaria"));
    await repo.atualizarFicha(db, FERNANDA, { relacao: "cliente", resumo: "Cliente do Bela Vista" });
    google.evs = [
      {
        id: "e1",
        titulo: "Reunião com Fernanda",
        inicio: new Date(Date.now() + 30 * 60_000),
        fim: new Date(Date.now() + 90 * 60_000),
        diaInteiro: false,
        local: "Escritório",
        descricao: "",
        convidados: [],
      },
    ];
    expect(await briefings(deps, 45)).toBe(1);
    expect(avisos.at(-1)).toMatch(/📅 Em 30 min: \*Reunião com Fernanda\* \(Escritório\)/);
    expect(ia.escritos.at(-1)!.conteudo).toMatch(/Cliente do Bela Vista[\s\S]*fecha a marcenaria/);
    expect(await briefings(deps, 45)).toBe(0);
  });

  it("lembrete na hora: 10 min antes, uma vez, só do dono; e a mesma promessa não duplica", async () => {
    await ing(msg(FERNANDA, "oi"));
    const agora = new Date("2026-10-22T16:22:00Z");
    const as1330 = new Date("2026-10-22T16:30:00Z");
    const id = (await repo.criarCompromisso(db, { chatJid: FERNANDA, descricao: "ligar para a Fernanda", quando: as1330, responsavel: "eu" }))!;
    // Outras palavras, mesmo horário: é o mesmo compromisso.
    expect(await repo.criarCompromisso(db, { chatJid: FERNANDA, descricao: "ligar para a Fernanda sobre a perícia", quando: new Date(as1330.getTime() + 5 * 60_000), responsavel: "eu" })).toBeNull();
    await repo.criarCompromisso(db, { chatJid: FERNANDA, descricao: "Fernanda mandar a planta", quando: as1330, responsavel: "contato" });

    expect(await lembretesNaHora(deps, 10, new Date("2026-10-22T16:10:00Z"))).toBe(0);
    expect(await lembretesNaHora(deps, 10, agora)).toBe(1);
    expect(avisos.at(-1)).toBe(`⏰ 13:30 — ligar para a Fernanda (Fernanda) · #${id}\n_feito ${id} · ignora ${id}_`);
    expect(await lembretesNaHora(deps, 10, new Date("2026-10-22T16:25:00Z"))).toBe(0);
  });

  it("fim do dia, datas, radar e revisão da semana", async () => {
    await ing(msg(FERNANDA, "oi"));
    const hoje = new Date();
    await repo.criarCompromisso(db, { chatJid: FERNANDA, descricao: "mandar o orçamento", quando: new Date(hoje.getTime() - 60_000), responsavel: "eu" });
    expect(await fimDoDia(deps, hoje)).toBe(1);
    expect(avisos.at(-1)).toMatch(/Ainda aberto de hoje[\s\S]*mandar o orçamento/);

    const amanha = new Date(hoje.getTime() + 86400_000);
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: SP, month: "numeric", day: "numeric" }).formatToParts(amanha);
    await repo.gravarDatas(db, FERNANDA, [{ descricao: "aniversário", mes: Number(p.find((x) => x.type === "month")!.value), dia: Number(p.find((x) => x.type === "day")!.value) }]);
    expect((await montarResumo(deps, hoje)).texto).toMatch(/🎂 amanhã: aniversário — Fernanda/);

    // Cliente que sumiu há 30 dias, com histórico de conversa.
    await repo.atualizarFicha(db, JOAO, { relacao: "cliente" });
    for (let i = 0; i < 10; i++) await ing(msg(JOAO, `msg ${i}`, { quando: new Date(Date.now() - (30 + i) * 86400_000) }));
    await repo.atualizarFicha(db, JOAO, { relacao: "cliente" });
    expect((await radar(db)).map((x) => x.nome)).toEqual(["João"]);

    await revisaoSemanal(deps, hoje);
    expect(avisos.at(-1)).toMatch(/🗓️ \*Revisão da semana\*/);
    expect(ia.escritos.at(-1)!.conteudo).toMatch(/Faz tempo que não fala com:\nJoão \(cliente, 30 dias\)/);
  });

  it("painel: página com a fila, e as rotas exigem o token", async () => {
    await ing(msg(FERNANDA, "oi"));
    await repo.criarRascunho(db, FERNANDA, "Oi Fê <script>", "x");
    const html = await paginaDoPainel(deps, "/painel/T", { fuso: SP, dono: "Lucas", niveis: ["a", "b", "c", "d"], padrao: 0 });
    expect(html).toContain("Para Fernanda");
    // As outras abas abrem com os dados da mesma conversa.
    await repo.atualizarConversa(db, FERNANDA, { situacao: "Ela perguntou do orçamento.", esperaResposta: true, sugestoes: ["Mando amanhã", "Peço as medidas"] });
    const opcoes = { fuso: SP, dono: "Lucas", niveis: ["a", "b", "c", "d"], padrao: 0 };
    const conversas = await paginaDoPainel(deps, "/painel/T", opcoes, "", { aba: "conversas" });
    expect(conversas).toContain("1 espera você.");
    expect(conversas).toContain(`c=${encodeURIComponent(FERNANDA)}`);
    const aberta = await paginaDoPainel(deps, "/painel/T", opcoes, "", { aba: "conversas", c: FERNANDA });
    expect(aberta).toContain("Situação:</b> Ela perguntou do orçamento.");
    expect(aberta).toContain(">Mando amanhã</button>");
    expect(aberta).toContain(`name="volta" value="aba=conversas&amp;c=${encodeURIComponent(FERNANDA)}"`);
    const pessoa = await paginaDoPainel(deps, "/painel/T", opcoes, "", { aba: "pessoas", p: FERNANDA });
    expect(pessoa).toContain("<h3>Fernanda</h3>");
    expect(pessoa).toContain("Corrigir algo que entendi errado");
    const assistente = await paginaDoPainel(deps, "/painel/T", opcoes, "Feito.", { aba: "assistente" });
    expect(assistente).toContain("Gasto com o Claude");
    expect(assistente).toContain('<p class="aviso">Feito.</p>');
    expect(html).toContain("Oi Fê &lt;script&gt;");
    expect(html).not.toContain("<script>");

    const acoes: Record<string, string>[] = [];
    const app = criarServidor({
      webhookToken: "w".repeat(16),
      aoEvento: async () => {},
      painel: { token: "t".repeat(24), pagina: async (_b, aviso) => `<html>${aviso ?? ""}</html>`, acao: async (c) => (acoes.push(c), "Baixa dada.") },
    });
    expect((await app.inject({ method: "GET", url: "/painel/errado" })).statusCode).toBe(404);
    const pag = await app.inject({ method: "GET", url: `/painel/${"t".repeat(24)}` });
    expect(pag.statusCode).toBe(200);
    expect(pag.headers["cache-control"]).toBe("no-store");
    const post = await app.inject({
      method: "POST",
      url: `/painel/${"t".repeat(24)}/acao`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "acao=enviar&id=1&volta=aba%3Dpessoas%26p%3Dx%2540s.whatsapp.net",
    });
    expect(post.statusCode).toBe(303);
    expect(post.headers.location).toBe(`/painel/${"t".repeat(24)}?aba=pessoas&p=x%40s.whatsapp.net`);
    expect(acoes).toEqual([{ acao: "enviar", id: "1", volta: "aba=pessoas&p=x%40s.whatsapp.net" }]);
    // A confirmação aparece uma vez, no carregamento seguinte, e some.
    expect((await app.inject({ method: "GET", url: `/painel/${"t".repeat(24)}` })).body).toBe("<html>Baixa dada.</html>");
    expect((await app.inject({ method: "GET", url: `/painel/${"t".repeat(24)}` })).body).toBe("<html></html>");
    expect((await app.inject({ method: "POST", url: "/painel/errado/acao", payload: "acao=pausa", headers: { "content-type": "application/x-www-form-urlencoded" } })).statusCode).toBe(404);
    await app.close();
  });
});
