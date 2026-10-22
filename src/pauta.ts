import { gravarEstado, lerEstado, type Db } from "./db.js";
import { meiaNoiteEm, relogio } from "./formato.js";
import * as repo from "./repo.js";
import { esperandoRecente, ficouParaTras, type Dia } from "./resumo.js";

/**
 * A pauta do último resumo: cada item que o dono pode resolver, adiar, ignorar ou
 * responder ganha uma letra (A, B, C…). Letra e não número porque os números já são
 * dos compromissos (`feito 2`): `resolvi 2` seria ambíguo.
 *
 * Fica guardada até o próximo resumo, para `resolvi B` valer à tarde também.
 */

export type TipoItem = "espera" | "compromisso" | "tarefa" | "conta" | "email" | "outro";

export interface Item {
  letra: string;
  tipo: TipoItem;
  titulo: string;
  jid?: string;
  compromissoId?: number;
  emailId?: string;
}

const LETRAS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CHAVE = "pauta";

/** O que cada ref do cartão aponta (as mesmas refs que o modelo recebe em `itensComRef`). */
export function alvoDaRef(dia: Dia, ref: string): Omit<Item, "letra" | "titulo"> {
  const n = Number(ref.replace(/^[A-Z]+/, "")) - 1;
  if (ref.startsWith("#")) return { tipo: "compromisso", compromissoId: Number(ref.slice(1)), jid: [...dia.comData, ...dia.semData].find((c) => c.id === Number(ref.slice(1)))?.chat_jid };
  if (/^W\d/.test(ref)) return { tipo: "espera", jid: esperandoRecente(dia)[n]?.jid };
  if (/^M\d/.test(ref)) return { tipo: "email", emailId: dia.emails[n]?.id };
  if (/^(T|TA)\d/.test(ref)) return { tipo: "tarefa" };
  if (/^(F|FA)\d/.test(ref)) return { tipo: "conta" };
  return { tipo: "outro" };
}

/** Letras para os itens do cartão: primeiro "Precisa de você", depois "Ficou para trás". */
export function pautaDoCartao(dia: Dia, precisa: { ref: string; titulo: string }[]): { precisa: Item[]; ficou: Item[] } {
  let i = 0;
  // Só ganha letra o que dá para resolver daqui; tarefa e conta do KoreOS se marcam lá.
  const p = precisa.map((x) => {
    const alvo = alvoDaRef(dia, x.ref);
    const acionavel = (alvo.tipo === "espera" && alvo.jid) || alvo.tipo === "compromisso" || (alvo.tipo === "email" && alvo.emailId);
    return { letra: acionavel ? (LETRAS[i++] ?? "?") : "", titulo: x.titulo, ...alvo };
  });
  const f = ficouParaTras(dia)
    .slice(0, 5)
    .map((e) => ({ letra: LETRAS[i++] ?? "?", tipo: "espera" as const, titulo: e.nome, jid: e.jid }));
  return { precisa: p, ficou: f };
}

/** Letras para o resumo em texto: quem ficou para trás e quem espera. */
export function pautaDoTexto(dia: Dia): Item[] {
  return [...ficouParaTras(dia), ...esperandoRecente(dia)].map((e, i) => ({
    letra: LETRAS[i] ?? "?",
    tipo: "espera",
    titulo: e.nome,
    jid: e.jid,
  }));
}

export async function gravarPauta(db: Db, itens: Item[]): Promise<void> {
  await gravarEstado(db, CHAVE, JSON.stringify(itens));
}

export async function lerPauta(db: Db): Promise<Item[]> {
  try {
    return JSON.parse((await lerEstado(db, CHAVE)) ?? "[]") as Item[];
  } catch {
    return [];
  }
}

export async function itemDaPauta(db: Db, letra: string): Promise<Item | null> {
  return (await lerPauta(db)).find((x) => x.letra === letra.toUpperCase()) ?? null;
}

