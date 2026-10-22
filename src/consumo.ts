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

function dolar(v: number): string {
  return `US$ ${v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(2)}`;
}

/** O comando `custo`: hoje, 7 dias e 30 dias, e por função nos 7 dias. */
export async function relatorioDeCusto(db: Db): Promise<string> {
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
  if (!r.rows.length) return "Ainda não há chamadas registradas.";
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
  const desconhecidos = [...new Set(linhas.map((x) => x.modelo).filter((m) => !PRECOS[m]))];
  return [
    `*Gasto com o Claude*\nHoje: ${dolar(soma(["dia"]))}\n7 dias: ${dolar(soma(["dia", "semana"]))}\n30 dias: ${dolar(soma(["dia", "semana", "mes"]))}`,
    porFuncao.size
      ? `*Por função (7 dias)*\n${[...porFuncao.entries()]
          .sort((a, b) => b[1].custo - a[1].custo)
          .map(([f, v]) => `• ${f}: ${dolar(v.custo)} (${v.chamadas} chamadas)`)
          .join("\n")}`
      : "",
    desconhecidos.length ? `_Preço estimado como Sonnet para: ${desconhecidos.join(", ")}_` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
