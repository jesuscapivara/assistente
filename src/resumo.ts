import type { Db } from "./db.js";
import { eventoEmTexto } from "./ferramentas_google.js";
import { dataCurta, relogio } from "./formato.js";
import type { Email, Evento, Google } from "./google.js";
import type { Ia } from "./ia.js";
import { diaMes, koreosDoDia, type KoreosDireto, type KoreosDoDia } from "./koreos.js";
import * as repo from "./repo.js";

export interface DepsResumo {
  db: Db;
  ia: Ia;
  dono: string;
  fuso: string;
  google?: Google;
  /** KoreOS lido direto, sem modelo (tarefas e contas do dia). */
  koreosDireto?: KoreosDireto;
}

/** Tudo que o dia tem, já lido do banco, da agenda e do Gmail. Texto e cartão saem daqui. */
export interface Dia {
  agora: Date;
  eventosHoje: Evento[];
  eventosAmanha: Evento[];
  comData: repo.Compromisso[];
  semData: repo.Compromisso[];
  esperando: Awaited<ReturnType<typeof repo.esperandoResposta>>;
  datas: Awaited<ReturnType<typeof repo.datasProximas>>;
  emails: Email[];
  resolvidos: { descricao: string; contato: string; quando: Date }[];
  koreos: KoreosDoDia | null;
}

/** Meia-noite de hoje no fuso do dono, como instante. */
function inicioDoDia(agora: Date, fuso: string): Date {
  const { hora } = relogio(agora, fuso);
  const [h, m] = hora.split(":").map(Number);
  return new Date(agora.getTime() - (h * 60 + m) * 60_000 - agora.getUTCSeconds() * 1000 - agora.getUTCMilliseconds());
}

export async function coletarDia(deps: DepsResumo, agora = new Date()): Promise<Dia> {
  const compromissos = await repo.compromissosAbertos(deps.db, new Date(agora.getTime() + 48 * 3600_000));
  const hoje0 = inicioDoDia(agora, deps.fuso);
  const amanha0 = new Date(hoje0.getTime() + 24 * 3600_000);
  const depois0 = new Date(hoje0.getTime() + 48 * 3600_000);

  let eventosHoje: Evento[] = [];
  let eventosAmanha: Evento[] = [];
  let emails: Email[] = [];
  if (deps.google) {
    const evs = await deps.google.eventos(hoje0, depois0).catch(() => [] as Evento[]);
    eventosHoje = evs.filter((e) => e.inicio < amanha0);
    eventosAmanha = evs.filter((e) => e.inicio >= amanha0);
    // Só a caixa principal: promoção e rede social não pedem nada de ninguém.
    emails = await deps.google.emails("in:inbox is:unread category:primary newer_than:2d", 8).catch(() => [] as Email[]);
  }
  const { dia } = relogio(agora, deps.fuso);
  const [ano, mes, d] = dia.split("-").map(Number);
  // KoreOS fora do ar não pode segurar o resumo: sai sem a parte dele.
  const koreos = deps.koreosDireto ? await koreosDoDia(deps.koreosDireto, dia).catch(() => null) : null;

  const resolvidos = (
    await deps.db.query<{ descricao: string; contato: string; quando: Date }>(
      `SELECT k.descricao, ${repo.NOME_SQL} AS contato, k.decidido_em AS quando
       FROM compromissos k JOIN contatos c ON c.jid = k.chat_jid
       WHERE k.status = 'feito' AND k.decidido_em > now() - interval '24 hours' AND NOT c.excluido
       UNION ALL
       SELECT 'Resposta enviada' AS descricao, ${repo.NOME_SQL} AS contato, r.decidido_em AS quando
       FROM rascunhos r JOIN contatos c ON c.jid = r.chat_jid
       WHERE r.status = 'enviado' AND r.decidido_em > now() - interval '24 hours' AND NOT c.excluido
       ORDER BY quando DESC LIMIT 6`,
    )
  ).rows;

  return {
    agora,
    eventosHoje,
    eventosAmanha,
    comData: compromissos.filter((c) => c.quando),
    semData: compromissos.filter((c) => !c.quando && c.responsavel !== "contato"),
    esperando: await repo.esperandoResposta(deps.db, 4),
    datas: await repo.datasProximas(deps.db, { ano, mes, dia: d }, 3),
    emails,
    resolvidos,
    koreos,
  };
}

/** Quem espera, com o que se sabe: a situação da conversa diz mais que a última frase. */
export function linhaDeEspera(e: Dia["esperando"][number], fuso: string): string {
  return `• *${e.nome}* (${dataCurta(new Date(e.quando), fuso)}): ${assuntoDe(e)}`;
}

export function assuntoDe(e: Dia["esperando"][number]): string {
  return e.situacao && e.situacao !== "nada em andamento" ? e.situacao : `"${e.ultima.slice(0, 120)}"`;
}

/**
 * A partir de quantos dias sem resposta a pessoa "ficou para trás". É o lembrete que o
 * Lucas mais valorizou (22/10/2026: a ligação para alguém que ele prometeu fazer uma
 * semana antes): sai sempre, em seção própria, montado dos dados e não da escolha do modelo.
 */
export const DIAS_PARA_TRAS = 3;

export function diasEsperando(e: { quando: Date }, agora: Date): number {
  return Math.floor((agora.getTime() - new Date(e.quando).getTime()) / 86400_000);
}

