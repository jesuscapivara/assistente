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
  /** Conversa individual em que o contato espera algo do dono (autonomia decide o que fazer). */
  aoPrecisarResposta?(jid: string): Promise<void>;
  /** Como o dono é citado em grupo (nome, número, LID): grupo só é lido quando o envolve. */
  mencoes?: string[];
  agora?: () => Date;
  log?: (o: object, txt: string) => void;
}

const MAX_NOVAS = 80;
const CONTEXTO = 15;
// Compromisso próximo vira aviso na hora; o resto espera o resumo da manhã.
const AVISO_HORAS = 48;

/**
 * Mensagem que não carrega nada para extrair: "ok", "kkk", "top", emoji, figurinha.
 * "Sim" e "não" ficam de fora de propósito: respondem a uma pergunta e podem fechar
 * um combinado.
 */
const TRIVIAL =
  /^(?:(?:ok+|okay|blz|beleza|top|show|massa|boa|valeu|vlw|obrigad[oa]s?|obg|brigad[oa]|tmj|perfeito|certo|t[aá] ?(?:ok|bom|certo)|disponha|de nada|imagina|bom dia|boa tarde|boa noite|(?:k|rs|ha|he)+)\b)?[\p{Extended_Pictographic}\p{Emoji_Modifier}️‍\s!.,]*$/iu;

export function semConteudo(m: Pick<repo.Mensagem, "tipo" | "texto">): boolean {
  if (m.tipo === "outro") return true;
  return m.tipo === "texto" && TRIVIAL.test(m.texto.trim());
}

/** Grupo só custa uma leitura quando o dono falou ali ou foi citado. */
export function grupoEnvolveDono(novas: Pick<repo.Mensagem, "de_mim" | "texto">[], mencoes: string[]): boolean {
  const termos = mencoes.map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 3);
  return novas.some((m) => m.de_mim || termos.some((t) => m.texto.toLowerCase().includes(t)));
}

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

  // Sem modelo quando não há o que ler: "ok", "kkk", figurinha, ou grupo que não envolve
  // o dono (menos o acompanhado, que o dono pediu para ler sempre). O "tá ok" do outro
  // também encerra o assunto: ninguém ali espera resposta.
  const ultimaNova = novas[novas.length - 1];
  const vazio = novas.every(semConteudo);
  if (vazio || (contato.grupo && !contato.acompanhado && !grupoEnvolveDono(novas, deps.mencoes ?? []))) {
    if (vazio && !contato.grupo && !ultimaNova.de_mim) await repo.donoRespondeu(db, jid);
    await repo.marcarExtraidas(db, jid, ate);
    return;
  }
  const anteriores = (
    await db.query<repo.Mensagem>(
      `SELECT id, chat_jid, remetente_nome, de_mim, tipo, texto, enviada_em FROM mensagens
       WHERE chat_jid = $1 AND enviada_em < $2 ORDER BY enviada_em DESC LIMIT $3`,
      [jid, novas[0].enviada_em, CONTEXTO],
    )
  ).rows.reverse();

  const nome = repo.nomeDe(contato);
  const agora = deps.agora?.() ?? new Date();
  // O que já está anotado nesta conversa vai junto: o trecho "ok, combinado" relê a
  // promessa anterior e o modelo a anotaria de novo com outras palavras.
  const jaAnotados = (await repo.compromissosAbertos(db)).filter((k) => k.chat_jid === jid);
  const memoria = [
    repo.fichaEmTexto(contato),
    jaAnotados.length
      ? `Compromissos JÁ ANOTADOS nesta conversa (não repita, nem com outras palavras):\n${jaAnotados
          .map((k) => `- ${k.descricao}${k.quando ? ` (${dataCurta(new Date(k.quando), deps.fuso)})` : ""}`)
          .join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  const r = await deps.ia.extrair({
    agora: agoraPorExtenso(agora, deps.fuso),
    dono: deps.dono,
    contato: nome,
    grupo: contato.grupo,
    memoria,
    licoes: await repo.licoesDeLeitura(db),
    anteriores: linhas(anteriores, deps.dono, nome, deps.fuso),
    novas: linhas(novas, deps.dono, nome, deps.fuso),
  });

  const avisos: string[] = [];
  for (const c of r.compromissos) {
    const quando = c.quando ? new Date(c.quando) : null;
    const valida = quando && !Number.isNaN(quando.getTime()) ? quando : null;
    // No banco o dono continua sendo "eu" (é o que o agente e o painel já leem).
    const responsavel = c.quem_faz === "dono" ? "eu" : c.quem_faz;
    const id = await repo.criarCompromisso(db, {
      chatJid: jid,
      descricao: c.descricao,
      quando: valida,
      responsavel,
      mensagemId: novas[novas.length - 1].id,
    });
    if (id && valida && responsavel !== "contato" && valida.getTime() - agora.getTime() < AVISO_HORAS * 3600_000) {
      avisos.push(`#${id} ${c.descricao} — ${dataCurta(valida, deps.fuso)} (${nome})`);
    }
  }
  const ultima = novas[novas.length - 1];
  // Fato de grupo é de quem falou, e o grupo não é uma pessoa: memória só para conversa individual.
  if (!contato.grupo) {
    await repo.lembrar(db, jid, r.fatos);
    await repo.atualizarAguardando(db, jid, r.aguardando);
  }
  // Robô não espera resposta, nem quando a mensagem dele termina em pergunta.
  const sistema = contato.sistema || r.automatica;
  await repo.atualizarConversa(db, jid, {
    situacao: r.situacao,
    esperaResposta: r.precisa_resposta && !ultima.de_mim && !contato.grupo && !sistema,
    sugestoes: r.sugestoes,
    sistema: !contato.grupo && r.automatica,
  });
  await repo.marcarExtraidas(db, jid, ate);

  // Urgência não espera o resumo da manhã. Uma vez por mensagem, e só se a última
  // palavra for do outro: se o dono já respondeu, ele já viu.
  if (r.urgente && !ultima.de_mim && (await repo.alertaNovo(db, `urgente:${ultima.id}`))) {
    await deps.avisar(`⚡ *${nome}*${contato.grupo ? " (grupo)" : ""}: ${r.motivo_urgencia || "pede atenção"}\n> ${ultima.texto.slice(0, 300)}`);
  }
  // A reação ("que legal!") não entra na lista de pendências, mas a autonomia pode
  // respondê-la: é o contato que manda foto e novidade e espera só um retorno.
  if ((r.precisa_resposta || r.reacao) && !contato.grupo && !sistema && !ultima.de_mim && deps.aoPrecisarResposta) {
    await deps.aoPrecisarResposta(jid);
  }

  if (avisos.length) {
    await deps.avisar(
      `Anotei para os próximos dias:\n${avisos.join("\n")}\n\n_confirma N · feito N · ignora N_`,
    );
  }
}

