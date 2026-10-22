import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { planoDoCartao, relevo } from "./cartao.js";
import { dolar, resumoDeCusto } from "./consumo.js";
import type { Db } from "./db.js";
import { dataCurta } from "./formato.js";
import { diaMes } from "./koreos.js";
import { lerCaderno } from "./memoria.js";
import type { Acao, Item, TipoItem } from "./pauta.js";
import * as repo from "./repo.js";
import { assuntoDe, coletarDia, diasEsperando, esperandoRecente, ficouParaTras, remetente, type DepsResumo } from "./resumo.js";

/**
 * O painel: o cartão da manhã ao vivo, com um botão em cada item. Uma página só, gerada
 * no servidor e sem JavaScript (os botões são formulários), no mesmo desenho do cartão.
 * Não chama modelo nenhum: a manchete e os blocos do dia saem dos dados.
 *
 * O acesso é o token no caminho (PAINEL_TOKEN), e o endereço só existe dentro da rede
 * do Tailscale: nenhuma porta pública na VM.
 */

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// A fonte da manchete vai embutida: o celular abre sem buscar nada fora.
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

function form(base: string, campos: Record<string, string | number | undefined>, corpo: string, classe = "acoes"): string {
  const ocultos = Object.entries(campos)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  return `<form method="post" action="${esc(base)}/acao" class="${classe}">${ocultos}${corpo}</form>`;
}

const ADIAR = ["amanhã", "depois de amanhã", "sábado", "segunda", "semana que vem"];

/** Resolvi · Adiar [quando] · Ignorar, para pessoa, compromisso ou e-mail. */
function botoesDePendencia(base: string, alvo: { tipo: TipoItem; jid?: string; compromissoId?: number; emailId?: string; titulo: string }, rotuloResolvi = "Resolvi"): string {
  const campos = { acao: "pendencia", tipo: alvo.tipo, jid: alvo.jid, compromissoId: alvo.compromissoId, emailId: alvo.emailId, titulo: alvo.titulo };
  return form(
    base,
    campos,
    `<button name="verbo" value="resolvi" class="primario">${rotuloResolvi}</button>
<span class="adiar"><select name="quando" aria-label="Adiar para">${ADIAR.map((q) => `<option>${q}</option>`).join("")}</select><button name="verbo" value="adia">Adiar</button></span>
<button name="verbo" value="ignora">Ignorar</button>`,
  );
}

function responder(base: string, jid: string): string {
  return `<details class="responder"><summary>Responder</summary>${form(
    base,
    { acao: "responder", jid },
    `<textarea name="instrucao" rows="2" placeholder="O que dizer (vazio: responder ao que está pendente)"></textarea><button class="primario">Escrever rascunho</button>`,
    "coluna",
  )}</details>`;
}

function item(marca: string, titulo: string, frase: string, extra = ""): string {
  return `<li><span class="marca">${marca}</span><div class="corpo"><strong>${esc(titulo)}</strong><p>${esc(frase)}</p>${extra}</div></li>`;
}

function secao(titulo: string, itens: string[], vazio?: string): string {
  if (!itens.length && !vazio) return "";
  return `<section><h2>${esc(titulo)}</h2>${itens.length ? `<ul>${itens.join("")}</ul>` : `<p class="vazio">${esc(vazio)}</p>`}</section>`;
}

export interface OpcoesPainel {
  fuso: string;
  dono: string;
  niveis: string[];
  padrao: number;
}

