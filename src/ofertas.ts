import { createHash } from "node:crypto";
import type { Db } from "./db.js";

/**
 * Ofertas dos grupos de promoção contra a lista de interesses do dono (pedido do Lucas,
 * 05/11/2026). Tudo por regra: os grupos mandam centenas de ofertas por dia, e chamar
 * modelo para cada uma custaria mais que o desconto.
 */

export interface Interesse {
  id: number;
  termos: string;
  preco_max: number | null;
}

/** Minúsculas e sem acento: "Monitor Gamer LG" casa com "monitor lg". */
export function normalizar(t: string): string {
  return t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Valor em reais escrito pelo dono ou pela oferta: "900", "1.299,90", "1,2 mil", "2k". */
export function lerValor(t: string): number | null {
  const m = t.trim().toLowerCase().match(/^(?:r\$\s*)?([\d.,]+)\s*(mil|k)?$/);
  if (!m) return null;
  let s = m[1];
  // "1.299,90" e "1.299": ponto é milhar; "1,5 mil": vírgula é decimal.
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  const v = Number(s) * (m[2] ? 1000 : 1);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Os preços em reais que aparecem na oferta ("💵 R$ 655", "R$1.530,97"). */
export function precos(texto: string): number[] {
  const saida: number[] = [];
  for (const m of texto.matchAll(/R\$\s*(\d[\d.]*(?:,\d{1,2})?)/gi)) {
    const v = lerValor(m[1]);
    if (v) saida.push(v);
  }
  return saida;
}

/**
 * Todas as palavras do interesse aparecem e nenhuma das "-palavra". Número casa inteiro
 * ("27" não casa com "270"); palavra casa pelo começo ("monitor" casa com "monitores").
 */
export function casa(termos: string, texto: string): boolean {
  const t = normalizar(texto);
  const palavras = normalizar(termos).split(/\s+/).filter(Boolean);
  const tem = (p: string) => {
    const e = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(/^\d+$/.test(p) ? `(^|[^a-z0-9])${e}([^a-z0-9]|$)` : `(^|[^a-z0-9])${e}`).test(t);
  };
  const quer = palavras.filter((p) => !p.startsWith("-"));
  const nao = palavras.filter((p) => p.startsWith("-") && p.length > 1).map((p) => p.slice(1));
  return quer.length > 0 && quer.every(tem) && !nao.some(tem);
}

/** O que identifica a mesma oferta repostada: o texto sem links e espaços, e o preço. */
function chaveDa(texto: string, preco: number | null): string {
  const base = normalizar(texto).replace(/https?:\/\/\S+/g, "").replace(/[^a-z0-9]+/g, "").slice(0, 160);
  return createHash("sha1").update(`${base}|${preco ?? ""}`).digest("hex");
}

export async function listarInteresses(db: Db): Promise<Interesse[]> {
  const r = await db.query<{ id: number; termos: string; preco_max: string | null }>("SELECT id, termos, preco_max FROM interesses ORDER BY id");
  return r.rows.map((x) => ({ id: x.id, termos: x.termos, preco_max: x.preco_max === null ? null : Number(x.preco_max) }));
}

export async function adicionarInteresse(db: Db, termos: string, precoMax: number | null): Promise<number> {
  const r = await db.query<{ id: number }>("INSERT INTO interesses (termos, preco_max) VALUES ($1, $2) RETURNING id", [termos.trim(), precoMax]);
  return r.rows[0].id;
}

export async function removerInteresse(db: Db, id: number): Promise<boolean> {
  return ((await db.query("DELETE FROM interesses WHERE id = $1", [id])).rowCount ?? 0) > 0;
}

export function reais(v: number): string {
  return `R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

export function descreverInteresse(i: Interesse): string {
  return `#${i.id} ${i.termos}${i.preco_max ? ` (até ${reais(i.preco_max)})` : ""}`;
}

/**
 * "monitor 27 até 900", "ssd 2tb até R$ 1.200,50", "drone dji -mini": as palavras e o
 * teto, se houver. Sem palavra nenhuma, null.
 */
export function lerInteresse(t: string): { termos: string; preco_max: number | null } | null {
  const m = t.trim().match(/^([\s\S]*?)(?:\s+(?:at[ée]|max(?:imo)?|m[áa]x(?:imo)?)\s+(r\$\s*)?([\d.,]+\s*(?:mil|k)?))?[.!]?$/i);
  if (!m) return null;
  const termos = m[1].trim();
  if (!termos) return null;
  return { termos, preco_max: m[3] ? lerValor(m[3]) : null };
}

/**
 * Uma mensagem de grupo de promoção. Devolve o aviso a mandar ao dono, ou null se nada
 * bateu (ou se já avisou essa oferta para esse interesse).
 */
export async function avaliarOferta(db: Db, chatJid: string, grupo: string, texto: string): Promise<string | null> {
  if (!texto.trim()) return null;
  const interesses = await listarInteresses(db);
  if (!interesses.length) return null;
  const valores = precos(texto);
  const menor = valores.length ? Math.min(...valores) : null;
  const bateram: Interesse[] = [];
  for (const i of interesses) {
    if (!casa(i.termos, texto)) continue;
    // Sem preço na oferta, avisa assim mesmo: o teto não tem como ser conferido.
    if (i.preco_max !== null && menor !== null && menor > i.preco_max) continue;
    const nova = await db.query(
      `INSERT INTO ofertas_avisadas (interesse_id, chave, chat_jid, texto, preco) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [i.id, chaveDa(texto, menor), chatJid, texto.slice(0, 2000), menor],
    );
    if (nova.rowCount) bateram.push(i);
  }
  if (!bateram.length) return null;
  const corpo = texto.length > 700 ? `${texto.slice(0, 700)}…` : texto;
  return `🛒 *Oferta* para ${bateram.map(descreverInteresse).join(", ")}, no ${grupo}:\n\n${corpo}`;
}

/** As últimas ofertas que bateram, para a lista de interesses mostrar o que já chegou. */
export async function ultimasOfertas(db: Db, limite = 5): Promise<{ termos: string; preco: number | null; texto: string; criado_em: Date }[]> {
  const r = await db.query<{ termos: string; preco: string | null; texto: string; criado_em: Date }>(
    `SELECT i.termos, o.preco, o.texto, o.criado_em FROM ofertas_avisadas o JOIN interesses i ON i.id = o.interesse_id
     ORDER BY o.criado_em DESC LIMIT $1`,
    [limite],
  );
  return r.rows.map((x) => ({ ...x, preco: x.preco === null ? null : Number(x.preco) }));
}

/** Interesses, grupos de promoção vigiados e as últimas ofertas: o "interesses" do chat e do MCP. */
export function textoDosInteresses(
  lista: Interesse[],
  grupos: string[],
  ultimas: { termos: string; preco: number | null; texto: string }[],
): string {
  return [
    "*Interesses*",
    ...(lista.length ? lista.map((i) => `• ${descreverInteresse(i)}`) : ["• nenhum (interesse <palavras> até <valor>)"]),
    "",
    "*Grupos de promoção vigiados*",
    ...(grupos.length ? grupos.map((g) => `• ${g}`) : ["• nenhum (promo <nome do grupo>)"]),
    ...(ultimas.length
      ? ["", "*Últimas que bateram*", ...ultimas.map((o) => `• ${o.termos}${o.preco ? ` — ${reais(o.preco)}` : ""}: ${o.texto.split("\n")[0].slice(0, 80)}`)]
      : []),
  ].join("\n");
}