/**
 * Conversas que já existiam antes da leitura de situação (ou vieram do histórico do
 * pareamento): lê o fim de cada uma só para saber onde está e se alguém espera o dono.
 * Não cria compromisso nem aviso: o que era para avisar já passou.
 */
export async function lerSituacoesPendentes(deps: DepsExtracao, limite = 40): Promise<number> {
  const r = await deps.db.query<{ jid: string }>(
    `SELECT c.jid FROM contatos c
     JOIN LATERAL (SELECT max(enviada_em) AS ultima FROM mensagens WHERE chat_jid = c.jid) u ON TRUE
     WHERE NOT c.excluido AND NOT c.grupo AND c.situacao = '' AND u.ultima > now() - interval '14 days'
     ORDER BY u.ultima DESC LIMIT $1`,
    [limite],
  );
  let lidas = 0;
  for (const { jid } of r.rows) {
    try {
      const contato = await repo.lerContato(deps.db, jid);
      if (!contato || contato.excluido) continue;
      const msgs = await repo.ultimasMensagens(deps.db, jid, 20);
      if (!msgs.length) continue;
      const nome = repo.nomeDe(contato);
      const ultima = msgs[msgs.length - 1];
      const x = await deps.ia.extrair({
        agora: agoraPorExtenso(deps.agora?.() ?? new Date(), deps.fuso),
        dono: deps.dono,
        contato: nome,
        grupo: false,
        memoria: repo.fichaEmTexto(contato),
        licoes: await repo.licoesDeLeitura(deps.db),
        anteriores: linhas(msgs.slice(0, -1), deps.dono, nome, deps.fuso),
        novas: linhas([ultima], deps.dono, nome, deps.fuso),
      });
      const sistema = contato.sistema || x.automatica;
      await repo.atualizarConversa(deps.db, jid, {
        // Sem nada em andamento, marca assim mesmo: senão a mesma conversa volta toda vez.
        situacao: x.situacao || "nada em andamento",
        esperaResposta: x.precisa_resposta && !ultima.de_mim && !sistema && !semConteudo(ultima),
        sugestoes: x.sugestoes,
        sistema: x.automatica,
      });
      lidas++;
    } catch (err) {
      deps.log?.({ err: String(err), jid }, "leitura de situação falhou");
    }
  }
  return lidas;
}
