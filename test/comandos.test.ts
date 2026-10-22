import { describe, expect, it } from "vitest";
import { jidsDoDono, lerConfig } from "../src/config.js";
import { lerComando } from "../src/controle.js";
import { relogio } from "../src/formato.js";

describe("lerComando", () => {
  it.each([
    ["ok", { tipo: "enviar", id: undefined }],
    ["OK 12", { tipo: "enviar", id: 12 }],
    ["manda #7", { tipo: "enviar", id: 7 }],
    ["descarta", { tipo: "descartar", id: undefined }],
    ["não manda 3", { tipo: "descartar", id: 3 }],
    ["ajusta 4 mais formal", { tipo: "ajustar", id: 4, instrucao: "mais formal" }],
    ["ajusta: tira o emoji", { tipo: "ajustar", id: undefined, instrucao: "tira o emoji" }],
    ["feito 9", { tipo: "compromisso", acao: "feito", id: 9 }],
    ["ignora #2", { tipo: "compromisso", acao: "descartado", id: 2 }],
    ["fora Grupo da Família", { tipo: "excluir", nome: "Grupo da Família" }],
    ["volta Pedro", { tipo: "incluir", nome: "Pedro" }],
    ["resumo", { tipo: "resumo" }],
  ])("%s", (texto, esperado) => {
    expect(lerComando(texto)).toEqual(esperado);
  });

  it("frase comum vai para o Claude, mesmo começando com palavra de comando", () => {
    expect(lerComando("ok, e o que eu combinei com a Fernanda?")).toEqual({
      tipo: "pedido",
      texto: "ok, e o que eu combinei com a Fernanda?",
    });
    expect(lerComando("manda um oi pro João")).toEqual({ tipo: "pedido", texto: "manda um oi pro João" });
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

  it("valida e aplica os padrões", () => {
    const c = lerConfig(base);
    expect(c.MODELO).toBe("claude-opus-5-5");
    expect(c.RESUMO_HORA).toBe("07:30");
  });

  it("recusa número com máscara e token curto", () => {
    expect(() => lerConfig({ ...base, DONO_NUMERO: "(51) 99999-0000" })).toThrow(/DONO_NUMERO/);
    expect(() => lerConfig({ ...base, WEBHOOK_TOKEN: "curto" })).toThrow(/WEBHOOK_TOKEN/);
  });

  it("canal de controle aceita o número e os LIDs", () => {
    expect([...jidsDoDono({ DONO_NUMERO: "5551999990000", DONO_LIDS: "123456, 789@lid" })]).toEqual([
      "5551999990000@s.whatsapp.net",
      "123456@lid",
      "789@lid",
    ]);
  });
});

describe("relogio", () => {
  it("usa o fuso do dono, não o do servidor", () => {
    // 02:10 UTC é 23:10 do dia anterior em São Paulo.
    expect(relogio(new Date("2026-10-22T02:10:00Z"), "America/Sao_Paulo")).toEqual({ dia: "2026-10-21", hora: "23:10" });
  });
});
