import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { planoDoCartao, relevo } from "./cartao.js";
import { custoPorDia, dolar, resumoDeCusto } from "./consumo.js";
import { lerEstado, type Db } from "./db.js";
import { dataCurta, relogio } from "./formato.js";
import { diaMes } from "./koreos.js";
import { lerCaderno } from "./memoria.js";
import type { Acao, Item, TipoItem } from "./pauta.js";
import * as repo from "./repo.js";
import { assuntoDe, coletarDia, diasEsperando, DIAS_PARA_TRAS, esperandoRecente, ficouParaTras, remetente, type Dia, type DepsResumo } from "./resumo.js";

/**
 * O painel, com quatro abas: Hoje (o dia em linha do tempo e o que precisa do dono),
 * Conversas (quem espera, e a conversa aberta), Pessoas (a ficha de cada uma) e
 * Assistente (perguntar, gasto, caderno, lições). Páginas geradas no servidor, sem
 * JavaScript: os botões são formulários, as abas são links. Nenhuma tela chama modelo;
 * só "Perguntar" e "Escrever rascunho", e só quando usados.
 *
 * O acesso é o token no caminho (PAINEL_TOKEN), e o endereço só existe dentro da rede
 * do Tailscale do dono: nenhuma porta pública na VM.
 */

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export type Aba = "hoje" | "conversas" | "pessoas" | "assistente";

export interface ConsultaPainel {
  aba?: string;
  /** Conversa aberta (jid). */
  c?: string;
  /** E-mail aberto (id do Gmail). */
  m?: string;
  /** Ficha aberta (jid). */
  p?: string;
  /** Busca de pessoas. */
  q?: string;
  /** Filtro da lista. */
  f?: string;
}

export interface OpcoesPainel {
  fuso: string;
  dono: string;
  niveis: string[];
  padrao: number;
}

interface Ctx {
  base: string;
  /** A página atual, para voltar a ela depois de um botão. */
  volta: string;
  fuso: string;
  agora: Date;
}

// ── peças ────────────────────────────────────────────────────────────────────

let fraunces: string | null = null;
function fonteDaManchete(): string {
  if (fraunces !== null) return fraunces;
  try {
    const req = createRequire(import.meta.url);
    const arq = path.join(path.dirname(req.resolve("@fontsource/fraunces/package.json")), "files", "fraunces-latin-600-normal.woff2");
    fraunces = readFileSync(arq).toString("base64");
  } catch {
    fraunces = "";
  }
  return fraunces;
}

const CORES = ["#8A6FB0", "#5B7F5E", "#3E6D8E", "#C69B3F", "#9A6B5B", "#6F8EA6", "#7A8450", "#A35D7A"];
function avatar(nome: string, grande = false): string {
  const limpo = nome.replace(/[^\p{L}\s]/gu, " ").trim();
  const partes = limpo.split(/\s+/).filter(Boolean);
  const ini = (partes.length > 1 ? partes[0][0] + partes[partes.length - 1][0] : (partes[0] ?? "?").slice(0, 2)).toUpperCase();
  let h = 0;
  for (const ch of nome) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `<span class="av${grande ? " g" : ""}" style="background:${CORES[h % CORES.length]}">${esc(ini)}</span>`;
}

function link(base: string, q: Record<string, string | undefined>): string {
  const s = new URLSearchParams(Object.entries(q).filter((x): x is [string, string] => Boolean(x[1]))).toString();
  return `${base}${s ? `?${s}` : ""}`;
}

function form(ctx: Ctx, campos: Record<string, string | number | undefined>, corpo: string, classe = "acoes"): string {
  const ocultos = Object.entries({ ...campos, volta: ctx.volta })
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  return `<form method="post" action="${esc(ctx.base)}/acao" class="${classe}">${ocultos}${corpo}</form>`;
}

const ADIAR = ["amanhã", "depois de amanhã", "sábado", "segunda", "semana que vem"];

/**
 * Resolvi · Adiar ▾ · Ignorar. O "Adiar" abre as datas num menu (sem JavaScript: um
 * `details` com um botão por data), para a linha caber na largura do celular.
 * `destaque`: o Resolvi vai em laranja só quando não há outra ação principal no cartão.
 */
function botoesDePendencia(
  ctx: Ctx,
  alvo: { tipo: TipoItem; jid?: string; compromissoId?: number; emailId?: string; titulo: string },
  rotulo = "Resolvi",
  opcoes: { semIgnorar?: boolean; destaque?: boolean } = {},
): string {
  const campos = { acao: "pendencia", tipo: alvo.tipo, jid: alvo.jid, compromissoId: alvo.compromissoId, emailId: alvo.emailId, titulo: alvo.titulo };
  const resolver = form(
    ctx,
    campos,
    `<button name="verbo" value="resolvi"${opcoes.destaque === false ? "" : ' class="p"'}>${esc(rotulo)}</button>${opcoes.semIgnorar ? "" : `<button name="verbo" value="ignora">Ignorar</button>`}`,
    "inline",
  );
  const adiar = `<details class="menu"><summary class="btn">Adiar</summary><div>${form(
    ctx,
    { ...campos, verbo: "adia" },
    ADIAR.map((q) => `<button name="quando" value="${esc(q)}">${esc(q)}</button>`).join(""),
    "opcoes",
  )}</div></details>`;
  return `<span class="pend">${resolver}${adiar}</span>`;
}

/** Atalhos de resposta: cada um vira o pedido de um rascunho na voz do dono. */
function sugestoes(ctx: Ctx, jid: string, xs: string[]): string {
  if (!xs.length) return "";
  return `<div class="sugest">${xs
    .map((s) => form(ctx, { acao: "responder", jid, instrucao: s }, `<button class="chip s">${esc(s)}</button>`, "inline"))
    .join("")}</div>`;
}

function bolhas(msgs: repo.Mensagem[], fuso: string): string {
  if (!msgs.length) return "";
  return `<div class="bolhas">${msgs
    .map((m) => `<span class="bb${m.de_mim ? " eu" : ""}">${esc((m.texto || `[${m.tipo}]`).slice(0, 400))}<i>${esc(dataCurta(new Date(m.enviada_em), fuso))}</i></span>`)
    .join("")}</div>`;
}

function topo(rotulo: string, manchete: string, extra = ""): string {
  return `<div class="topo"><p class="data">${esc(rotulo)}</p><h1 class="manchete">${esc(manchete)}</h1>${extra}</div>`;
}

function h2(titulo: string, nota?: string | number): string {
  return `<h2>${esc(titulo)}${nota !== undefined && nota !== "" ? ` <small>${esc(nota)}</small>` : ""}</h2>`;
}

function hora(d: Date, fuso: string): string {
  return relogio(d, fuso).hora;
}

// ── Hoje ─────────────────────────────────────────────────────────────────────

async function mancheteDoDia(db: Db, dia: Dia, dono: string, fuso: string): Promise<string> {
  try {
    const salva = JSON.parse((await lerEstado(db, "manchete")) ?? "null") as { dia: string; texto: string } | null;
    // A frase escrita pelo modelo no resumo da manhã vale o dia inteiro.
    if (salva && salva.dia === relogio(dia.agora, fuso).dia && salva.texto) return salva.texto;
  } catch {
    // estado corrompido: fica a frase montada dos dados
  }
  return (await planoDoCartao(null, dia, dono, fuso)).manchete;
}

interface Marco {
  quando: Date | null;
  titulo: string;
  sub: string;
  ponto: "evento" | "promessa" | "espera" | "prazo";
  passou?: boolean;
}