/** Quem espera há `DIAS_PARA_TRAS` dias ou mais, do mais antigo para o mais novo. */
export function ficouParaTras(dia: Pick<Dia, "esperando" | "agora">): Dia["esperando"] {
  return dia.esperando
    .filter((e) => diasEsperando(e, dia.agora) >= DIAS_PARA_TRAS)
    .sort((a, b) => new Date(a.quando).getTime() - new Date(b.quando).getTime());
}

/** Quem espera há menos tempo: o resto da lista. */
export function esperandoRecente(dia: Pick<Dia, "esperando" | "agora">): Dia["esperando"] {
  return dia.esperando.filter((e) => diasEsperando(e, dia.agora) < DIAS_PARA_TRAS);
}

/**
 * O resumo em texto, sem modelo: os dados já estão organizados e o modelo só podia
 * errar (foi ele que trocou nomes por "#81690412224708"). `refs` liga cada nome ao
 * jid, para o "responde o segundo" depois.
 */
export function resumoEmTexto(dia: Dia, dono: string, fuso: string): { texto: string; refs: string } {
  const blocos: string[] = [];
  const agora = dia.agora;
  if (dia.eventosHoje.length) blocos.push(`*Na agenda hoje*\n${dia.eventosHoje.map((e) => eventoEmTexto(e, fuso)).join("\n")}`);
  if (dia.datas.length) {
    blocos.push(
      "*Datas*\n" +
        dia.datas.map((x) => `🎂 ${x.faltam === 0 ? "hoje" : x.faltam === 1 ? "amanhã" : `em ${x.faltam} dias`}: ${x.descricao} — ${x.nome}`).join("\n"),
    );
  }
  if (dia.comData.length) {
    blocos.push(
      "*Compromissos (hoje e amanhã)*\n" +
        dia.comData
          .map((c) => {
            // O que o outro ficou de fazer não é tarefa do dono: aparece, mas dito assim.
            if (c.responsavel === "contato") {
              return `#${c.id} ${dataCurta(new Date(c.quando!), fuso)} — ${c.contato_nome ?? "?"} ficou de: ${c.descricao}`;
            }
            const atrasado = new Date(c.quando!) < agora ? " ⚠️ atrasado" : "";
            return `#${c.id} ${dataCurta(new Date(c.quando!), fuso)} — ${c.descricao} (${c.contato_nome ?? "?"})${atrasado}`;
          })
          .join("\n"),
    );
  }
  if (dia.semData.length) {
    blocos.push("*Promessas sem data*\n" + dia.semData.map((c) => `#${c.id} ${c.descricao} (${c.contato_nome ?? "?"})`).join("\n"));
  }
  const paraTras = ficouParaTras(dia);
  if (paraTras.length) {
    blocos.push("*Ficou para trás*\n" + paraTras.map((e) => `• *${e.nome}* (há ${diasEsperando(e, agora)} dias): ${assuntoDe(e)}`).join("\n"));
  }
  const recentes = esperandoRecente(dia);
  if (recentes.length) blocos.push("*Esperando resposta sua*\n" + recentes.map((e) => linhaDeEspera(e, fuso)).join("\n"));
  const k = dia.koreos;
  if (k && (k.tarefasHoje.length || k.tarefasAtrasadas.length || k.contasHoje.length || k.contasAtrasadas.length)) {
    blocos.push(
      "*No KoreOS*\n" +
        [
          ...k.tarefasHoje.map((t) => `• Vence hoje: ${t.titulo} (${t.projeto})`),
          ...k.tarefasAtrasadas.map((t) => `• Atrasada desde ${diaMes(t.prazo)}: ${t.titulo} (${t.projeto})`),
          ...k.contasHoje.map((l) => `• ${l.tipo === "RECEITA" ? "Receber" : "Pagar"} hoje: ${l.descricao} — ${l.valor}`),
          ...k.contasAtrasadas.map((l) => `• ${l.tipo === "RECEITA" ? "A receber" : "A pagar"} desde ${diaMes(l.data)}: ${l.descricao} — ${l.valor}`),
        ].join("\n"),
    );
  }
  if (dia.emails.length) {
    blocos.push("*E-mails não lidos*\n" + dia.emails.map((e) => `• ${remetente(e.de)}: ${e.assunto || "(sem assunto)"}`).join("\n"));
  }

  const saudacao = `Bom dia, ${dono}! (${diaPorExtenso(agora, fuso)})`;
  const texto = blocos.length ? `${saudacao}\n\n${blocos.join("\n\n")}\n\n_confirma N · feito N · ignora N_` : `${saudacao} Nada pendente por aqui hoje.`;
  const refs = dia.esperando.map((e) => `${e.nome} = ${e.jid}`).join("\n");
  return { texto, refs };
}

export async function montarResumo(deps: DepsResumo, agora = new Date()): Promise<{ texto: string; refs: string }> {
  return resumoEmTexto(await coletarDia(deps, agora), deps.dono, deps.fuso);
}

/** "Fernanda Moraes <f@x.com>" → "Fernanda Moraes". */
export function remetente(de: string): string {
  return de.replace(/<[^>]*>/, "").replace(/"/g, "").trim() || de;
}

/** "quinta, 22/10". */
export function diaPorExtenso(d: Date, fuso: string): string {
  const semana = new Intl.DateTimeFormat("pt-BR", { timeZone: fuso, weekday: "long" }).format(d).replace("-feira", "");
  const data = new Intl.DateTimeFormat("pt-BR", { timeZone: fuso, day: "2-digit", month: "2-digit" }).format(d);
  return `${semana}, ${data}`;
}
