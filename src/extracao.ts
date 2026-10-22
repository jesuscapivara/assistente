import type { Db } from "./db.js";
import { agoraPorExtenso, dataCurta, linhas } from "./formato.js";
import type { Ia } from "./ia.js";
import * as repo from "./repo.js";

export interface DepsExtracao {
  db: Db;
  ia: Ia;
  dono: string;
  fuso: string;
  quietoMin: number;
  /** Aviso no canal de controle. */
  avisar(texto: string): Promise<void>;
  agora?: () => Date;
  log?: (o: object, txt: string) => void;
}

const MAX_NOVAS = 80;
const CONTEXTO = 15;
// Compromisso próximo vira aviso na hora; o resto espera o resumo da manhã.
const AVISO_HORAS = 48;

/**
 * Uma rodada: para cada conversa que assentou, lê o trecho novo, extrai compromissos
 * e fatos, e marca o trecho como lido. Uma falha numa conversa não para as outras,
 * e o trecho dela fica para a próxima rodada.
 */
export async function rodadaDeExtracao(deps: DepsExtracao): Promise<number> {
  const chats = await repo.chatsParaExtrair(deps.db, deps.quietoMin);
  let feitas = 0;
  for (const jid of chats) {
    try {
      await extrairChat(deps, jid);
      feitas++;
    } catch (err) {
      deps.log?.({ err: String(err), jid }, "extração falhou");
    }
  }
  return feitas;
}

export async function extrairChat(deps: DepsExtracao, jid: string): Promise<void> {
  const { db } = deps;
  const contato = await repo.lerContato(db, jid);
  if (!contato || contato.excluido) return;

  const pendentes = (
    await db.query<repo.Mensagem>(
      `SELECT id, chat_jid, remetente_nome, de_mim, tipo, texto, enviada_em FROM mensagens
       WHERE chat_jid = $1 AND NOT extraida ORDER BY enviada_em`,
      [jid],
    )
  ).rows;
  if (!pendentes.length) return;
  const ate = new Date(pendentes[pendentes.length - 1].enviada_em);
  // Depois de muito tempo parado (ou na primeira carga), lê só o fim: é o que importa agora.
  const novas = pendentes.slice(-MAX_NOVAS);
  const anteriores = (
    await db.query<repo.Mensagem>(
      `SELECT id, chat_jid, remetente_nome, de_mim, tipo, texto, enviada_em FROM mensagens
       WHERE chat_jid = $1 AND enviada_em < $2 ORDER BY enviada_em DESC LIMIT $3`,
      [jid, novas[0].enviada_em, CONTEXTO],
    )
  ).rows.reverse();

  const nome = repo.nomeDe(contato);
  const agora = deps.agora?.() ?? new Date();
  const r = await deps.ia.extrair({
    agora: agoraPorExtenso(agora, deps.fuso),
    dono: deps.dono,
    contato: nome,
    grupo: contato.grupo,
    memoria: contato.memoria,
    anteriores: linhas(anteriores, deps.dono, nome, deps.fuso),
    novas: linhas(novas, deps.dono, nome, deps.fuso),
  });

  const avisos: string[] = [];
  for (const c of r.compromissos) {
    const quando = c.quando ? new Date(c.quando) : null;
    const valida = quando && !Number.isNaN(quando.getTime()) ? quando : null;
    const id = await repo.criarCompromisso(db, {
      chatJid: jid,
      descricao: c.descricao,
      quando: valida,
      responsavel: c.responsavel,
      mensagemId: novas[novas.length - 1].id,
    });
    if (id && valida && c.responsavel !== "contato" && valida.getTime() - agora.getTime() < AVISO_HORAS * 3600_000) {
      avisos.push(`#${id} ${c.descricao} — ${dataCurta(valida, deps.fuso)} (${nome})`);
    }
  }
  // Fato de grupo é de quem falou, e o grupo não é uma pessoa: memória só para conversa individual.
  if (!contato.grupo) await repo.lembrar(db, jid, r.fatos);
  await repo.marcarExtraidas(db, jid, ate);

  if (avisos.length) {
    await deps.avisar(
      `Anotei para os próximos dias:\n${avisos.join("\n")}\n\n_confirma N · feito N · ignora N_`,
    );
  }
}
