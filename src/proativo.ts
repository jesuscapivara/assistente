import type { Db } from "./db.js";
import { eventoEmTexto } from "./ferramentas_google.js";
import { agoraPorExtenso, dataCurta, linhas, relogio } from "./formato.js";
import type { Evento, Google } from "./google.js";
import type { Ia } from "./ia.js";
import * as repo from "./repo.js";

export interface DepsProativo {
  db: Db;
  ia: Ia;
  dono: string;
  fuso: string;
  avisar(texto: string): Promise<void>;
  google?: Google;
  log?: (o: object, txt: string) => void;
}

/** Quem está numa reunião: convidados pelo nome/e-mail e nomes citados no título. */
async function pessoasDoEvento(db: Db, e: Evento): Promise<repo.Contato[]> {
  const termos = new Set<string>();
  for (const c of e.convidados) {
    if (c.nome) termos.add(c.nome);
    else if (c.email) termos.add(c.email.split("@")[0].replace(/[._]/g, " "));
  }
  // Palavras do título com cara de nome próprio ("Reunião com Fernanda Moraes").
  for (const p of e.titulo.split(/[\s,/–-]+/)) if (/^[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç]{3,}$/.test(p)) termos.add(p);
  const achados = new Map<string, repo.Contato>();
  for (const t of termos) {
    const lista = (await repo.buscarContatos(db, t, 2)).filter((c) => !c.excluido && !c.grupo);
    // Só quando o nome aponta para uma pessoa: dois "Pedro" não viram briefing de ninguém.
    if (lista.length === 1) achados.set(lista[0].jid, lista[0]);
  }
  return [...achados.values()];
}

/**
 * Briefing antes de cada reunião: quem é, onde a conversa parou, o que está combinado e
 * o que está pendente. Um por evento, `antecedenciaMin` antes.
 */