function linhaDoDia(dia: Dia, fuso: string): Marco[] {
  const hoje = relogio(dia.agora, fuso).dia;
  const ehHoje = (d: Date) => relogio(d, fuso).dia === hoje;
  const marcos: Marco[] = [
    ...dia.eventosHoje
      .filter((e) => !e.diaInteiro)
      .map((e) => ({
        quando: e.inicio,
        titulo: e.titulo,
        sub: [e.fim < dia.agora ? "feita" : "", e.meetLink ? "Meet" : e.local, e.convidados.length ? `com ${e.convidados.map((c) => c.nome || c.email.split("@")[0]).slice(0, 3).join(", ")}` : ""]
          .filter(Boolean)
          .join(" · "),
        ponto: "evento" as const,
        passou: e.fim < dia.agora,
      })),
    ...dia.comData
      .filter((k) => k.responsavel !== "contato" && ehHoje(new Date(k.quando!)))
      .map((k) => ({ quando: new Date(k.quando!), titulo: k.descricao, sub: `Promessa sua · ${k.contato_nome ?? ""} · #${k.id}`, ponto: "promessa" as const })),
    ...dia.esperando
      .filter((e) => ehHoje(new Date(e.quando)))
      .map((e) => ({ quando: new Date(e.quando), titulo: `${e.nome} espera resposta`, sub: "WhatsApp · ainda sem resposta", ponto: "espera" as const })),
    ...(dia.koreos?.tarefasHoje ?? []).map((t) => ({ quando: null, titulo: `Prazo: ${t.titulo}`, sub: `${t.projeto} · KoreOS`, ponto: "prazo" as const })),
  ];
  return marcos.sort((a, b) => (a.quando?.getTime() ?? Infinity) - (b.quando?.getTime() ?? Infinity));
}

function desenharLinha(marcos: Marco[], ctx: Ctx): string {
  if (!marcos.length) return `<p class="vazio">Nada marcado para hoje.</p>`;
  let marcouAgora = false;
  const linhas: string[] = [];
  const marcaAgora = `<li class="agoraLinha"><span>agora ${esc(hora(ctx.agora, ctx.fuso))}</span></li>`;
  for (const m of marcos) {
    if (!marcouAgora && (!m.quando || m.quando > ctx.agora)) {
      linhas.push(marcaAgora);
      marcouAgora = true;
    }
    linhas.push(
      `<li${m.passou ? ' class="passou"' : ""}><span class="h">${m.quando ? esc(hora(m.quando, ctx.fuso)) : "hoje"}</span><span class="d ${m.ponto}"></span><span class="t"><b>${esc(m.titulo)}</b>${m.sub ? `<p>${esc(m.sub)}</p>` : ""}</span></li>`,
    );
  }
  if (!marcouAgora) linhas.push(marcaAgora);
  return `<ul class="tl">${linhas.join("")}</ul>`;
}

/** O que vem a seguir nas próximas 3 horas: promessa sua ou reunião. */
function proximo(dia: Dia, ctx: Ctx): string {
  const limite = ctx.agora.getTime() + 3 * 3600_000;
  const promessa = dia.comData
    .filter((k) => k.responsavel !== "contato" && new Date(k.quando!) > ctx.agora && new Date(k.quando!).getTime() <= limite)
    .sort((a, b) => new Date(a.quando!).getTime() - new Date(b.quando!).getTime())[0];
  const evento = dia.eventosHoje
    .filter((e) => !e.diaInteiro && e.inicio > ctx.agora && e.inicio.getTime() <= limite)
    .sort((a, b) => a.inicio.getTime() - b.inicio.getTime())[0];
  const usarEvento = Boolean(evento && (!promessa || evento.inicio < new Date(promessa.quando!)));
  const quando = usarEvento ? evento!.inicio : promessa ? new Date(promessa.quando!) : null;
  if (!quando) return "";
  const min = Math.max(1, Math.round((quando.getTime() - ctx.agora.getTime()) / 60_000));
  const em = min >= 60 ? `EM ${Math.floor(min / 60)}H${min % 60 ? String(min % 60).padStart(2, "0") : ""}` : `EM ${min} MIN`;
  if (usarEvento) {
    const e = evento!;
    return `<div class="agora"><div><span class="em">${em} · ${esc(hora(quando, ctx.fuso))}</span><b>${esc(e.titulo)}</b><span class="sub">${esc([e.local, e.convidados.length ? `${e.convidados.length} convidados` : ""].filter(Boolean).join(" · "))}</span></div>${e.meetLink ? `<a class="btn p" href="${esc(e.meetLink)}">Entrar</a>` : ""}</div>`;
  }
  const p = promessa!;
  const rotulo = /ligar|liga[çc][aã]o|telefon/i.test(p.descricao) ? "Liguei" : "Feito";
  return `<div class="agora"><div><span class="em">${em} · ${esc(hora(quando, ctx.fuso))}</span><b>${esc(p.descricao)}</b><span class="sub">Promessa sua · ${esc(p.contato_nome ?? "")}</span></div>${form(ctx, { acao: "pendencia", tipo: "compromisso", compromissoId: p.id, jid: p.chat_jid, titulo: p.descricao, verbo: "resolvi" }, `<button class="p">${rotulo}</button>`, "inline")}</div>`;
}

async function cartaoDeEspera(db: Db, ctx: Ctx, e: Dia["esperando"][number], paraTras: boolean): Promise<string> {
  const c = await repo.lerContato(db, e.jid);
  const msgs = await repo.ultimasMensagens(db, e.jid, 3);
  const dias = diasEsperando(e, ctx.agora);
  const abrir = link(ctx.base, { aba: "conversas", c: e.jid });
  return `<div class="card"><div class="cab">${avatar(e.nome)}<a class="nome" href="${esc(abrir)}">${esc(e.nome)}</a>${c?.relacao ? `<span class="tag">${esc(c.relacao)}</span>` : ""}<span class="meta">${paraTras ? `<span class="tag a">há ${dias} dias</span>` : esc(dataCurta(new Date(e.quando), ctx.fuso))}</span></div>
<p class="sit">${esc(assuntoDe(e))}</p>
${bolhas(msgs, ctx.fuso)}
${sugestoes(ctx, e.jid, c ? repo.sugestoesDe(c) : [])}
<div class="linhaAcoes"><a class="btn p" href="${esc(abrir)}">Responder</a>${botoesDePendencia(ctx, { tipo: "espera", jid: e.jid, titulo: e.nome }, paraTras ? "Liguei" : "Resolvi", { destaque: false })}</div></div>`;
}

