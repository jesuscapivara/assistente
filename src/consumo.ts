import type { Db } from "./db.js";
import type { Uso } from "./ia.js";

/**
 * Dólares por milhão de tokens (entrada, saída, leitura de cache). Escrita de cache
 * custa 1,25 x a entrada. Tabela de out/2026; modelo fora dela conta como Sonnet e o
 * relatório avisa.
 */
const PRECOS: Record<string, { entrada: number; saida: number; cache: number }> = {
  "claude-opus-5-5": { entrada: 4, saida: 20, cache: 0.2 },
  "claude-sonnet-5-5": { entrada: 2, saida: 10, cache: 0.2 },
  "claude-haiku-5-5": { entrada: 0.1, saida: 0.5, cache: 0.01 },
};
const PADRAO = PRECOS["claude-sonnet-5-5"];

export function custoDe(u: Omit<Uso, "funcao">): number {
  const p = PRECOS[u.modelo] ?? PADRAO;
  return (u.entrada * p.entrada + u.saida * p.saida + u.cacheLeitura * p.cache + u.cacheEscrita * p.entrada * 1.25) / 1e6;
}

/** Grava a chamada. Falha aqui não pode derrubar a resposta ao dono: só some do relatório. */
export function registrarUso(db: Db, u: Uso): void {
  void db
    .query(
      `INSERT INTO consumo (funcao, modelo, entrada, saida, cache_leitura, cache_escrita) VALUES ($1,$2,$3,$4,$5,$6)`,
      [u.funcao, u.modelo, u.entrada, u.saida, u.cacheLeitura, u.cacheEscrita],
    )
    .catch(() => undefined);
}

export function dolar(v: number): string {
  return `US$ ${v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(2)}`;
}

export interface ResumoDeCusto {
  dia: number;
  semana: number;
  mes: number;
  /** Por função, nos 7 dias, do mais caro ao mais barato. */
  porFuncao: { funcao: string; custo: number; chamadas: number }[];
  desconhecidos: string[];
}

/** Os números do gasto: o comando `custo` e o painel saem daqui. */
export async function resumoDeCusto(db: Db): Promise<ResumoDeCusto> {
  const r = await db.query<{
    funcao: string;
    modelo: string;
    entrada: string;
    saida: string;
    cache_leitura: string;
    cache_escrita: string;
    chamadas: number;
    janela: string;
  }>(
    `SELECT funcao, modelo, sum(entrada) AS entrada, sum(saida) AS saida, sum(cache_leitura) AS cache_leitura,
            sum(cache_escrita) AS cache_escrita, count(*)::int AS chamadas,
            CASE WHEN criado_em > now() - interval '1 day' THEN 'dia'
                 WHEN criado_em > now() - interval '7 days' THEN 'semana' ELSE 'mes' END AS janela
     FROM consumo WHERE criado_em > now() - interval '30 days'
     GROUP BY funcao, modelo, janela`,
  );
  const linhas = r.rows.map((x) => ({
    ...x,
    custo: custoDe({
      modelo: x.modelo,
      entrada: Number(x.entrada),
      saida: Number(x.saida),
      cacheLeitura: Number(x.cache_leitura),
      cacheEscrita: Number(x.cache_escrita),
    }),
  }));
  const soma = (janelas: string[]) => linhas.filter((x) => janelas.includes(x.janela)).reduce((s, x) => s + x.custo, 0);
  const porFuncao = new Map<string, { custo: number; chamadas: number }>();
  for (const x of linhas.filter((x) => x.janela !== "mes")) {
    const atual = porFuncao.get(x.funcao) ?? { custo: 0, chamadas: 0 };
    porFuncao.set(x.funcao, { custo: atual.custo + x.custo, chamadas: atual.chamadas + x.chamadas });
  }
  return {
    dia: soma(["dia"]),
    semana: soma(["dia", "semana"]),
    mes: soma(["dia", "semana", "mes"]),
    porFuncao: [...porFuncao.entries()].map(([funcao, v]) => ({ funcao, ...v })).sort((a, b) => b.custo - a.custo),
    desconhecidos: [...new Set(linhas.map((x) => x.modelo).filter((m) => !PRECOS[m]))],
  };
}

/** O comando `custo`: hoje, 7 dias e 30 dias, e por função nos 7 dias. */
export async function relatorioDeCusto(db: Db): Promise<string> {
  const c = await resumoDeCusto(db);
  if (!c.mes && !c.porFuncao.length) return "Ainda não há chamadas registradas.";
  return [
    `*Gasto com o Claude*\nHoje: ${dolar(c.dia)}\n7 dias: ${dolar(c.semana)}\n30 dias: ${dolar(c.mes)}`,
    c.porFuncao.length
      ? `*Por função (7 dias)*\n${c.porFuncao.map((f) => `• ${f.funcao}: ${dolar(f.custo)} (${f.chamadas} chamadas)`).join("\n")}`
      : "",
    c.desconhecidos.length ? `_Preço estimado como Sonnet para: ${c.desconhecidos.join(", ")}_` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Gasto de cada um dos últimos `dias` dias (no fuso do dono), do mais antigo ao de hoje. */
export async function custoPorDia(db: Db, fuso: string, dias = 30): Promise<{ dia: string; custo: number }[]> {
  const r = await db.query<{ dia: string; modelo: string; entrada: string; saida: string; cache_leitura: string; cache_escrita: string }>(
    `SELECT to_char(criado_em AT TIME ZONE $1, 'YYYY-MM-DD') AS dia, modelo,
            sum(entrada) AS entrada, sum(saida) AS saida, sum(cache_leitura) AS cache_leitura, sum(cache_escrita) AS cache_escrita
     FROM consumo WHERE criado_em > now() - make_interval(days => $2)
     GROUP BY 1, 2`,
    [fuso, dias],
  );
  const porDia = new Map<string, number>();
  for (const x of r.rows) {
    const c = custoDe({ modelo: x.modelo, entrada: Number(x.entrada), saida: Number(x.saida), cacheLeitura: Number(x.cache_leitura), cacheEscrita: Number(x.cache_escrita) });
    porDia.set(x.dia, (porDia.get(x.dia) ?? 0) + c);
  }
  // Todos os dias aparecem, inclusive os de gasto zero: o gráfico mostra o ritmo.
  const hoje = Date.parse(`${new Intl.DateTimeFormat("en-CA", { timeZone: fuso }).format(new Date())}T12:00:00Z`);
  return Array.from({ length: dias }, (_, i) => {
    const dia = new Date(hoje - (dias - 1 - i) * 86400_000).toISOString().slice(0, 10); // fuso: data civil
    return { dia, custo: porDia.get(dia) ?? 0 };
  });
}
