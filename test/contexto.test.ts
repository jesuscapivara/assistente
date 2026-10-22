import { describe, expect, it } from "vitest";
import { desenharCartao, planoDoCartao, relevo } from "../src/cartao.js";
import { custoDe } from "../src/consumo.js";
import { lerComando, precisaDoKoreos } from "../src/controle.js";
import { grupoEnvolveDono, semConteudo } from "../src/extracao.js";
import { guardarImagem, lerImagem } from "../src/midia.js";
import { nomeDe } from "../src/repo.js";
import type { Dia } from "../src/resumo.js";
import { resumoEmTexto } from "../src/resumo.js";
import { koreosDoDia, resultadoDoMcp } from "../src/koreos.js";
import { lerAgenda } from "../src/whatsapp/evolution.js";
import { lerHistorico } from "../src/whatsapp/evento.js";

const SP = "America/Sao_Paulo";
const em = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 22, h + 3, m));

function diaVazio(): Dia {
  return { agora: em(7, 30), eventosHoje: [], eventosAmanha: [], comData: [], semData: [], esperando: [], datas: [], emails: [], resolvidos: [], koreos: null };
}

describe("filtro sem modelo", () => {
  it("'ok', 'kkk', emoji e figurinha não têm o que extrair; 'sim' e pergunta têm", () => {
    for (const t of ["ok", "Tá ok", "kkkk", "👍", "valeu!", "Disponha!", "rsrs", "Beleza 🙏"]) {
      expect(semConteudo({ tipo: "texto", texto: t }), t).toBe(true);
    }
    expect(semConteudo({ tipo: "outro", texto: "" })).toBe(true);
    for (const t of ["sim", "não", "Sábado eu estaria mais livre", "ok, mas e o orçamento?"]) {
      expect(semConteudo({ tipo: "texto", texto: t }), t).toBe(false);
    }
    expect(semConteudo({ tipo: "imagem", texto: "" })).toBe(false);
  });

  it("grupo só envolve o dono se ele falou ou foi citado", () => {
    expect(grupoEnvolveDono([{ de_mim: false, texto: "alguém tem a planta?" }], ["Lucas"])).toBe(false);
    expect(grupoEnvolveDono([{ de_mim: false, texto: "@Lucas tem a planta?" }], ["Lucas"])).toBe(true);
    expect(grupoEnvolveDono([{ de_mim: true, texto: "tenho" }], [])).toBe(true);
  });
});

describe("nomes", () => {
  it("sem nome, número formatado; LID nunca aparece", () => {
    expect(nomeDe({ nome: null, nome_push: null, jid: "5551999990000@s.whatsapp.net" })).toBe("+5551999990000");
    expect(nomeDe({ nome: null, nome_push: null, jid: "81690412224708@lid" })).toBe("contato sem nome");
    expect(nomeDe({ nome: null, nome_push: "Ana", jid: "81690412224708@lid" })).toBe("Ana");
  });

  it("agenda do celular, em mapa ou lista, sem grupo e sem o sufixo do aparelho", () => {
    expect(
      lerAgenda({
        data: {
          "5551911111111@s.whatsapp.net": { FullName: "Ana Ribeiro", PushName: "Ana" },
          "120363@g.us": { FullName: "Grupo" },
          "5551922222222:3@s.whatsapp.net": { PushName: "João" },
        },
      }),
    ).toEqual([
      { jid: "5551911111111@s.whatsapp.net", nome: "Ana Ribeiro", push: "Ana" },
      { jid: "5551922222222@s.whatsapp.net", nome: null, push: "João" },
    ]);
    expect(lerAgenda([{ JID: "5551933333333@s.whatsapp.net", FirstName: "Carla" }])).toEqual([
      { jid: "5551933333333@s.whatsapp.net", nome: "Carla", push: null },
    ]);
  });

  it("histórico traz os pares LID ↔ número", () => {
    const h = lerHistorico({
      event: "HistorySync",
      data: { Data: { phoneNumberToLidMappings: [{ pnJid: "5551911111111", lidJid: "81690412224708" }], conversations: [] } },
    });
    expect(h.pares).toEqual([{ lid: "81690412224708@lid", numero: "5551911111111@s.whatsapp.net" }]);
  });
});