async function abaHoje(deps: DepsResumo, ctx: Ctx, opts: OpcoesPainel): Promise<string> {
  const { db } = deps;
  const dia = await coletarDia(deps, ctx.agora);
  const manchete = await mancheteDoDia(db, dia, opts.dono, opts.fuso);
  const rascunhos = await rascunhosAguardando(db);

  const doDono = [...dia.comData, ...dia.semData].filter((k) => k.responsavel !== "contato");
  const doOutro = dia.comData.filter((k) => k.responsavel === "contato");
  const paraTras = ficouParaTras(dia);
  const k = dia.koreos;

  const cartoesCompromisso = doDono.map(
    (c) => `<div class="card"><div class="cab">${avatar(c.contato_nome ?? "?")}<b>${esc(c.descricao)}</b><span class="meta">${c.quando ? esc(dataCurta(new Date(c.quando), ctx.fuso)) : "sem data"}</span></div>
<p class="sit">${esc(c.contato_nome ?? "")} · #${c.id}${c.quando && new Date(c.quando) < ctx.agora ? " · atrasado" : ""}</p>
${botoesDePendencia(ctx, { tipo: "compromisso", compromissoId: c.id, jid: c.chat_jid, titulo: c.descricao }, /ligar|liga[çc][aã]o/i.test(c.descricao) ? "Liguei" : "Feito")}</div>`,
  );
  const cartoesEspera = await Promise.all(esperandoRecente(dia).map((e) => cartaoDeEspera(db, ctx, e, false)));
  const cartoesEmail = dia.emails.map(
    (m) => `<div class="card"><div class="cab">${avatar("E " + remetente(m.de))}<a class="nome" href="${esc(link(ctx.base, { aba: "conversas", m: m.id }))}">${esc(m.assunto || "(sem assunto)")}</a><span class="meta">${esc(dataCurta(m.data, ctx.fuso))}</span></div>
<p class="sit">E-mail de ${esc(remetente(m.de))}. ${esc(m.trecho.slice(0, 180))}</p>${botoesDePendencia(ctx, { tipo: "email", emailId: m.id, titulo: m.assunto }, "Resolvi")}</div>`,
  );
  const precisa = [...cartoesCompromisso, ...cartoesEspera, ...cartoesEmail];
  const totalKoreos = k ? k.tarefasHoje.length + k.tarefasAtrasadas.length + k.contasHoje.length + k.contasAtrasadas.length : 0;

  return `${topo(new Intl.DateTimeFormat("pt-BR", { timeZone: opts.fuso, weekday: "long", day: "2-digit", month: "2-digit" }).format(dia.agora), manchete, relevo(dia, opts.fuso).replace("<svg ", '<svg class="relevo" '))}
${proximo(dia, ctx)}
<div class="wrap">
${rascunhos.length ? `${h2("Esperando sua aprovação", rascunhos.length)}${rascunhos.map((r) => cartaoDeRascunho(ctx, r)).join("")}` : ""}
${h2("Linha do dia")}${desenharLinha(linhaDoDia(dia, opts.fuso), ctx)}
${h2("Precisa de você", precisa.length || "")}${precisa.length ? precisa.join("") : `<p class="vazio">Nada precisa de você agora.</p>`}
${paraTras.length ? `${h2("Ficou para trás", `há ${DIAS_PARA_TRAS}+ dias`)}${(await Promise.all(paraTras.map((e) => cartaoDeEspera(db, ctx, e, true)))).join("")}` : ""}
${
  doOutro.length
    ? `${h2("Os outros ficaram de")}<ul class="lista">${doOutro
        .map(
          (c) =>
            `<li>${avatar(c.contato_nome ?? "?")}<div class="n"><b>${esc(c.descricao)}</b><p>${esc(c.contato_nome ?? "")} · ${esc(dataCurta(new Date(c.quando!), ctx.fuso))}</p></div>${form(ctx, { acao: "pendencia", tipo: "compromisso", compromissoId: c.id, jid: c.chat_jid, titulo: c.descricao, verbo: "resolvi" }, `<button>Chegou</button>`, "inline")}</li>`,
        )
        .join("")}</ul>`
    : ""
}
${
  k
    ? `${h2("Escritório", "KoreOS")}<div class="mini"><div><b>${k.tarefasHoje.length}</b><span>vence hoje</span></div><div><b>${k.tarefasAtrasadas.length}</b><span>atrasadas</span></div><div><b>${k.contasHoje.length + k.contasAtrasadas.length}</b><span>contas pendentes</span></div></div>
${
  totalKoreos
    ? `<details><summary>Ver no detalhe</summary><ul class="lista">${[
        ...k.tarefasHoje.map((t) => `<li><div class="n"><b>${esc(t.titulo)}</b><p>${esc(t.projeto)} · vence hoje · ${esc(t.status)}</p></div></li>`),
        ...k.tarefasAtrasadas.map((t) => `<li><div class="n"><b>${esc(t.titulo)}</b><p>${esc(t.projeto)} · atrasada desde ${esc(diaMes(t.prazo))}</p></div></li>`),
        ...[...k.contasHoje, ...k.contasAtrasadas].map(
          (l) => `<li><div class="n"><b>${esc(l.tipo === "RECEITA" ? "Receber" : "Pagar")} ${esc(l.valor)}</b><p>${esc(l.descricao)} · ${esc(diaMes(l.data))}</p></div></li>`,
        ),
      ].join("")}</ul></details>`
    : ""
}`
    : ""
}
${dia.resolvidos.length ? `${h2("Resolvido", "24 h")}<ul class="lista">${dia.resolvidos.map((r) => `<li><div class="n"><b>${esc(r.descricao)}</b><p>${esc(r.contato)} · ${esc(dataCurta(new Date(r.quando), ctx.fuso))}</p></div></li>`).join("")}</ul>` : ""}
</div>`;
}

// ── Rascunhos (Hoje e conversa) ──────────────────────────────────────────────

interface RascunhoTela {
  id: number;
  chat_jid: string;
  texto: string;
  enviar_em: Date | null;
  risco: string | null;
  motivo_risco: string;
  nome: string;
}

async function rascunhosAguardando(db: Db, jid?: string): Promise<RascunhoTela[]> {
  return (
    await db.query<RascunhoTela>(
      `SELECT r.id, r.chat_jid, r.texto, r.enviar_em, r.risco, r.motivo_risco, ${repo.NOME_SQL} AS nome
       FROM rascunhos r JOIN contatos c ON c.jid = r.chat_jid
       WHERE r.status = 'aguardando' AND ($1::text IS NULL OR r.chat_jid = $1) ORDER BY r.id DESC`,
      [jid ?? null],
    )
  ).rows;
}

function cartaoDeRascunho(ctx: Ctx, r: RascunhoTela): string {
  return `<div class="card rasc"><div class="cab">${avatar(r.nome)}<b>Para ${esc(r.nome)}</b><span class="meta">#${r.id}</span></div>
<div class="bolhas"><span class="bb eu">${esc(r.texto)}</span></div>
${r.enviar_em ? `<p class="nota">Sai sozinho às ${esc(hora(new Date(r.enviar_em), ctx.fuso))} se você não vetar.</p>` : ""}${r.risco === "alto" ? `<p class="nota">${esc(r.motivo_risco || "Precisa do seu ok.")}</p>` : ""}
<div class="linhaAcoes">${form(ctx, { acao: "enviar", id: r.id }, `<button class="p">Enviar</button>`, "inline")}${form(ctx, { acao: "descartar", id: r.id }, `<button>Descartar</button>`, "inline")}</div>
<details><summary>Ajustar</summary>${form(ctx, { acao: "ajustar", id: r.id }, `<textarea name="instrucao" rows="2" placeholder="Ex.: mais curto, sem emoji"></textarea><button class="p">Refazer</button>`, "coluna")}</details></div>`;
}

// ── Conversas ────────────────────────────────────────────────────────────────

interface LinhaConversa {
  jid: string;
  nome: string;
  espera_resposta: boolean;
  texto: string;
  de_mim: boolean;
  enviada_em: Date;
}

async function listaDeConversas(db: Db, filtro: string): Promise<LinhaConversa[]> {
  const cond =
    filtro === "grupos"
      ? "c.grupo"
      : filtro === "todas"
        ? "NOT c.grupo"
        : "c.espera_resposta AND NOT c.grupo AND NOT c.sistema AND (c.adiado_ate IS NULL OR c.adiado_ate <= now())";
  return (
    await db.query<LinhaConversa>(
      `SELECT c.jid, ${repo.NOME_SQL} AS nome, c.espera_resposta, u.texto, u.de_mim, u.enviada_em
       FROM contatos c
       JOIN LATERAL (SELECT texto, de_mim, enviada_em FROM mensagens WHERE chat_jid = c.jid ORDER BY enviada_em DESC LIMIT 1) u ON TRUE
       WHERE NOT c.excluido AND ${cond}
       ORDER BY u.enviada_em DESC LIMIT 60`,
    )
  ).rows;
}