export async function paginaDoPainel(deps: DepsResumo, base: string, opts: OpcoesPainel, aviso = ""): Promise<string> {
  const { db } = deps;
  const dia = await coletarDia(deps);
  const plano = await planoDoCartao(null, dia, opts.dono, opts.fuso);
  const rascunhos = (
    await db.query<{ id: number; texto: string; enviar_em: Date | null; risco: string | null; motivo_risco: string; nome: string }>(
      `SELECT r.id, r.texto, r.enviar_em, r.risco, r.motivo_risco, ${repo.NOME_SQL} AS nome
       FROM rascunhos r JOIN contatos c ON c.jid = r.chat_jid WHERE r.status = 'aguardando' ORDER BY r.id DESC`,
    )
  ).rows;
  const pausada = (await db.query("SELECT 1 FROM estado WHERE chave = 'autonomia:pausada' AND valor = '1'")).rowCount;
  const custo = await resumoDeCusto(db);
  const caderno = await lerCaderno(db);
  const perfil = await repo.lerPerfil(db);
  const pessoas = (
    await db.query<repo.Contato & { ultima: Date | null }>(
      `SELECT c.*, (SELECT max(enviada_em) FROM mensagens WHERE chat_jid = c.jid) AS ultima
       FROM contatos c WHERE NOT c.excluido AND NOT c.grupo AND NOT c.sistema
       ORDER BY ultima DESC NULLS LAST LIMIT 60`,
    )
  ).rows;

  const doDono = [...dia.comData, ...dia.semData].filter((k) => k.responsavel !== "contato");
  const doOutro = dia.comData.filter((k) => k.responsavel === "contato");
  const ponto = `<span class="ponto">·</span>`;

  const secRascunhos = secao(
    "Esperando sua aprovação",
    rascunhos.map((r) =>
      item(
        "✎",
        `#${r.id} para ${r.nome}`,
        r.texto,
        `${r.enviar_em ? `<p class="nota">Sai sozinho às ${esc(dataCurta(new Date(r.enviar_em), opts.fuso))} se você não vetar.</p>` : ""}${r.risco === "alto" ? `<p class="nota">${esc(r.motivo_risco || "Precisa do seu ok.")}</p>` : ""}
${form(base, { acao: "enviar", id: r.id }, `<button class="primario">Enviar</button>`)}${form(base, { acao: "descartar", id: r.id }, `<button>Descartar</button>`)}
<details class="responder"><summary>Ajustar</summary>${form(base, { acao: "ajustar", id: r.id }, `<textarea name="instrucao" rows="2" placeholder="Ex.: mais curto, sem emoji"></textarea><button class="primario">Refazer</button>`, "coluna")}</details>`,
      ),
    ),
  );

  const secPrecisa = secao(
    "Precisa de você",
    [
      ...doDono.map((k) =>
        item(
          ponto,
          k.descricao,
          `${k.contato_nome ?? ""}${k.quando ? ` · ${dataCurta(new Date(k.quando), opts.fuso)}` : " · sem data"}${k.quando && new Date(k.quando) < dia.agora ? " · atrasado" : ""} · #${k.id}`,
          botoesDePendencia(base, { tipo: "compromisso", compromissoId: k.id, jid: k.chat_jid, titulo: k.descricao }, "Feito"),
        ),
      ),
      ...esperandoRecente(dia).map((e) =>
        item(ponto, `${e.nome} espera resposta`, assuntoDe(e), `${botoesDePendencia(base, { tipo: "espera", jid: e.jid, titulo: e.nome })}${responder(base, e.jid)}`),
      ),
      ...dia.emails.map((m) =>
        item(ponto, m.assunto || "(sem assunto)", `E-mail de ${remetente(m.de)}. ${m.trecho.slice(0, 160)}`, botoesDePendencia(base, { tipo: "email", emailId: m.id, titulo: m.assunto })),
      ),
    ],
    "Nada precisa de você agora.",
  );

  const secParaTras = secao(
    "Ficou para trás",
    ficouParaTras(dia).map((e) =>
      item(
        `<span class="dias">${diasEsperando(e, dia.agora)}d</span>`,
        e.nome,
        `Há ${diasEsperando(e, dia.agora)} dias. ${assuntoDe(e)}`,
        `${botoesDePendencia(base, { tipo: "espera", jid: e.jid, titulo: e.nome })}${responder(base, e.jid)}`,
      ),
    ),
  );

  const k = dia.koreos;
  const secKoreos = k
    ? secao("No KoreOS", [
        ...k.tarefasHoje.map((t) => item(ponto, t.titulo, `${t.projeto} · vence hoje · ${t.status}`)),
        ...k.tarefasAtrasadas.map((t) => item(ponto, t.titulo, `${t.projeto} · atrasada desde ${diaMes(t.prazo)} · ${t.status}`)),
        ...k.contasHoje.map((l) => item(ponto, `${l.tipo === "RECEITA" ? "Receber" : "Pagar"} ${l.valor}`, `${l.descricao} · vence hoje`)),
        ...k.contasAtrasadas.map((l) => item(ponto, `${l.tipo === "RECEITA" ? "Receber" : "Pagar"} ${l.valor}`, `${l.descricao} · vencido em ${diaMes(l.data)}`)),
      ])
    : "";

  const secOutros = secao(
    "O que os outros ficaram de fazer",
    doOutro.map((c) =>
      item(ponto, c.descricao, `${c.contato_nome ?? ""} · ${dataCurta(new Date(c.quando!), opts.fuso)} · #${c.id}`, botoesDePendencia(base, { tipo: "compromisso", compromissoId: c.id, jid: c.chat_jid, titulo: c.descricao }, "Chegou")),
    ),
  );

  const secResolvido = secao(
    "Resolvido",
    dia.resolvidos.map((r) => item(ponto, `${r.descricao} — ${r.contato}`, dataCurta(new Date(r.quando), opts.fuso))),
  );

  const maior = Math.max(...custo.porFuncao.map((f) => f.custo), 0.0001);
  const secCusto = `<section><h2>Gasto com o Claude</h2>
<div class="numeros"><div><span>Hoje</span><strong>${dolar(custo.dia)}</strong></div><div><span>7 dias</span><strong>${dolar(custo.semana)}</strong></div><div><span>30 dias</span><strong>${dolar(custo.mes)}</strong></div></div>
${custo.porFuncao.length ? `<ul class="barras">${custo.porFuncao.map((f) => `<li><span>${esc(f.funcao)}</span><i style="width:${Math.max(2, (f.custo / maior) * 100).toFixed(1)}%"></i><b>${dolar(f.custo)}</b></li>`).join("")}</ul><p class="nota">Por função, nos últimos 7 dias.</p>` : ""}</section>`;

  const lista = (titulo: string, xs: { id: number; texto: string }[]) =>
    xs.length ? `<h3>${esc(titulo)}</h3><ul>${xs.map((x) => item(ponto, x.texto, "", form(base, { acao: "esquecer", id: x.id }, `<button>Apagar</button>`))).join("")}</ul>` : "";
  const secSabe = `<section><h2>O que eu sei de você</h2>
${caderno ? `<h3>Caderno (o que está em andamento)</h3><p class="bloco">${esc(caderno)}</p>${form(base, { acao: "limpar_caderno" }, `<button>Zerar caderno</button>`)}` : ""}
${lista("Suas regras", perfil.regras)}
${form(base, { acao: "regra" }, `<input name="texto" placeholder="Nova regra: nunca marco nada antes das 9h"><button class="primario">Anotar</button>`, "linha")}
${lista("O que aprendi lendo as conversas", perfil.leituras)}
${lista("O que aprendi com os seus ajustes", perfil.licoes)}
${perfil.gerado ? `<details><summary>Seu retrato</summary><p class="bloco">${esc(perfil.gerado)}</p></details>` : ""}</section>`;

  const opcoes = (atual: number | null) =>
    [`<option value="" ${atual === null ? "selected" : ""}>padrão (${opts.padrao})</option>`]
      .concat(opts.niveis.map((n, i) => `<option value="${i}" ${atual === i ? "selected" : ""}>${i} · ${esc(n)}</option>`))
      .join("");
  const secPessoas = `<section><details><summary><h2>Pessoas e autonomia</h2></summary><ul>${pessoas
    .map((p) =>
      item(
        ponto,
        repo.nomeDe(p),
        [p.relacao, p.resumo].filter(Boolean).join(" · "),
        form(base, { acao: "autonomia", jid: p.jid }, `<select name="nivel">${opcoes(p.autonomia)}</select><button>Salvar</button>`),
      ),
    )
    .join("")}</ul></details></section>`;

  const fonte = fonteDaManchete();
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#F9F9F7"><title>Seu dia</title>
<style>
${fonte ? `@font-face{font-family:Fraunces;font-weight:600;src:url(data:font/woff2;base64,${fonte}) format("woff2")}` : ""}
:root{--fundo:#FCFCFB;--faixa:#F9F9F7;--tinta:#2E2C27;--suave:#6B6A63;--cinza:#B4B3A8;--linha:#E4E3DC;--borda:#E1E1DF;--argila:#C6613F;--argila2:#AE5133}
@media (prefers-color-scheme:dark){:root{--fundo:#1A1917;--faixa:#21201D;--tinta:#ECEAE3;--suave:#A6A49B;--cinza:#6F6D66;--linha:#34322E;--borda:#34322E;--argila:#D8754F;--argila2:#E58A63}}
*{box-sizing:border-box}html,body{margin:0;background:var(--fundo);color:var(--tinta)}
body{font:15px/1.45 -apple-system,"Segoe UI",Inter,system-ui,sans-serif}
.faixa{background:var(--faixa);border-bottom:1px solid var(--borda)}.faixa>div,main{max-width:860px;margin:0 auto;padding:28px 16px}
.data{color:var(--suave);font-size:14px;margin:0 0 6px}
h1{font-family:Fraunces,Georgia,serif;font-weight:600;font-size:34px;line-height:1.15;margin:0}
.relevo{width:100%;height:auto;display:block;margin:18px 0 6px}.relevo polyline{stroke:var(--tinta)}.relevo circle[fill="#2E2C27"]{fill:var(--tinta)}
.atos{display:grid;grid-template-columns:repeat(3,1fr)}.atos div{padding:0 14px;border-left:1px solid var(--linha)}.atos div:first-child{padding-left:0;border:0}
.atos b{display:block;font-size:14px}.atos p{margin:4px 0 0;color:var(--suave);font-size:14px}
.pausa{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;color:var(--suave);font-size:14px;margin-top:20px}
.aviso{background:var(--faixa);border:1px solid var(--borda);border-left:3px solid var(--argila);padding:10px 12px;margin:0 0 8px;white-space:pre-wrap}
section{margin-top:30px}h2{font-size:15px;font-weight:600;margin:0 0 4px;display:inline}section>h2{display:block}h3{font-size:13px;color:var(--suave);font-weight:600;margin:18px 0 4px}
ul{list-style:none;margin:0;padding:0}li{display:flex;gap:12px;padding:14px 0;border-bottom:1px solid var(--linha)}
.marca{width:30px;flex:none;color:var(--argila);font-weight:600;font-size:16px}.ponto{color:var(--cinza)}.dias{color:var(--argila);font-size:13px}
.corpo{flex:1;min-width:0}.corpo strong{font-size:16px}.corpo p{margin:3px 0 0;color:var(--suave);white-space:pre-wrap;overflow-wrap:anywhere}
.nota{font-size:13px;color:var(--suave)}.vazio{color:var(--suave)}.bloco{white-space:pre-wrap;color:var(--suave);margin:4px 0 8px}
form{margin:0}.acoes{display:inline-flex;flex-wrap:wrap;gap:8px;margin:10px 8px 0 0;align-items:center;vertical-align:top}.adiar{display:inline-flex;gap:4px}.adiar select{max-width:118px;padding-right:4px}
.linha{display:flex;gap:8px;margin-top:10px}.linha input{flex:1;min-width:0}.coluna{display:flex;flex-direction:column;gap:8px;margin-top:8px}
button,select,input,textarea{font:inherit;font-size:14px;color:var(--tinta);background:transparent;border:1px solid var(--borda);border-radius:8px;padding:7px 12px}
textarea{width:100%;resize:vertical}button{cursor:pointer}button:hover{border-color:var(--cinza)}
.primario{background:var(--argila);border-color:var(--argila);color:#FCFCFB;font-weight:500}.primario:hover{background:var(--argila2);border-color:var(--argila2)}
details>summary{cursor:pointer;color:var(--suave);font-size:14px;margin-top:8px;list-style:none}details>summary::-webkit-details-marker{display:none}details>summary::before{content:"▸ "}details[open]>summary::before{content:"▾ "}
.numeros{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:10px 0}.numeros div{border:1px solid var(--linha);border-radius:8px;padding:10px}.numeros span{display:block;color:var(--suave);font-size:13px}.numeros strong{font-size:18px}
.barras li{display:grid;grid-template-columns:110px 1fr 80px;align-items:center;gap:10px;padding:6px 0;border:0;font-size:13px}.barras i{display:block;height:8px;background:var(--argila);border-radius:4px}.barras b{text-align:right;font-weight:500}
@media (max-width:640px){h1{font-size:26px}.atos{grid-template-columns:1fr}.atos div{padding:10px 0;border-left:0;border-top:1px solid var(--linha)}.atos div:first-child{border-top:0}.barras li{grid-template-columns:90px 1fr 70px}}
</style></head><body>
<div class="faixa"><div>
<p class="data">${esc(new Intl.DateTimeFormat("pt-BR", { timeZone: opts.fuso, weekday: "long", day: "2-digit", month: "2-digit" }).format(dia.agora))}</p>
<h1>${esc(plano.manchete)}</h1>
${relevo(dia, opts.fuso).replace("<svg ", '<svg class="relevo" ')}
<div class="atos">${plano.atos.map((a) => `<div><b>${esc(a.faixa)}</b><p>${esc(a.frase)}</p></div>`).join("")}</div>
<div class="pausa"><span>${pausada ? "Autonomia pausada: nada sai sem o seu ok." : "Respostas automáticas seguem o nível de cada pessoa."}</span>${form(base, { acao: pausada ? "retoma" : "pausa" }, `<button>${pausada ? "Retomar" : "Pausar tudo"}</button>`, "")}</div>
</div></div>
<main>
${aviso ? `<p class="aviso">${esc(aviso)}</p>` : ""}
${secRascunhos}${secPrecisa}${secParaTras}${secKoreos}${secOutros}${secResolvido}${secCusto}${secSabe}${secPessoas}
</main></body></html>`;
}

export type AcaoDoPainel =
  | { texto: string }
  | { autonomia: { jid: string; nivel: number | null } }
  | { pendencia: { item: Item; acao: Acao; quando?: string } }
  | { responder: { jid: string; instrucao: string } }
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
    default:
      return null;
  }
}