export async function briefings(deps: DepsProativo, antecedenciaMin: number, agora = new Date()): Promise<number> {
  if (!deps.google) return 0;
  const eventos = (await deps.google.eventos(agora, new Date(agora.getTime() + antecedenciaMin * 60_000))).filter(
    (e) => !e.diaInteiro && e.inicio > agora,
  );
  let feitos = 0;
  for (const e of eventos) {
    if (!(await repo.alertaNovo(deps.db, `briefing:${e.id}:${e.inicio.toISOString()}`))) continue;
    const pessoas = await pessoasDoEvento(deps.db, e);
    const blocos: string[] = [];
    for (const p of pessoas) {
      const nome = repo.nomeDe(p);
      const conversa = await repo.ultimasMensagens(deps.db, p.jid, 25);
      const comp = (await repo.compromissosAbertos(deps.db)).filter((k) => k.chat_jid === p.jid);
      blocos.push(
        [
          `## ${nome}`,
          repo.fichaEmTexto(p),
          comp.length ? `Combinados em aberto:\n${comp.map((k) => `- ${k.descricao}${k.quando ? ` (${dataCurta(new Date(k.quando), deps.fuso)})` : ""}`).join("\n")}` : "",
          conversa.length ? `Últimas mensagens:\n${linhas(conversa, deps.dono, nome, deps.fuso)}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
    let texto = "";
    if (blocos.length) {
      texto = await deps.ia
        .escrever({
          sistema: `Você prepara ${deps.dono} para uma reunião daqui a pouco, no WhatsApp. Curto: quem é, onde a conversa parou, o que ele prometeu, o que está pendente e um ponto de atenção. *Negrito* nos nomes. Só o que está nos dados.`,
          conteudo: `Agora: ${agoraPorExtenso(agora, deps.fuso)}\nREUNIÃO: ${eventoEmTexto(e, deps.fuso)}\n${e.descricao ? `Descrição: ${e.descricao}\n` : ""}\n${blocos.join("\n\n")}`,
          esforco: "low",
          peso: "leve",
          funcao: "briefing",
        })
        .catch(() => "");
    }
    const min = Math.max(1, Math.round((e.inicio.getTime() - agora.getTime()) / 60_000));
    await deps.avisar(`📅 Em ${min} min: *${e.titulo}*${e.local ? ` (${e.local})` : ""}\n\n${texto || (pessoas.length ? blocos.join("\n\n") : "Não achei essas pessoas nas conversas.")}`);
    feitos++;
  }
  return feitos;
}

/** Quem ficou de mandar algo e sumiu: pergunta se é para cobrar (uma vez por assunto). */
export async function cobrancas(deps: DepsProativo, dias: number): Promise<number> {
  const lista = await repo.paraCobrar(deps.db, dias);
  const novos: string[] = [];
  for (const c of lista) {
    if (!(await repo.alertaNovo(deps.db, `cobrar:${c.jid}:${new Date(c.aguardando_desde).toISOString()}`))) continue;
    const diasPassados = Math.floor((Date.now() - new Date(c.aguardando_desde).getTime()) / 86400_000);
    novos.push(`• *${repo.nomeDe(c)}* ficou de mandar ${c.aguardando} (há ${diasPassados} dias) — _cobra ${repo.nomeDe(c)}_`);
  }
  if (novos.length) await deps.avisar(`⏳ Esperando há um tempo:\n${novos.join("\n")}`);
  return novos.length;
}

/** No fim da tarde, o que era para hoje e ainda está aberto. */
export async function fimDoDia(deps: DepsProativo, agora = new Date()): Promise<number> {
  const { dia } = relogio(agora, deps.fuso);
  const abertos = (await repo.compromissosAbertos(deps.db, agora)).filter(
    (k) => k.quando && k.responsavel !== "contato" && relogio(new Date(k.quando), deps.fuso).dia === dia,
  );
  if (abertos.length) {
    await deps.avisar(
      `🕕 Ainda aberto de hoje:\n${abertos.map((k) => `#${k.id} ${k.descricao} (${k.contato_nome ?? "?"})`).join("\n")}\n\n_feito N · ignora N_`,
    );
  }
  return abertos.length;
}

/** Quanto tempo sem conversa já é sumiço, por tipo de relação. */
const SUMICO_DIAS: Record<string, number> = { cliente: 21, familia: 14, amigo: 30 };

/** Pessoas importantes com quem o dono costumava falar e parou. */
export async function radar(db: Db): Promise<{ nome: string; relacao: string; dias: number }[]> {
  const r = await db.query<{ nome: string; relacao: string; ultima: Date; total: number }>(
    `SELECT ${repo.NOME_SQL} AS nome, c.relacao,
            max(m.enviada_em) AS ultima, count(*)::int AS total
     FROM contatos c JOIN mensagens m ON m.chat_jid = c.jid
     WHERE NOT c.excluido AND NOT c.grupo AND NOT c.sistema AND c.relacao IN ('cliente', 'familia', 'amigo')
     GROUP BY c.jid, c.nome, c.nome_push, c.relacao
     HAVING count(*) >= 10`,
  );
  return r.rows
    .map((x) => ({ nome: x.nome, relacao: x.relacao, dias: Math.floor((Date.now() - new Date(x.ultima).getTime()) / 86400_000) }))
    .filter((x) => x.dias >= SUMICO_DIAS[x.relacao])
    .sort((a, b) => b.dias - a.dias)
    .slice(0, 8);
}

/** Domingo à tarde: a semana que passou e a que vem. */
export async function revisaoSemanal(deps: DepsProativo, agora = new Date()): Promise<void> {
  const semana = new Date(agora.getTime() - 7 * 86400_000);
  const feitos = await deps.db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM compromissos WHERE status = 'feito' AND criado_em > $1",
    [semana],
  );
  const atrasados = (await repo.compromissosAbertos(deps.db, agora)).filter((k) => k.quando && k.responsavel !== "contato");
  const enviados = await deps.db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM rascunhos WHERE status = 'enviado' AND decidido_em > $1",
    [semana],
  );
  const esperando = await repo.esperandoResposta(deps.db, 24);
  const sumidos = await radar(deps.db);
  const { dia } = relogio(agora, deps.fuso);
  const [ano, mes, d] = dia.split("-").map(Number);
  const datas = await repo.datasProximas(deps.db, { ano, mes, dia: d }, 7);
  let proxima = "";
  if (deps.google) {
    const evs = await deps.google.eventos(agora, new Date(agora.getTime() + 7 * 86400_000)).catch(() => []);
    proxima = evs.map((e) => eventoEmTexto(e, deps.fuso)).join("\n");
  }

  const dados = [
    `Compromissos cumpridos na semana: ${feitos.rows[0].n}`,
    `Respostas enviadas pelo assistente: ${enviados.rows[0].n}`,
    atrasados.length ? `Atrasados:\n${atrasados.map((k) => `#${k.id} ${k.descricao} (${k.contato_nome ?? "?"})`).join("\n")}` : "",
    esperando.length ? `Esperando resposta dele há mais de 1 dia:\n${esperando.map((e) => `${e.nome}: ${e.situacao || `"${e.ultima.slice(0, 80)}"`}`).join("\n")}` : "",
    sumidos.length ? `Faz tempo que não fala com:\n${sumidos.map((x) => `${x.nome} (${x.relacao}, ${x.dias} dias)`).join("\n")}` : "",
    datas.length ? `Datas da semana:\n${datas.map((x) => `${String(x.dia).padStart(2, "0")}/${String(x.mes).padStart(2, "0")} ${x.descricao} — ${x.nome}`).join("\n")}` : "",
    proxima ? `Agenda da próxima semana:\n${proxima}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const texto = await deps.ia
    .escrever({
      sistema: `Você faz a revisão semanal de ${deps.dono} no WhatsApp, domingo à tarde. Curta e útil: o que travou, o que pede atenção na semana que vem, quem ele deveria procurar. *Negrito* nos títulos. Mantenha os #N. Só o que está nos dados.`,
      conteudo: `Agora: ${agoraPorExtenso(agora, deps.fuso)}\n\n${dados}`,
      esforco: "low",
      peso: "leve",
      funcao: "revisao_semanal",
    })
    .catch(() => "");
  await deps.avisar(`🗓️ *Revisão da semana*\n\n${texto || dados}`);
}