async function abaConversas(deps: DepsResumo, ctx: Ctx, consulta: ConsultaPainel): Promise<string> {
  const { db } = deps;
  if (consulta.c) return conversaAberta(db, ctx, consulta.c);
  if (consulta.m) return emailAberto(deps, ctx, consulta.m);

  const f = ["esperando", "todas", "email", "grupos"].includes(consulta.f ?? "") ? consulta.f! : "esperando";
  const esperando = await repo.esperandoResposta(db, 0, 99);
  const emails = f === "email" && deps.google ? ((await coletarDia(deps, ctx.agora).catch(() => null))?.emails ?? []) : [];
  const filtros = [
    ["esperando", `Esperando (${esperando.length})`],
    ["todas", "Todas"],
    ["email", "E-mail"],
    ["grupos", "Grupos"],
  ]
    .map(([v, r]) => `<a class="chip${f === v ? " on" : ""}" href="${esc(link(ctx.base, { aba: "conversas", f: v }))}">${esc(r)}</a>`)
    .join("");

  let lista: string;
  if (f === "email") {
    lista = emails.length
      ? `<ul class="lista">${emails
          .map(
            (m) =>
              `<li>${avatar("E " + remetente(m.de))}<a class="n" href="${esc(link(ctx.base, { aba: "conversas", m: m.id }))}"><b>${esc(remetente(m.de))}</b><p>${esc(m.assunto)}</p></a><div class="r">${esc(dataCurta(m.data, ctx.fuso))}<br><span class="ponto"></span></div></li>`,
          )
          .join("")}</ul>`
      : `<p class="vazio">${deps.google ? "Nenhum e-mail não lido na caixa principal." : "O Google não está ligado."}</p>`;
  } else {
    const linhas = await listaDeConversas(db, f);
    lista = linhas.length
      ? `<ul class="lista">${linhas
          .map((x) => {
            const dias = Math.floor((ctx.agora.getTime() - new Date(x.enviada_em).getTime()) / 86400_000);
            const marca = x.espera_resposta && !x.de_mim ? (dias >= DIAS_PARA_TRAS ? `<span class="tag a">${dias}d</span>` : `<span class="ponto"></span>`) : "";
            const quando = dias === 0 ? hora(new Date(x.enviada_em), ctx.fuso) : diaMes(relogio(new Date(x.enviada_em), ctx.fuso).dia);
            return `<li>${avatar(x.nome)}<a class="n" href="${esc(link(ctx.base, { aba: "conversas", c: x.jid }))}"><b>${esc(x.nome)}</b><p>${x.de_mim ? "Você: " : ""}${esc((x.texto || "").slice(0, 90))}</p></a><div class="r">${esc(quando)}<br>${marca}</div></li>`;
          })
          .join("")}</ul>`
      : `<p class="vazio">${f === "esperando" ? "Ninguém esperando você." : "Nada por aqui."}</p>`;
  }
  const n = esperando.length;
  return `${topo("Conversas", n ? `${n} ${n === 1 ? "espera" : "esperam"} você.` : "Ninguém esperando você.")}
<div class="wrap"><div class="filtros">${filtros}</div>${lista}</div>`;
}

async function conversaAberta(db: Db, ctx: Ctx, jidBruto: string): Promise<string> {
  const c = await repo.lerContato(db, await repo.resolverJid(db, jidBruto));
  const voltar = `<a class="voltar" href="${esc(link(ctx.base, { aba: "conversas" }))}">‹ Conversas</a>`;
  if (!c || c.excluido) return `<div class="wrap">${voltar}<p class="vazio">Essa conversa não está no assistente.</p></div>`;
  const nome = repo.nomeDe(c);
  const msgs = await repo.ultimasMensagens(db, c.jid, 50);
  const rascunhos = await rascunhosAguardando(db, c.jid);
  let diaAtual = "";
  const corpo = msgs
    .map((m) => {
      const d = relogio(new Date(m.enviada_em), ctx.fuso).dia;
      const sep = d !== diaAtual ? `<span class="dia">${esc(diaMes(d))}</span>` : "";
      diaAtual = d;
      const quem = c.grupo && !m.de_mim && m.remetente_nome ? `<em>${esc(m.remetente_nome)}</em>` : "";
      return `${sep}<span class="bb${m.de_mim ? " eu" : ""}">${quem}${esc(m.texto || `[${m.tipo}]`)}<i>${esc(hora(new Date(m.enviada_em), ctx.fuso))}</i></span>`;
    })
    .join("");
  return `<div class="wrap">${voltar}
<div class="chat"><div class="cab">${avatar(nome)}<div><a class="nome" href="${esc(link(ctx.base, { aba: "pessoas", p: c.jid }))}">${esc(nome)}</a><div class="sub">${esc([c.relacao, c.resumo.slice(0, 80), c.grupo ? "grupo" : `autonomia ${c.autonomia ?? "padrão"}`].filter(Boolean).join(" · "))}</div></div></div>
<div class="corpo">${corpo || `<span class="dia">sem mensagens guardadas</span>`}</div>
<div class="pe">
${c.situacao && c.situacao !== "nada em andamento" ? `<p class="sit"><b>Situação:</b> ${esc(c.situacao)}</p>` : ""}
${rascunhos.map((r) => cartaoDeRascunho(ctx, r)).join("")}
${
  c.grupo
    ? ""
    : `${sugestoes(ctx, c.jid, repo.sugestoesDe(c))}
${form(ctx, { acao: "responder", jid: c.jid }, `<textarea name="instrucao" rows="2" placeholder="O que dizer (eu escrevo no seu jeito e você aprova)"></textarea><button class="p">Escrever rascunho</button>`, "coluna")}
${c.espera_resposta ? botoesDePendencia(ctx, { tipo: "espera", jid: c.jid, titulo: nome }, "Resolvi", { destaque: false }) : ""}`
}
</div></div></div>`;
}

async function emailAberto(deps: DepsResumo, ctx: Ctx, id: string): Promise<string> {
  const voltar = `<a class="voltar" href="${esc(link(ctx.base, { aba: "conversas", f: "email" }))}">‹ E-mails</a>`;
  if (!deps.google) return `<div class="wrap">${voltar}<p class="vazio">O Google não está ligado.</p></div>`;
  const m = await deps.google.email(id).catch(() => null);
  if (!m) return `<div class="wrap">${voltar}<p class="vazio">Não achei esse e-mail.</p></div>`;
  return `<div class="wrap">${voltar}
<div class="chat"><div class="cab">${avatar("E " + remetente(m.de))}<div><b>${esc(m.assunto || "(sem assunto)")}</b><div class="sub">${esc(m.de)} · ${esc(dataCurta(m.data, ctx.fuso))}</div></div></div>
<div class="corpo"><p class="email">${esc((m.corpo || m.trecho).slice(0, 6000))}</p></div>
<div class="pe">${form(ctx, { acao: "perguntar", texto: `Deixe no Gmail um rascunho de resposta ao e-mail "${m.assunto}" (id ${m.id}).` }, `<textarea name="extra" rows="2" placeholder="O que dizer na resposta"></textarea><button class="p">Rascunho no Gmail</button>`, "coluna")}
${botoesDePendencia(ctx, { tipo: "email", emailId: m.id, titulo: m.assunto }, "Resolvi", { semIgnorar: true, destaque: false })}</div></div></div>`;
}