/** A pauta em texto, para o agente entender "o B" numa frase livre. */
export function pautaEmTexto(itens: Item[]): string {
  return itens.map((x) => `${x.letra} = ${x.titulo}${x.jid ? ` (jid ${x.jid})` : ""}${x.compromissoId ? ` (compromisso #${x.compromissoId})` : ""}`).join("\n");
}

const SEMANA = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

/**
 * "amanhã", "sábado", "3 dias", "semana que vem", "25/10" → o dia civil (AAAA-MM-DD) no
 * fuso do dono. `null` se não entender: melhor perguntar do que adiar para o dia errado.
 */
export function diaDe(texto: string, agora: Date, fuso: string): string | null {
  const t = texto
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/^(pra|para|ate|até)\s+/, "");
  const [a, m, d] = relogio(agora, fuso).dia.split("-").map(Number);
  const hoje = Date.UTC(a, m - 1, d);
  const mais = (n: number) => new Date(hoje + n * 86400_000).toISOString().slice(0, 10); // fuso: data civil
  let x: RegExpMatchArray | null;
  if (/^depois de amanha$/.test(t)) return mais(2);
  if (/^amanha$/.test(t)) return mais(1);
  if (/^(semana que vem|proxima semana)$/.test(t)) return mais(7);
  if ((x = t.match(/^(\d{1,2})\s*dias?$/))) return mais(Number(x[1]));
  if ((x = t.match(/^(\d{1,2})\/(\d{1,2})$/))) {
    const dia = Number(x[1]);
    const mes = Number(x[2]);
    if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
    let alvo = Date.UTC(a, mes - 1, dia);
    if (alvo <= hoje) alvo = Date.UTC(a + 1, mes - 1, dia);
    return new Date(alvo).toISOString().slice(0, 10); // fuso: data civil
  }
  const semanaSemAcento = SEMANA.map((s) => s.normalize("NFD").replace(/[̀-ͯ]/g, ""));
  const ds = semanaSemAcento.findIndex((s) => t === s || t === `${s}-feira` || t === `${s} feira`);
  if (ds >= 0) {
    const hojeDs = new Date(hoje).getUTCDay();
    return mais(((ds - hojeDs + 7) % 7) || 7);
  }
  return null;
}

export interface DepsPauta {
  db: Db;
  fuso: string;
  agora?: () => Date;
  /** Para "ignora": ensina a leitura que aquela conversa não pedia resposta. */
  corrigir?(jid: string, correcao: string): Promise<string>;
}

export type Acao = "resolvi" | "adia" | "ignora";

const NAO_DA = "Isso é do KoreOS: marque por lá, que o resumo de amanhã já vem certo.";

/** Resolve, adia ou ignora um item da pauta. Devolve o que dizer ao dono. */
export async function cuidarDoItem(deps: DepsPauta, item: Item, acao: Acao, quando?: string): Promise<string> {
  const { db } = deps;
  const agora = deps.agora?.() ?? new Date();
  if (item.tipo === "tarefa" || item.tipo === "conta") return NAO_DA;

  if (acao === "adia") {
    const dia = quando ? diaDe(quando, agora, deps.fuso) : null;
    if (!dia) return `Para quando? Ex.: adia ${item.letra} amanhã · adia ${item.letra} sábado · adia ${item.letra} 3 dias · adia ${item.letra} 25/10`;
    const [, mm, dd] = dia.split("-");
    if (item.tipo === "espera" && item.jid) {
      await db.query("UPDATE contatos SET adiado_ate = $2 WHERE jid = $1", [item.jid, meiaNoiteEm(dia, deps.fuso)]);
      return `${item.titulo} volta no resumo de ${dd}/${mm}.`;
    }
    if (item.tipo === "compromisso" && item.compromissoId) {
      // Mantém a hora, se tinha; senão, 9h do dia.
      const r = await db.query<{ quando: Date | null }>("SELECT quando FROM compromissos WHERE id = $1", [item.compromissoId]);
      const [h, m] = r.rows[0]?.quando ? relogio(new Date(r.rows[0].quando), deps.fuso).hora.split(":").map(Number) : [9, 0];
      const novo = new Date(meiaNoiteEm(dia, deps.fuso).getTime() + (h * 60 + m) * 60_000);
      await db.query("UPDATE compromissos SET quando = $2 WHERE id = $1", [item.compromissoId, novo]);
      return `Compromisso #${item.compromissoId} passou para ${dd}/${mm}.`;
    }
    if (item.tipo === "email" && item.emailId) {
      await ocultarEmail(db, item.emailId, meiaNoiteEm(dia, deps.fuso));
      return `Esse e-mail volta no resumo de ${dd}/${mm}.`;
    }
    return `O ${item.letra} não dá para adiar.`;
  }

  if (item.tipo === "espera" && item.jid) {
    if (acao === "resolvi") {
      // Resolvido por fora (ligação, pessoalmente): o WhatsApp não fica sabendo.
      await db.query("UPDATE contatos SET espera_resposta = FALSE, adiado_ate = NULL WHERE jid = $1", [item.jid]);
      return `Baixa dada: ${item.titulo} saiu da lista. Se escrever de novo, volta.`;
    }
    await db.query("UPDATE contatos SET espera_resposta = FALSE, adiado_ate = NULL WHERE jid = $1", [item.jid]);
    const licao = deps.corrigir ? await deps.corrigir(item.jid, "Essa conversa não pedia resposta minha.").catch(() => "") : "";
    return [`${item.titulo} saiu da lista.`, licao.match(/Aprendi[^\n]*/)?.[0] ?? ""].filter(Boolean).join("\n");
  }
  if (item.tipo === "compromisso" && item.compromissoId) {
    const ok = await repo.mudarCompromisso(db, item.compromissoId, acao === "resolvi" ? "feito" : "descartado");
    return ok ? `Compromisso #${item.compromissoId}: ${acao === "resolvi" ? "feito" : "ignorado"}.` : `Não achei o compromisso #${item.compromissoId}.`;
  }
  if (item.tipo === "email" && item.emailId) {
    await ocultarEmail(db, item.emailId, null);
    return "Esse e-mail saiu do resumo.";
  }
  return `O ${item.letra} não tem o que marcar.`;
}

// E-mail não tem tabela própria: os ocultos ficam numa lista curta no estado.
const CHAVE_EMAILS = "emails_ocultos";

async function ocultarEmail(db: Db, id: string, ate: Date | null): Promise<void> {
  const atual = await emailsOcultos(db);
  atual[id] = ate ? ate.toISOString() : "sempre";
  const recentes = Object.entries(atual).slice(-300);
  await gravarEstado(db, CHAVE_EMAILS, JSON.stringify(Object.fromEntries(recentes)));
}

export async function emailsOcultos(db: Db): Promise<Record<string, string>> {
  try {
    return JSON.parse((await lerEstado(db, CHAVE_EMAILS)) ?? "{}");
  } catch {
    return {};
  }
}

/** O e-mail some do resumo se foi resolvido, ou enquanto o adiamento não vence. */
export function emailVisivel(ocultos: Record<string, string>, id: string, agora: Date): boolean {
  const v = ocultos[id];
  return !v || (v !== "sempre" && new Date(v) <= agora);
}
