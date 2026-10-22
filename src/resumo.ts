import type { Db } from "./db.js";
import { eventoEmTexto } from "./ferramentas_google.js";
import { dataCurta, relogio } from "./formato.js";
import type { Email, Evento, Google } from "./google.js";
import type { Ia } from "./ia.js";
import * as repo from "./repo.js";

export interface DepsResumo {
  db: Db;
  ia: Ia;
  dono: string;
  fuso: string;
  google?: Google;
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
  };
}

/** Quem espera, com o que se sabe: a situação da conversa diz mais que a última frase. */
export function linhaDeEspera(e: Dia["esperando"][number], fuso: string): string {
  const assunto = e.situacao && e.situacao !== "nada em andamento" ? e.situacao : `"${e.ultima.slice(0, 120)}"`;
  return `• *${e.nome}* (${dataCurta(new Date(e.quando), fuso)}): ${assunto}`;
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
            const atrasado = new Date(c.quando!) < agora ? " ⚠️ atrasado" : "";
            return `#${c.id} ${dataCurta(new Date(c.quando!), fuso)} — ${c.descricao} (${c.contato_nome ?? "?"})${atrasado}`;
          })
          .join("\n"),
    );
  }
  if (dia.semData.length) {
    blocos.push("*Promessas sem data*\n" + dia.semData.map((c) => `#${c.id} ${c.descricao} (${c.contato_nome ?? "?"})`).join("\n"));
  }
  if (dia.esperando.length) blocos.push("*Esperando resposta sua*\n" + dia.esperando.map((e) => linhaDeEspera(e, fuso)).join("\n"));
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