// ── Pessoas ──────────────────────────────────────────────────────────────────

async function abaPessoas(deps: DepsResumo, ctx: Ctx, consulta: ConsultaPainel, opts: OpcoesPainel): Promise<string> {
  const { db } = deps;
  if (consulta.p) return ficha(db, ctx, consulta.p, opts);
  const f = ["todos", "cliente", "familia", "sumidos", "datas"].includes(consulta.f ?? "") ? consulta.f! : "todos";
  const q = (consulta.q ?? "").trim().slice(0, 80);
  const { dia } = relogio(ctx.agora, ctx.fuso);
  const [ano, mes, d] = dia.split("-").map(Number);
  const datas = await repo.datasProximas(db, { ano, mes, dia: d }, 30);
  const total = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM contatos WHERE NOT excluido AND NOT grupo AND NOT sistema")).rows[0].n;

  let pessoas: { jid: string; nome: string; relacao: string | null; resumo: string; ultima: Date | null }[];
  if (f === "datas") {
    pessoas = datas.map((x) => ({ jid: x.jid, nome: x.nome, relacao: null, resumo: `${x.descricao} · ${x.faltam === 0 ? "hoje" : x.faltam === 1 ? "amanhã" : `em ${x.faltam} dias`}`, ultima: null }));
  } else {
    pessoas = (
      await db.query<{ jid: string; nome: string; relacao: string | null; resumo: string; ultima: Date | null }>(
        `SELECT c.jid, ${repo.NOME_SQL} AS nome, c.relacao, c.resumo, u.ultima
         FROM contatos c LEFT JOIN LATERAL (SELECT max(enviada_em) AS ultima FROM mensagens WHERE chat_jid = c.jid) u ON TRUE
         WHERE NOT c.excluido AND NOT c.grupo AND NOT c.sistema
           AND ($1 = '' OR c.nome ILIKE $2 OR c.nome_push ILIKE $2 OR c.resumo ILIKE $2 OR c.memoria ILIKE $2)
           AND ($3 = 'todos' OR ($3 IN ('cliente', 'familia') AND c.relacao = $3)
                OR ($3 = 'sumidos' AND c.relacao IN ('cliente', 'familia', 'amigo') AND u.ultima < now() - interval '21 days'))
         ORDER BY u.ultima DESC NULLS LAST LIMIT 80`,
        [q, `%${q}%`, f],
      )
    ).rows;
  }
  const filtros = [
    ["todos", "Todos"],
    ["cliente", "Clientes"],
    ["familia", "Família"],
    ["sumidos", "Sumidos"],
    ["datas", `Aniversários${datas.length ? ` (${datas.length})` : ""}`],
  ]
    .map(([v, r]) => `<a class="chip${f === v ? " on" : ""}" href="${esc(link(ctx.base, { aba: "pessoas", f: v, q: q || undefined }))}">${esc(r)}</a>`)
    .join("");
  const naSemana = datas.filter((x) => x.faltam <= 7).length;
  return `${topo("Pessoas", `${total} pessoas${naSemana ? `, ${naSemana} ${naSemana === 1 ? "aniversário" : "aniversários"} na semana` : ""}.`)}
<div class="wrap">
<form method="get" action="${esc(ctx.base)}" class="busca"><input type="hidden" name="aba" value="pessoas"><input name="q" value="${esc(q)}" placeholder="Buscar nome, empresa, assunto…"><button>Buscar</button></form>
<div class="filtros">${filtros}</div>
${
  pessoas.length
    ? `<ul class="lista">${pessoas
        .map((p) => {
          const dias = p.ultima ? Math.floor((ctx.agora.getTime() - new Date(p.ultima).getTime()) / 86400_000) : null;
          return `<li>${avatar(p.nome)}<a class="n" href="${esc(link(ctx.base, { aba: "pessoas", p: p.jid }))}"><b>${esc(p.nome)}</b><p>${esc([p.relacao, p.resumo].filter(Boolean).join(" · ") || "sem ficha ainda")}</p></a><div class="r">${dias === null ? "" : dias === 0 ? "hoje" : `${dias}d`}${f === "sumidos" ? `<br><span class="tag a">sumido</span>` : ""}</div></li>`;
        })
        .join("")}</ul>`
    : `<p class="vazio">Ninguém encontrado.</p>`
}</div>`;
}

async function ficha(db: Db, ctx: Ctx, jidBruto: string, opts: OpcoesPainel): Promise<string> {
  const c = await repo.lerContato(db, await repo.resolverJid(db, jidBruto));
  const voltar = `<a class="voltar" href="${esc(link(ctx.base, { aba: "pessoas" }))}">‹ Pessoas</a>`;
  if (!c || c.excluido) return `<div class="wrap">${voltar}<p class="vazio">Essa pessoa não está no assistente.</p></div>`;
  const nome = repo.nomeDe(c);
  const compromissos = (await repo.compromissosAbertos(db)).filter((k) => k.chat_jid === c.jid);
  const datas = (await db.query<{ descricao: string; dia: number; mes: number }>("SELECT descricao, dia, mes FROM datas WHERE chat_jid = $1 ORDER BY mes, dia", [c.jid])).rows;
  const ultima = (await repo.ultimasMensagens(db, c.jid, 1))[0];
  const linha = (rot: string, val: string) => (val ? `<dt>${esc(rot)}</dt><dd>${esc(val)}</dd>` : "");
  const opcoes = [`<option value="" ${c.autonomia === null ? "selected" : ""}>padrão (${opts.padrao})</option>`]
    .concat(opts.niveis.map((n, i) => `<option value="${i}" ${c.autonomia === i ? "selected" : ""}>${i} · ${esc(n)}</option>`))
    .join("");
  return `<div class="wrap">${voltar}
<div class="ficha"><div class="cab">${avatar(nome, true)}<div><h3>${esc(nome)}</h3>${c.relacao ? `<span class="tag">${esc(c.relacao)}</span> ` : ""}${c.sistema ? `<span class="tag">notificação automática</span> ` : ""}${c.grupo ? "" : `<span class="tag">autonomia ${c.autonomia ?? `padrão (${opts.padrao})`}</span>`}</div></div>
<dl>
${linha("Quem é", c.resumo)}
${linha("Agora", c.situacao === "nada em andamento" ? "" : c.situacao)}
${linha("Você espera", c.aguardando)}
${compromissos.length ? `<dt>Combinados</dt><dd>${compromissos.map((k) => `#${k.id} ${esc(k.descricao)}${k.quando ? ` · ${esc(dataCurta(new Date(k.quando), ctx.fuso))}` : ""}${k.responsavel === "contato" ? " (fica com a pessoa)" : ""}`).join("<br>")}</dd>` : ""}
${datas.length ? `<dt>Datas</dt><dd>${datas.map((x) => `${esc(x.descricao)} · ${String(x.dia).padStart(2, "0")}/${String(x.mes).padStart(2, "0")}`).join("<br>")}</dd>` : ""}
${linha("Como você fala", c.tom)}
${c.memoria ? `<dt>Fatos</dt><dd>${esc(c.memoria).replace(/\n/g, "<br>")}</dd>` : ""}
${ultima ? linha("Última conversa", dataCurta(new Date(ultima.enviada_em), ctx.fuso)) : ""}
</dl>
<div class="linhaAcoes"><a class="btn p" href="${esc(link(ctx.base, { aba: "conversas", c: c.jid }))}">Abrir conversa</a></div>
<details><summary>Corrigir algo que entendi errado</summary>${form(ctx, { acao: "corrigir", jid: c.jid }, `<textarea name="texto" rows="2" placeholder="Ex.: ela não é cliente, é fornecedora · não espera resposta"></textarea><button class="p">Corrigir e aprender</button>`, "coluna")}</details>
${c.grupo ? "" : `<details><summary>Autonomia</summary>${form(ctx, { acao: "autonomia", jid: c.jid }, `<select name="nivel">${opcoes}</select><button>Salvar</button>`)}</details>`}
</div></div>`;
}