describe("comandos e agente", () => {
  it("custo e caderno são comandos", () => {
    expect(lerComando("custo")).toEqual({ tipo: "custo" });
    expect(lerComando("caderno")).toEqual({ tipo: "caderno", limpar: false });
    expect(lerComando("esquece caderno")).toEqual({ tipo: "caderno", limpar: true });
    expect(lerComando("esquece 4")).toEqual({ tipo: "esquecer", id: 4 });
    expect(lerComando("Sim")).toEqual({ tipo: "pedido", texto: "Sim" });
  });

  it("KoreOS só entra quando o assunto é o escritório", () => {
    expect(precisaDoKoreos("quais tarefas vencem amanhã?")).toBe(true);
    expect(precisaDoKoreos("o que a Ana me falou ontem?")).toBe(false);
  });

  it("custo por modelo, com cache", () => {
    const u = { entrada: 1_000_000, saida: 100_000, cacheLeitura: 0, cacheEscrita: 0 };
    expect(custoDe({ modelo: "claude-haiku-5-5", ...u })).toBeCloseTo(0.15, 5);
    expect(custoDe({ modelo: "claude-sonnet-5-5", ...u })).toBeCloseTo(3, 5);
    expect(custoDe({ modelo: "claude-opus-5-5", ...u, cacheLeitura: 1_000_000 })).toBeCloseTo(6.2, 5);
  });
});

describe("resumo", () => {
  it("quem espera aparece com a situação, não com a frase solta", () => {
    const dia = diaVazio();
    dia.esperando = [
      { jid: "x@s.whatsapp.net", nome: "Ana", ultima: "Sábado eu estaria mais livre", quando: em(-10), situacao: "Você convidou a Ana para a obra; ela disse que sábado está livre." },
    ];
    const { texto, refs } = resumoEmTexto(dia, "Lucas", SP);
    expect(texto).toMatch(/Bom dia, Lucas! \(quinta, 22\/10\)/);
    expect(texto).toMatch(/\*Ana\*.*convidou a Ana para a obra/);
    expect(texto).not.toMatch(/Sábado eu estaria/);
    expect(refs).toBe("Ana = x@s.whatsapp.net");
  });

  it("o que o contato ficou de fazer não vira tarefa do dono", async () => {
    // O caso do README: o dono mandou, o contato disse "vou ler".
    const dia = diaVazio();
    dia.comData = [
      { id: 1, chat_jid: "t", descricao: "ler o README que o Lucas mandou", quando: em(20), responsavel: "contato", status: "sugerido", contato_nome: "Toshio" },
    ];
    expect(resumoEmTexto(dia, "Lucas", SP).texto).toMatch(/#1 22\/10 20:00 — Toshio ficou de: ler o README/);
    expect((await planoDoCartao(null, dia, "Lucas", SP)).precisa).toEqual([]);
  });

  it("dia vazio é uma linha calma", () => {
    expect(resumoEmTexto(diaVazio(), "Lucas", SP).texto).toBe("Bom dia, Lucas! (quinta, 22/10) Nada pendente por aqui hoje.");
  });
});

describe("cartão", () => {
  it("dia sem reunião é linha reta, sem pontos; reunião vira ponto no relevo", () => {
    expect(relevo(diaVazio(), SP)).not.toMatch(/<circle[^>]*fill="#2E2C27"/);
    const dia = diaVazio();
    dia.eventosHoje = [{ id: "1", titulo: "Obra", inicio: em(9), fim: em(11), diaInteiro: false, local: "", descricao: "", convidados: [] }];
    expect(relevo(dia, SP).match(/<circle[^>]*fill="#2E2C27"/g)).toHaveLength(1);
  });

  it("o modelo não inventa item: ref que não existe sai", async () => {
    const dia = diaVazio();
    dia.comData = [{ id: 12, chat_jid: "x", descricao: "Mandar o memorial", quando: em(18), responsavel: "eu", status: "confirmado", contato_nome: "Paulo" }];
    const ia = {
      estruturar: async () => ({
        manchete: "Um dia leve, Lucas.",
        atos: [
          { faixa: "8h – 12h", frase: "Livre." },
          { faixa: "12h – 18h", frase: "Livre." },
          { faixa: "18h em diante", frase: "Memorial às 18h." },
        ],
        precisa: [
          { ref: "#12", titulo: "Memorial do Paulo", frase: "Combinado no WhatsApp para hoje." },
          { ref: "#99", titulo: "Inventado", frase: "Não existe." },
        ],
        resolvido: [],
      }),
    } as any;
    const plano = await planoDoCartao(ia, dia, "Lucas", SP);
    expect(plano.precisa.map((p) => p.ref)).toEqual(["#12"]);
  });

  it("desenha um PNG", async () => {
    const dia = diaVazio();
    const png = await desenharCartao(dia, await planoDoCartao(null, dia, "Lucas", SP), SP);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.length).toBeGreaterThan(10_000);
  }, 30_000);

  it("imagem servida some depois da validade", () => {
    const id = guardarImagem(Buffer.from("x"), 0);
    expect(lerImagem(id, 1000)?.toString()).toBe("x");
    expect(lerImagem(id, 16 * 60_000)).toBeNull();
  });
});

