import type { Db } from "./db.js";
import { dataCurta } from "./formato.js";
import * as repo from "./repo.js";

/**
 * Painel web do assistente: a mesma coisa que o canal de controle, numa tela. Uma
 * página só, gerada no servidor, sem JavaScript: os botões são formulários. O acesso
 * é o token no caminho (PAINEL_TOKEN), então o link é pessoal.
 */

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function botao(base: string, acao: string, rotulo: string, extra: Record<string, string | number> = {}, classe = "") {
  const campos = Object.entries(extra)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  return `<form method="post" action="${esc(base)}/acao"><input type="hidden" name="acao" value="${esc(acao)}">${campos}<button class="${classe}">${esc(rotulo)}</button></form>`;
}

export async function paginaDoPainel(db: Db, base: string, opts: { fuso: string; dono: string; niveis: string[]; padrao: number }): Promise<string> {
  const rascunhos = (
    await db.query<{ id: number; chat_jid: string; texto: string; enviar_em: Date | null; risco: string | null; motivo_risco: string; nome: string }>(
      `SELECT r.id, r.chat_jid, r.texto, r.enviar_em, r.risco, r.motivo_risco,
              COALESCE(c.nome, c.nome_push, split_part(c.jid, '@', 1)) AS nome
       FROM rascunhos r JOIN contatos c ON c.jid = r.chat_jid WHERE r.status = 'aguardando' ORDER BY r.id DESC`,
    )
  ).rows;
  const compromissos = await repo.compromissosAbertos(db);
  const esperando = await repo.esperandoResposta(db, 4, 20);
  const pessoas = (
    await db.query<repo.Contato & { ultima: Date | null }>(
      `SELECT c.*, (SELECT max(enviada_em) FROM mensagens WHERE chat_jid = c.jid) AS ultima
       FROM contatos c WHERE NOT c.excluido AND NOT c.grupo
       ORDER BY ultima DESC NULLS LAST LIMIT 60`,
    )
  ).rows;
  const perfil = await repo.lerPerfil(db);
  const pausada = (await db.query("SELECT 1 FROM estado WHERE chave = 'autonomia:pausada' AND valor = '1'")).rowCount;

  const secRascunhos = rascunhos.length
    ? rascunhos
        .map(
          (r) => `<article class="card">
  <header><strong>#${r.id} · ${esc(r.nome)}</strong>${r.enviar_em ? `<span class="tag aviso">sai ${esc(dataCurta(new Date(r.enviar_em), opts.fuso))}</span>` : ""}${r.risco === "alto" ? `<span class="tag">${esc(r.motivo_risco || "risco alto")}</span>` : ""}</header>
  <p class="msg">${esc(r.texto)}</p>
  <div class="acoes">${botao(base, "enviar", "Enviar", { id: r.id }, "primario")}${botao(base, "descartar", "Descartar", { id: r.id })}</div>
</article>`,
        )
        .join("")
    : `<p class="vazio">Nada esperando aprovação.</p>`;

  const secCompromissos = compromissos.length
    ? `<ul class="lista">${compromissos
        .map(
          (k) => `<li><div><strong>#${k.id}</strong> ${esc(k.descricao)} <small>${esc(k.contato_nome ?? "")} · ${k.quando ? esc(dataCurta(new Date(k.quando), opts.fuso)) : "sem data"} · ${esc(k.responsavel)}${k.status === "sugerido" ? " · sugerido" : ""}</small></div>
  <div class="acoes">${botao(base, "feito", "Feito", { id: k.id })}${botao(base, "ignora", "Ignorar", { id: k.id })}</div></li>`,
        )
        .join("")}</ul>`
    : `<p class="vazio">Nenhum compromisso em aberto.</p>`;

  const secEsperando = esperando.length
    ? `<ul class="lista">${esperando.map((e) => `<li><div><strong>${esc(e.nome)}</strong> <small>${esc(dataCurta(new Date(e.quando), opts.fuso))}</small><br>${esc(e.ultima.slice(0, 160))}</div></li>`).join("")}</ul>`
    : `<p class="vazio">Ninguém esperando.</p>`;

  const opcoes = (atual: number | null) =>
    [`<option value="" ${atual === null ? "selected" : ""}>padrão (${opts.padrao})</option>`]
      .concat(opts.niveis.map((n, i) => `<option value="${i}" ${atual === i ? "selected" : ""}>${i} · ${esc(n)}</option>`))
      .join("");
  const secPessoas = `<ul class="lista">${pessoas
    .map(
      (p) => `<li><div><strong>${esc(repo.nomeDe(p))}</strong> <small>${esc(p.relacao ?? "")}</small><br><small>${esc(p.resumo)}</small>${p.aguardando ? `<br><small>⏳ ${esc(p.aguardando)}</small>` : ""}</div>
  <form method="post" action="${esc(base)}/acao" class="nivel"><input type="hidden" name="acao" value="autonomia"><input type="hidden" name="jid" value="${esc(p.jid)}"><select name="nivel">${opcoes(p.autonomia)}</select><button>Salvar</button></form></li>`,
    )
    .join("")}</ul>`;

  const secPerfil = `${perfil.regras.length ? `<h3>Suas regras</h3><ul class="lista">${perfil.regras.map((r) => `<li><div>${esc(r.texto)}</div>${botao(base, "esquecer", "Apagar", { id: r.id })}</li>`).join("")}</ul>` : ""}
${perfil.licoes.length ? `<h3>Lições das correções</h3><ul class="lista">${perfil.licoes.map((r) => `<li><div>${esc(r.texto)}</div>${botao(base, "esquecer", "Apagar", { id: r.id })}</li>`).join("")}</ul>` : ""}
<form method="post" action="${esc(base)}/acao" class="linha"><input type="hidden" name="acao" value="regra"><input name="texto" placeholder="Nova regra: nunca marco nada antes das 9h"><button>Anotar</button></form>
${perfil.gerado ? `<h3>Seu retrato</h3><p class="msg">${esc(perfil.gerado)}</p>` : ""}`;

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Assistente</title>
<style>
:root{--fundo:#f6f6f4;--cartao:#fff;--texto:#1d1d1b;--suave:#6b6b66;--borda:#e3e2dd;--acento:#1f6f5c;--aviso:#a15c07}
@media (prefers-color-scheme:dark){:root{--fundo:#121211;--cartao:#1c1c1a;--texto:#ecebe6;--suave:#a3a29b;--borda:#2e2e2b;--acento:#4fb39a;--aviso:#e0a24a}}
*{box-sizing:border-box}body{margin:0;background:var(--fundo);color:var(--texto);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:16px}h1{font-size:20px;margin:8px 0 16px}h2{font-size:16px;margin:28px 0 10px}h3{font-size:14px;margin:16px 0 6px;color:var(--suave)}
.card,.lista li{background:var(--cartao);border:1px solid var(--borda);border-radius:10px;padding:12px;margin-bottom:10px}
.lista{list-style:none;padding:0;margin:0}.lista li{display:flex;gap:12px;justify-content:space-between;align-items:flex-start;flex-wrap:wrap}
.msg{white-space:pre-wrap;margin:8px 0}small{color:var(--suave)}.vazio{color:var(--suave)}
.acoes{display:flex;gap:8px;flex-wrap:wrap}form{margin:0}button,select,input{font:inherit;border-radius:8px;border:1px solid var(--borda);background:var(--cartao);color:var(--texto);padding:6px 12px}
button{cursor:pointer}.primario{background:var(--acento);border-color:var(--acento);color:#fff}
.tag{margin-left:8px;font-size:12px;color:var(--suave)}.tag.aviso{color:var(--aviso)}
.linha{display:flex;gap:8px;margin-top:10px}.linha input{flex:1;min-width:0}.nivel{display:flex;gap:6px}
.faixa{background:var(--cartao);border:1px solid var(--borda);border-radius:10px;padding:10px 12px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
</style></head><body><main>
<h1>Assistente de ${esc(opts.dono)}</h1>
<div class="faixa"><span>${pausada ? "⏸️ Autonomia pausada: nada sai sem o seu ok." : "Autonomia ligada (por contato)."}</span>${botao(base, pausada ? "retoma" : "pausa", pausada ? "Retomar" : "Pausar tudo")}</div>
<h2>Esperando sua aprovação</h2>${secRascunhos}
<h2>Compromissos</h2>${secCompromissos}
<h2>Esperando resposta sua</h2>${secEsperando}
<h2>Pessoas e autonomia</h2>${secPessoas}
<h2>Seu perfil</h2>${secPerfil}
</main></body></html>`;
}

/**
 * O botão do painel vira o mesmo comando do WhatsApp: uma regra só para os dois
 * lugares, e a resposta do comando cai no chat do dono como registro do que foi feito.
 */
export function comandoDoPainel(
  campos: Record<string, string>,
): { texto: string } | { autonomia: { jid: string; nivel: number | null } } | null {
  const id = /^\d+$/.test(campos.id ?? "") ? Number(campos.id) : null;
  switch (campos.acao) {
    case "enviar":
      return id ? { texto: `ok ${id}` } : null;
    case "descartar":
      return id ? { texto: `descarta ${id}` } : null;
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
    case "autonomia": {
      if (!campos.jid) return null;
      const nivel = campos.nivel === "" ? null : Number(campos.nivel);
      if (nivel !== null && !(nivel >= 0 && nivel <= 3)) return null;
      return { autonomia: { jid: campos.jid, nivel } };
    }
    default:
      return null;
  }
}