// ── Assistente ───────────────────────────────────────────────────────────────

async function abaAssistente(db: Db, ctx: Ctx): Promise<string> {
  const falas = await repo.dialogoRecente(db, 12, 72);
  const custo = await resumoDeCusto(db);
  const porDia = await custoPorDia(db, ctx.fuso, 30);
  const maiorDia = Math.max(...porDia.map((x) => x.custo), 0.0001);
  const maiorFuncao = Math.max(...custo.porFuncao.map((f) => f.custo), 0.0001);
  const caderno = await lerCaderno(db);
  const perfil = await repo.lerPerfil(db);
  const pausada = (await db.query("SELECT 1 FROM estado WHERE chave = 'autonomia:pausada' AND valor = '1'")).rowCount;
  const apagavel = (xs: { id: number; texto: string }[], nota = "") =>
    `<ul class="lista">${xs.map((x) => `<li><div class="n"><b class="leve">${esc(x.texto)}</b>${nota ? `<p>${esc(nota)}</p>` : ""}</div>${form(ctx, { acao: "esquecer", id: x.id }, `<button>Apagar</button>`, "inline")}</li>`).join("")}</ul>`;
  return `${topo("Assistente", "Pergunte qualquer coisa.")}
<div class="wrap">
${form(ctx, { acao: "perguntar" }, `<input name="texto" placeholder="O que eu combinei com a Ana?" required><button class="p">Perguntar</button>`, "busca")}
<p class="nota">A resposta aparece aqui e fica também no seu chat com o assistente.</p>
${falas.length ? `<div class="conversa">${falas.map((f) => `<span class="bb${f.autor === "dono" ? " eu" : ""}">${esc(f.texto.slice(0, 1500))}<i>${esc(dataCurta(new Date(f.criado_em), ctx.fuso))}</i></span>`).join("")}</div>` : ""}
${h2("Gasto com o Claude", `30 dias · ${dolar(custo.mes)}`)}
<div class="mini"><div><b>${dolar(custo.dia)}</b><span>hoje</span></div><div><b>${dolar(custo.semana)}</b><span>7 dias</span></div><div><b>${dolar(custo.mes)}</b><span>30 dias</span></div></div>
<div class="barras">${porDia.map((x) => `<i title="${esc(diaMes(x.dia))}: ${esc(dolar(x.custo))}" style="height:${x.custo ? Math.max(4, (x.custo / maiorDia) * 100).toFixed(1) : 1}%"></i>`).join("")}</div>
<div class="leg"><span>${esc(diaMes(porDia[0].dia))}</span><span>hoje</span></div>
${custo.porFuncao.length ? `<ul class="fun">${custo.porFuncao.map((f) => `<li><span>${esc(f.funcao)}</span><i style="width:${Math.max(2, (f.custo / maiorFuncao) * 100).toFixed(1)}%"></i><b>${dolar(f.custo)}</b></li>`).join("")}</ul><p class="nota">Por função, nos últimos 7 dias.</p>` : ""}
${h2("O que estou acompanhando", "caderno")}${caderno ? `<p class="bloco">${esc(caderno)}</p>${form(ctx, { acao: "limpar_caderno" }, `<button>Zerar caderno</button>`)}` : `<p class="vazio">Nada em andamento.</p>`}
${h2("Suas regras", perfil.regras.length || "")}${perfil.regras.length ? apagavel(perfil.regras) : ""}
${form(ctx, { acao: "regra" }, `<input name="texto" placeholder="Nova regra: nunca marco nada antes das 9h"><button class="p">Anotar</button>`, "busca")}
${perfil.leituras.length ? `${h2("O que aprendi lendo as conversas", perfil.leituras.length)}${apagavel(perfil.leituras, "de uma correção sua")}` : ""}
${perfil.licoes.length ? `${h2("O que aprendi com os seus ajustes", perfil.licoes.length)}${apagavel(perfil.licoes, "de um rascunho ajustado")}` : ""}
${perfil.gerado ? `<details><summary>Seu retrato (como você escreve)</summary><p class="bloco">${esc(perfil.gerado)}</p></details>` : ""}
${h2("Respostas automáticas")}<div class="linhaAcoes"><span class="sub">${pausada ? "Pausadas: nada sai sem o seu ok." : "Seguem o nível de cada pessoa (na ficha dela)."}</span>${form(ctx, { acao: pausada ? "retoma" : "pausa" }, `<button>${pausada ? "Retomar" : "Pausar tudo"}</button>`, "inline")}</div>
</div>`;
}

// ── página ───────────────────────────────────────────────────────────────────

const ICONES: Record<Aba, string> = {
  hoje: `<path d="M3 12l9-8 9 8M5 10v10h14V10"/>`,
  conversas: `<path d="M4 5h16v11H8l-4 4z"/>`,
  pessoas: `<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>`,
  assistente: `<path d="M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5z"/>`,
};
const ROTULOS: Record<Aba, string> = { hoje: "Hoje", conversas: "Conversas", pessoas: "Pessoas", assistente: "Assistente" };