describe("KoreOS direto, sem modelo", () => {
  it("lê o resultado do MCP em JSON ou em SSE, e erro vira exceção", () => {
    const rpc = { jsonrpc: "2.0", id: 1, result: { structuredContent: { tasks: [] }, content: [] } };
    expect(resultadoDoMcp(JSON.stringify(rpc))).toEqual({ tasks: [] });
    expect(resultadoDoMcp(`event: message\ndata: ${JSON.stringify(rpc)}\n\n`)).toEqual({ tasks: [] });
    expect(resultadoDoMcp(JSON.stringify({ result: { content: [{ type: "text", text: '{"count":0}' }] } }))).toEqual({ count: 0 });
    expect(() => resultadoDoMcp(JSON.stringify({ result: { isError: true, content: [{ type: "text", text: "sem permissão" }] } }))).toThrow(/sem permissão/);
  });

  it("atrasada é conferida pelo prazo: o KoreOS devolveu tarefa de novembro como atrasada", async () => {
    const chamadas: string[] = [];
    const k = {
      async chamar(f: string, a: Record<string, unknown>) {
        chamadas.push(`${f}:${a.period}`);
        if (f === "tasks_list_mine" && a.period === "atrasadas") {
          return {
            tasks: [
              { titulo: "Elétrico", projeto: "Clínica", prazo: "2026-10-09" },
              { titulo: "Hidrossanitário", projeto: "Comercial", prazo: "2026-11-11" },
            ],
          };
        }
        if (f === "finance_search_transactions" && a.period === "vencimento_hoje") {
          return { transactions: [{ tipo: "DESPESA", descricao: "Plotagem", valor: "R$ 367,49", data: "2026-10-22" }] };
        }
        return {};
      },
    };
    const d = await koreosDoDia(k, "2026-10-22");
    expect(d.tarefasAtrasadas.map((t) => t.titulo)).toEqual(["Elétrico"]);
    expect(d.contasHoje).toEqual([{ tipo: "DESPESA", descricao: "Plotagem", valor: "R$ 367,49", data: "2026-10-22" }]);
    expect(chamadas).toHaveLength(4);

    const dia = diaVazio();
    dia.koreos = d;
    const { texto } = resumoEmTexto(dia, "Lucas", SP);
    expect(texto).toMatch(/\*No KoreOS\*\n• Atrasada desde 09\/10: Elétrico \(Clínica\)\n• Pagar hoje: Plotagem — R\$ 367,49/);
  });

  it("errado N é comando", () => {
    expect(lerComando("errado 1 quem vai ler é o Toshio")).toEqual({ tipo: "errado", id: 1, texto: "quem vai ler é o Toshio" });
    expect(lerComando("errado #3")).toEqual({ tipo: "errado", id: 3, texto: "" });
  });
});

describe("ficou para trás", () => {
  it("quem espera há 3 dias ou mais sai em seção própria, do mais antigo, no texto e no cartão", async () => {
    const dia = diaVazio();
    const dias = (n: number) => new Date(dia.agora.getTime() - n * 86400_000);
    dia.esperando = [
      { jid: "a@s.whatsapp.net", nome: "Ana", ultima: "e aí?", quando: dias(1), situacao: "Ela perguntou do orçamento." },
      { jid: "b@s.whatsapp.net", nome: "Bruno Lima", ultima: "me liga quando puder", quando: dias(9), situacao: "Você ficou de ligar para o Bruno." },
      { jid: "c@s.whatsapp.net", nome: "Carla", ultima: "?", quando: dias(4), situacao: "" },
    ];
    const { texto } = resumoEmTexto(dia, "Lucas", SP);
    expect(texto).toMatch(/\*Ficou para trás\*\n• \*Bruno Lima\* \(há 9 dias\): Você ficou de ligar para o Bruno\.\n• \*Carla\* \(há 4 dias\)/);
    expect(texto).toMatch(/\*Esperando resposta sua\*\n• \*Ana\*/);
    expect(texto.match(/Bruno Lima/g)).toHaveLength(1);

    // No cartão, o modelo nem recebe quem ficou para trás: a seção é montada dos dados.
    let itens = "";
    const ia = { estruturar: async (_s: unknown, p: { conteudo: string }) => ((itens = p.conteudo), null) } as any;
    await planoDoCartao(ia, dia, "Lucas", SP);
    expect(itens).toMatch(/Ana/);
    expect(itens).not.toMatch(/Bruno|Carla/);
  });
});