export async function paginaDoPainel(
  deps: DepsResumo,
  base: string,
  opts: OpcoesPainel,
  aviso = "",
  consulta: ConsultaPainel = {},
  agora = new Date(),
): Promise<string> {
  const aba: Aba = (["hoje", "conversas", "pessoas", "assistente"] as const).find((a) => a === consulta.aba) ?? "hoje";
  const volta = new URLSearchParams(
    Object.entries({ aba, c: consulta.c, m: consulta.m, p: consulta.p, q: consulta.q, f: consulta.f }).filter((x): x is [string, string] => Boolean(x[1])),
  ).toString();
  const ctx: Ctx = { base, volta, fuso: opts.fuso, agora };

  const conteudo =
    aba === "conversas"
      ? await abaConversas(deps, ctx, consulta)
      : aba === "pessoas"
        ? await abaPessoas(deps, ctx, consulta, opts)
        : aba === "assistente"
          ? await abaAssistente(deps.db, ctx)
          : await abaHoje(deps, ctx, opts);

  // Os números das abas saem do banco, sem buscar agenda nem KoreOS em toda página.
  const esperando = (await repo.esperandoResposta(deps.db, 0, 99)).length;
  const compromissos = (await repo.compromissosAbertos(deps.db, new Date(agora.getTime() + 24 * 3600_000))).filter((k) => k.responsavel !== "contato").length;
  const rascunhos = (await deps.db.query<{ n: number }>("SELECT count(*)::int AS n FROM rascunhos WHERE status = 'aguardando'")).rows[0].n;
  const badge: Partial<Record<Aba, number>> = { hoje: compromissos + rascunhos, conversas: esperando };

  const nav = (Object.keys(ROTULOS) as Aba[])
    .map(
      (a) =>
        `<a href="${esc(link(base, { aba: a === "hoje" ? undefined : a }))}"${a === aba ? ' class="on"' : ""}><svg viewBox="0 0 24 24">${ICONES[a]}</svg>${ROTULOS[a]}${badge[a] ? `<span class="badge">${badge[a]}</span>` : ""}</a>`,
    )
    .join("");
  const fonte = fonteDaManchete();
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#F9F9F7"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Seu dia">
<title>${esc(ROTULOS[aba])} · Seu dia</title>
<style>
${fonte ? `@font-face{font-family:Fraunces;font-weight:600;src:url(data:font/woff2;base64,${fonte}) format("woff2")}` : ""}
${CSS}
</style></head><body>
${aviso ? `<p class="aviso">${esc(aviso)}</p>` : ""}
${conteudo}
<nav>${nav}</nav>
</body></html>`;
}

const CSS = `:root{--fundo:#FCFCFB;--faixa:#F9F9F7;--tinta:#2E2C27;--suave:#6B6A63;--cinza:#B4B3A8;--linha:#E4E3DC;--borda:#E1E1DF;--argila:#C6613F;--argila2:#AE5133;--bolha:#F1F0EB;--minha:#F6E7DF}
@media (prefers-color-scheme:dark){:root{--fundo:#1A1917;--faixa:#21201D;--tinta:#ECEAE3;--suave:#A6A49B;--cinza:#6F6D66;--linha:#34322E;--borda:#34322E;--argila:#D8754F;--argila2:#E58A63;--bolha:#2A2926;--minha:#3A2C25}}
*{box-sizing:border-box}html,body{margin:0;background:var(--fundo);color:var(--tinta)}
body{font:15px/1.45 -apple-system,"Segoe UI",Inter,system-ui,sans-serif;padding-bottom:calc(72px + env(safe-area-inset-bottom));max-width:720px;margin:0 auto}
a{color:inherit;text-decoration:none}
.topo{background:var(--faixa);border-bottom:1px solid var(--borda);padding:calc(20px + env(safe-area-inset-top)) 16px 18px}.topo p{margin:0}
.data{color:var(--suave);font-size:13px}.manchete{font-family:Fraunces,"Iowan Old Style",Georgia,serif;font-weight:600;font-size:28px;line-height:1.15;margin:4px 0 0}
.relevo{width:100%;height:auto;display:block;margin:12px 0 0}.relevo polyline{stroke:var(--tinta)}.relevo circle[fill="#2E2C27"]{fill:var(--tinta)}
.wrap{padding:0 16px}h2{font-size:15px;margin:26px 0 8px;display:flex;justify-content:space-between;align-items:baseline}h2 small{font-weight:400;color:var(--suave);font-size:13px}
h3{margin:0;font-size:19px}
.aviso{margin:0;background:var(--faixa);border-bottom:1px solid var(--borda);border-left:3px solid var(--argila);padding:10px 16px;white-space:pre-wrap;font-size:14px}
.agora{margin:16px 16px 0;border:1px solid var(--argila);border-radius:12px;padding:12px 14px;display:flex;gap:12px;align-items:center}
.agora>div{flex:1;min-width:0}.agora b{display:block}.agora .em{color:var(--argila);font-weight:600;font-size:12px;letter-spacing:.3px}.sub{color:var(--suave);font-size:13px}
.btn,button,select,input,textarea{font:inherit;font-size:13.5px;color:var(--tinta);background:transparent;border:1px solid var(--borda);border-radius:8px;padding:7px 12px}
.btn{display:inline-block}button{cursor:pointer}textarea{width:100%;resize:vertical}input{min-width:0}
.p,.btn.p{background:var(--argila);border-color:var(--argila);color:#FCFCFB;font-weight:500}
form{margin:0}.inline{display:inline-flex;gap:6px}.acoes{display:inline-flex;flex-wrap:wrap;gap:6px;align-items:center}.pend{display:inline-flex;gap:6px;align-items:flex-start;flex-wrap:wrap}
.menu{position:relative}.menu>summary{margin:0;list-style:none;color:var(--tinta);font-size:13.5px}.menu>summary::before,.menu[open]>summary::before{content:none}.menu>summary::after{content:" ▾";color:var(--suave)}
.menu>div{position:absolute;z-index:4;top:calc(100% + 4px);left:0;background:var(--fundo);border:1px solid var(--borda);border-radius:10px;padding:6px;box-shadow:0 6px 18px rgba(0,0,0,.12)}.opcoes{display:flex;flex-direction:column;gap:4px;min-width:150px}.opcoes button{text-align:left;border:0;padding:8px 10px}.opcoes button:hover{background:var(--bolha)}
.linhaAcoes{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:4px}.coluna{display:flex;flex-direction:column;gap:8px;margin:8px 0}
.busca{display:flex;gap:8px;margin:14px 0 6px}.busca input{flex:1}
.tl{list-style:none;margin:0;padding:0;position:relative}.tl:before{content:"";position:absolute;left:52px;top:8px;bottom:8px;width:1px;background:var(--linha)}
.tl li{display:grid;grid-template-columns:44px 16px 1fr;gap:6px;padding:7px 0;align-items:start}.tl li.passou{opacity:.55}
.tl .h{font-size:13px;color:var(--suave);text-align:right;padding-top:1px}.tl .d{width:11px;height:11px;border-radius:50%;background:var(--tinta);margin:5px 0 0 3px;position:relative;z-index:1}
.tl .d.promessa{background:var(--argila)}.tl .d.espera{background:var(--fundo);border:2px solid var(--cinza)}.tl .d.prazo{border-radius:2px;background:var(--argila)}
.tl .t p{margin:1px 0 0;color:var(--suave);font-size:13px}.tl .agoraLinha{display:block;border-top:1px dashed var(--argila);margin:8px 0 8px 50px;padding:0;position:relative}
.tl .agoraLinha span{position:absolute;right:0;top:-9px;background:var(--fundo);color:var(--argila);font-size:11px;padding-left:6px}
.card{border:1px solid var(--linha);border-radius:12px;padding:12px 14px;margin-bottom:10px}
.cab{display:flex;gap:10px;align-items:center}.cab b,.cab .nome{font-size:15px;font-weight:600;min-width:0}.cab .meta{color:var(--suave);font-size:12px;margin-left:auto;white-space:nowrap}
.av{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;font-size:12.5px;font-weight:600;color:#fff;flex:none}.av.g{width:48px;height:48px;font-size:16px}
.sit{color:var(--suave);font-size:13.5px;margin:8px 0}.sit b{color:var(--tinta)}
.bolhas,.conversa{display:flex;flex-direction:column;gap:4px;margin:6px 0 10px}
.bb{max-width:85%;padding:6px 10px;border-radius:12px;font-size:13.5px;background:var(--bolha);align-self:flex-start;white-space:pre-wrap;overflow-wrap:anywhere}
.bb.eu{background:var(--minha);align-self:flex-end}.bb i{display:block;font-style:normal;font-size:10.5px;color:var(--suave);margin-top:1px;text-align:right}.bb em{display:block;font-style:normal;font-size:11.5px;font-weight:600;color:var(--argila)}
.sugest{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}.chip{display:inline-block;font-size:12.5px;border:1px solid var(--borda);border-radius:20px;padding:5px 11px;white-space:nowrap}
.chip.s{border-style:dashed;color:var(--suave)}.chip.on{background:var(--tinta);color:var(--fundo);border-color:var(--tinta)}
.tag{font-size:11px;border-radius:10px;padding:1px 8px;background:var(--bolha);color:var(--suave);white-space:nowrap}.tag.a{background:var(--minha);color:var(--argila)}
.mini{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.mini div{border:1px solid var(--linha);border-radius:10px;padding:9px 10px}.mini b{display:block;font-size:19px}.mini span{font-size:12px;color:var(--suave)}
.filtros{display:flex;gap:6px;overflow-x:auto;padding:14px 0 4px}
.lista{list-style:none;margin:0;padding:0}.lista li{display:flex;gap:12px;padding:11px 0;border-bottom:1px solid var(--linha);align-items:center}
.lista .n{flex:1;min-width:0;display:block}.lista .n b{display:block}.lista .n b.leve{font-weight:500}.lista .n p{margin:0;color:var(--suave);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lista .r{text-align:right;font-size:12px;color:var(--suave);white-space:nowrap}.ponto{width:8px;height:8px;border-radius:50%;background:var(--argila);display:inline-block}
.voltar{display:inline-block;margin:14px 0 4px;color:var(--argila);font-size:14px}
.chat,.ficha{border:1px solid var(--linha);border-radius:12px;overflow:hidden;margin:6px 0 16px}.ficha{padding:14px}
.chat>.cab{padding:10px 12px;border-bottom:1px solid var(--linha);background:var(--faixa)}.chat .corpo{padding:10px 12px;display:flex;flex-direction:column;gap:5px}
.chat .dia{align-self:center;font-size:11px;color:var(--suave);margin:6px 0 2px}.chat .pe{border-top:1px solid var(--linha);padding:10px 12px;background:var(--faixa)}
.email{white-space:pre-wrap;margin:0;font-size:14px;overflow-wrap:anywhere}
.ficha dl{display:grid;grid-template-columns:118px 1fr;gap:8px 10px;margin:14px 0;font-size:13.5px}.ficha dt{color:var(--suave)}.ficha dd{margin:0;overflow-wrap:anywhere}
details>summary{cursor:pointer;color:var(--suave);font-size:13.5px;margin:10px 0 0;list-style:none}details>summary::-webkit-details-marker{display:none}details>summary::before{content:"▸ "}details[open]>summary::before{content:"▾ "}
.nota{font-size:12.5px;color:var(--suave);margin:4px 0}.vazio{color:var(--suave)}.bloco{white-space:pre-wrap;color:var(--suave);margin:4px 0 8px;font-size:14px}
.barras{display:flex;align-items:flex-end;gap:2px;height:72px;margin:12px 0 2px}.barras i{flex:1;background:var(--argila);opacity:.85;border-radius:2px 2px 0 0}
.leg{display:flex;justify-content:space-between;font-size:11px;color:var(--suave)}
.fun{list-style:none;margin:10px 0 0;padding:0}.fun li{display:grid;grid-template-columns:96px 1fr 76px;align-items:center;gap:10px;padding:4px 0;font-size:13px}.fun i{display:block;height:7px;background:var(--argila);border-radius:4px}.fun b{text-align:right;font-weight:500}
nav{position:fixed;left:0;right:0;bottom:0;background:var(--faixa);border-top:1px solid var(--borda);display:grid;grid-template-columns:repeat(4,1fr);padding:6px 0 calc(6px + env(safe-area-inset-bottom));z-index:5}
nav a{display:flex;flex-direction:column;align-items:center;gap:2px;font-size:11px;color:var(--suave);position:relative}nav a.on{color:var(--argila)}
nav svg{width:22px;height:22px;stroke:currentColor;fill:none;stroke-width:1.8}
.badge{position:absolute;top:-3px;left:calc(50% + 5px);background:var(--argila);color:#fff;border-radius:9px;font-size:10px;padding:0 5px;line-height:16px}
@media (min-width:721px){body{border-left:1px solid var(--linha);border-right:1px solid var(--linha);min-height:100vh}nav{max-width:720px;margin:0 auto}}`;

// ── ações ────────────────────────────────────────────────────────────────────

export type AcaoDoPainel =
  | { texto: string }
  | { autonomia: { jid: string; nivel: number | null } }
  | { pendencia: { item: Item; acao: Acao; quando?: string } }
  | { responder: { jid: string; instrucao: string } }
  | { corrigir: { jid: string; texto: string } }
  | { perguntar: string }
  | { limparCaderno: true };

const TIPOS = new Set<TipoItem>(["espera", "compromisso", "email"]);

/**
 * O botão do painel vira o mesmo comando do WhatsApp (uma regra só para os dois lugares),
 * ou, para os itens do dia, a mesma função das letras do resumo.
 */
export function comandoDoPainel(campos: Record<string, string>): AcaoDoPainel | null {
  const id = /^\d+$/.test(campos.id ?? "") ? Number(campos.id) : null;
  switch (campos.acao) {
    case "enviar":
      return id ? { texto: `ok ${id}` } : null;
    case "descartar":
      return id ? { texto: `descarta ${id}` } : null;
    case "ajustar":
      return id && campos.instrucao?.trim() ? { texto: `ajusta ${id} ${campos.instrucao.trim().slice(0, 500)}` } : null;
    case "feito":
      return id ? { texto: `feito ${id}` } : null;
    case "ignora":
      return id ? { texto: `ignora ${id}` } : null;
    case "esquecer":
      return id ? { texto: `esquece ${id}` } : null;
    case "regra":
      return campos.texto?.trim() ? { texto: `regra ${campos.texto.trim().slice(0, 500)}` } : null;
    case "pausa":
      return { texto: "pausa" };
    case "retoma":
      return { texto: "retoma" };
    case "limpar_caderno":
      return { limparCaderno: true };
    case "autonomia": {
      if (!campos.jid) return null;
      const nivel = campos.nivel === "" ? null : Number(campos.nivel);
      if (nivel !== null && !(nivel >= 0 && nivel <= 3)) return null;
      return { autonomia: { jid: campos.jid, nivel } };
    }
    case "pendencia": {
      const tipo = campos.tipo as TipoItem;
      const acao = campos.verbo as Acao;
      if (!TIPOS.has(tipo) || !["resolvi", "adia", "ignora"].includes(acao)) return null;
      const compromissoId = /^\d+$/.test(campos.compromissoId ?? "") ? Number(campos.compromissoId) : undefined;
      const item: Item = { letra: "", tipo, titulo: (campos.titulo ?? "").slice(0, 200), jid: campos.jid || undefined, compromissoId, emailId: campos.emailId || undefined };
      if (tipo === "espera" && !item.jid) return null;
      if (tipo === "compromisso" && !compromissoId) return null;
      if (tipo === "email" && !item.emailId) return null;
      return { pendencia: { item, acao, quando: acao === "adia" ? campos.quando : undefined } };
    }
    case "responder":
      return campos.jid ? { responder: { jid: campos.jid, instrucao: (campos.instrucao ?? "").trim().slice(0, 1000) } } : null;
    case "corrigir":
      return campos.jid && campos.texto?.trim() ? { corrigir: { jid: campos.jid, texto: campos.texto.trim().slice(0, 1000) } } : null;
    case "perguntar": {
      const texto = [campos.texto, campos.extra].map((x) => (x ?? "").trim()).filter(Boolean).join(" ").slice(0, 2000);
      return texto ? { perguntar: texto } : null;
    }
    default:
      return null;
  }
}

/** Para onde voltar depois do botão: só a consulta das abas, nunca outro endereço. */
export function voltaSegura(volta: string | undefined): string {
  if (!volta || !/^[a-z0-9=&%._@+\-]*$/i.test(volta)) return "";
  const ok = new URLSearchParams(volta);
  for (const k of ok.keys()) if (!["aba", "c", "m", "p", "q", "f"].includes(k)) return "";
  return ok.toString();
}
