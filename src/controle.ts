import { adicionarInteresse, descreverInteresse, lerInteresse, listarInteresses, removerInteresse, textoDosInteresses, ultimasOfertas } from "./ofertas.js";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { gravarEstado, lerEstado, type Db } from "./db.js";
import { estudar } from "./conhecer.js";
import { enderecosEm, ferramentasGoogle } from "./ferramentas_google.js";
import { agoraPorExtenso, dataCurta, linhas } from "./formato.js";
import type { Google } from "./google.js";
import type { Ia } from "./ia.js";
import { escreverRascunho, previa, proporResposta } from "./rascunho.js";
import { relatorioDeCusto } from "./consumo.js";
import { corrigirLeitura } from "./corrigir.js";
import { cuidarDoItem, gravarPauta, itemDaPauta, lerPauta, type DepsPauta } from "./pauta.js";
import { atualizarCaderno, contextoDoChat, lerCaderno, limparCaderno } from "./memoria.js";
import * as repo from "./repo.js";
import { montarResumo } from "./resumo.js";
import type { Evolution } from "./whatsapp/evolution.js";

export interface DepsControle {
  db: Db;
  ia: Ia;
  evolution: Evolution;
  dono: string;
  fuso: string;
  /** `refs`: quem foi citado na mensagem (nome = jid), guardado só no diálogo. */
  avisar(texto: string, refs?: string): Promise<void>;
  /** O resumo como imagem; sem isto, sai em texto. */
  enviarResumo?(): Promise<void>;
  /** Agenda e Gmail, quando configurados. */
  google?: Google;
  expediente?: { inicioH: number; fimH: number };
  sincronizarAgenda?: boolean;
  /** MCP do KoreOS, quando configurado. */
  koreos?: { url: string; token: string };
  autonomiaPadrao?: number;
}

export const NIVEIS = [
  "só quando você pede",
  "propõe resposta e espera seu ok",
  "envia se você não vetar",
  "envia o simples direto",
];

/**
 * Comandos de uma palavra no canal de controle. Decididos aqui, sem passar pelo
 * Claude: enviar, descartar e tirar alguém do assistente não podem depender de
 * interpretação.
 */
export type Comando =
  | { tipo: "enviar"; id?: number }
  | { tipo: "descartar"; id?: number }
  | { tipo: "ajustar"; id?: number; instrucao: string }
  | { tipo: "compromisso"; acao: "confirmado" | "feito" | "descartado"; id: number }
  | { tipo: "excluir"; nome: string }
  | { tipo: "incluir"; nome: string }
  | { tipo: "promo"; nome: string }
  | { tipo: "acompanhar"; nome: string; sim: boolean }
  | { tipo: "interesse"; termos: string; preco_max: number | null }
  | { tipo: "interesses" }
  | { tipo: "esquecerInteresse"; id: number }
  | { tipo: "resumo" }
  | { tipo: "perfil" }
  | { tipo: "regra"; texto: string }
  | { tipo: "esquecer"; id: number }
  | { tipo: "estudar" }
  | { tipo: "cobrar"; nome: string }
  | { tipo: "autonomia"; nome?: string; nivel?: number }
  | { tipo: "pausa" }
  | { tipo: "retoma" }
  | { tipo: "custo" }
  | { tipo: "errado"; id: number; texto: string }
  | { tipo: "item"; acao: "resolvi" | "adia" | "ignora" | "responde" | "cobra"; letra: string; resto: string; texto: string }
  | { tipo: "caderno"; limpar: boolean }
  | { tipo: "ajuda" }
  | { tipo: "pedido"; texto: string };

export function lerComando(texto: string): Comando {
  const t = texto.trim();
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(ok|envia|enviar|manda|pode mandar)(?:\s+#?(\d+))?[.!]?$/i)))
    return { tipo: "enviar", id: m[2] ? Number(m[2]) : undefined };
  if ((m = t.match(/^(descarta|descartar|cancela|veta|não manda|nao manda)(?:\s+#?(\d+))?[.!]?$/i)))
    return { tipo: "descartar", id: m[2] ? Number(m[2]) : undefined };
  if ((m = t.match(/^ajusta(?:r)?(?:\s+#?(\d+))?[\s:,-]+([\s\S]+)$/i)))
    return { tipo: "ajustar", id: m[1] ? Number(m[1]) : undefined, instrucao: m[2].trim() };
  if ((m = t.match(/^(confirma|feito|ignora)\s+#?(\d+)$/i))) {
    const acao = { confirma: "confirmado", feito: "feito", ignora: "descartado" }[m[1].toLowerCase()] as
      | "confirmado"
      | "feito"
      | "descartado";
    return { tipo: "compromisso", acao, id: Number(m[2]) };
  }
  if ((m = t.match(/^(fora|exclui|excluir)\s+(.+)$/i)) && pareceNome(m[2])) return { tipo: "excluir", nome: m[2].trim() };
  if ((m = t.match(/^(volta|inclui|incluir)\s+(.+)$/i)) && pareceNome(m[2])) return { tipo: "incluir", nome: m[2].trim() };
  if ((m = t.match(/^promo(?:[çc][ãa]o)?\s+(.+)$/i)) && pareceNome(m[1])) return { tipo: "promo", nome: m[1].trim() };
  if ((m = t.match(/^(acompanha|acompanhar|segue|seguir)\s+(?:o\s+)?(?:grupo\s+)?(.+)$/i)) && pareceNome(m[2])) return { tipo: "acompanhar", nome: m[2].trim(), sim: true };
  if ((m = t.match(/^(solta|soltar|deixa de acompanhar|para de acompanhar)\s+(?:o\s+)?(?:grupo\s+)?(.+)$/i)) && pareceNome(m[2]))
    return { tipo: "acompanhar", nome: m[2].trim(), sim: false };
  if (/^(interesses|meus interesses|ofertas)[.!?]?$/i.test(t)) return { tipo: "interesses" };
  if ((m = t.match(/^esquece\s+(?:o\s+)?interesse\s+#?(\d+)[.!]?$/i))) return { tipo: "esquecerInteresse", id: Number(m[1]) };
  if ((m = t.match(/^interesse[\s:,-]+([\s\S]+)$/i))) {
    const i = lerInteresse(m[1]);
    if (i) return { tipo: "interesse", ...i };
  }
  if (/^(resumo|bom dia)[.!]?$/i.test(t)) return { tipo: "resumo" };
  if (/^(perfil|meu perfil)[.!?]?$/i.test(t)) return { tipo: "perfil" };
  if ((m = t.match(/^regra[\s:,-]+([\s\S]+)$/i))) return { tipo: "regra", texto: m[1].trim() };
  if ((m = t.match(/^esquece(?:\s+(?:a\s+)?(?:regra|li[çc][ãa]o))?\s+#?(\d+)$/i))) return { tipo: "esquecer", id: Number(m[1]) };
  if (/^(estuda|estudar)[.!]?$/i.test(t)) return { tipo: "estudar" };
  if ((m = t.match(/^cobra(?:r)?\s+(.+)$/i))) return { tipo: "cobrar", nome: m[1].trim() };
  if (/^autonomia[.!?]?$/i.test(t)) return { tipo: "autonomia" };
  if ((m = t.match(/^autonomia\s+(.+?)\s+([0-3])$/i))) return { tipo: "autonomia", nome: m[1].trim(), nivel: Number(m[2]) };
  if (/^(pausa|pausar|para tudo)[.!]?$/i.test(t)) return { tipo: "pausa" };
  if (/^(retoma|retomar|volta a responder)[.!]?$/i.test(t)) return { tipo: "retoma" };
  if (/^(custo|gasto|consumo)[.!?]?$/i.test(t)) return { tipo: "custo" };
  if ((m = t.match(/^errado\s+#?(\d+)[\s:,.-]*([\s\S]*)$/i))) return { tipo: "errado", id: Number(m[1]), texto: m[2].trim() };
  const item = itemDoComando(t);
  if (item) return item;
  if (/^caderno[.!?]?$/i.test(t)) return { tipo: "caderno", limpar: false };
  if (/^(esquece|limpa)\s+(o\s+)?caderno[.!]?$/i.test(t)) return { tipo: "caderno", limpar: true };
  if (/^(ajuda|help|\?)$/i.test(t)) return { tipo: "ajuda" };
  return { tipo: "pedido", texto: t };
}

const VERBOS_ITEM: Record<string, "resolvi" | "adia" | "ignora" | "responde" | "cobra"> = {
  resolvi: "resolvi",
  resolvido: "resolvi",
  feito: "resolvi",
  "já foi": "resolvi",
  "ja foi": "resolvi",
  adia: "adia",
  adiar: "adia",
  ignora: "ignora",
  ignorar: "ignora",
  responde: "responde",
  responder: "responde",
  cobra: "cobra",
  cobrar: "cobra",
};

/**
 * "resolvi B", "adia C sábado", "responde A diz que amanhã eu ligo": a letra é do item
 * do último resumo. "a", "e" e "o" minúsculos são palavras ("responde a Ana", "adia o
 * almoço"), não letras: para eles, só maiúscula vale. O que não casar vai para o agente.
 */
export function itemDoComando(t: string): Extract<Comando, { tipo: "item" }> | null {
  const m = t.match(/^(resolvi|resolvido|feito|j[áa] foi|adiar?|ignorar?|responder?|cobrar?)\s+(?:(?:o|a|item)\s+)?([a-zA-Z])(?=$|[\s:,.!-])[\s:,.!-]*([\s\S]*)$/i);
  if (!m) return null;
  const letra = m[2];
  if (/[aeo]/.test(letra)) return null;
  return { tipo: "item", acao: VERBOS_ITEM[m[1].toLowerCase()], letra: letra.toUpperCase(), resto: m[3].trim(), texto: t };
}

const AJUDA = `*Comandos*
• ok N — envia o rascunho N (sem número: só se houver um aguardando)
• ajusta N <o quê> — refaz o rascunho
• descarta N
• confirma N · feito N · ignora N — compromissos
• fora <nome> — tira a conversa ou o grupo do assistente (e apaga o que já tinha)
• volta <nome> — põe de volta
• acompanha <grupo> — leio o grupo sempre (obra, projeto), não só quando citam você, e descrevo as fotos · solta <grupo> desfaz
• promo <grupo> — grupo de promoção: sai do assistente, mas as ofertas passam pelos seus interesses
• interesse <palavras> até <valor> — me avisa quando sair oferta assim ("interesse monitor 27 até 900"; "-palavra" exclui)
• interesses — a lista, os grupos vigiados e as últimas ofertas · esquece interesse N
• resumo
• perfil — o que eu sei de você
• regra <texto> — uma regra sua ("regra nunca marco nada antes das 9")
• esquece N — apaga a regra ou lição N
• estuda — atualiza agora as fichas e o seu perfil
• cobra <nome> — rascunho cobrando o que a pessoa ficou de mandar
• autonomia — quem tem qual nível e a sua taxa de aprovação
• autonomia <nome> <0-3> — 0 só quando você pede · 1 propõe resposta · 2 envia se você não vetar · 3 envia o simples direto
• veta N — não envia o rascunho N
• pausa · retoma — desliga e religa todo envio automático
• *Pelas letras do resumo* (A, B, C…):
  resolvi B — já resolvi por fora (liguei, falei pessoalmente) · adia B sábado (amanhã, 3 dias, 25/10)
  ignora B — não precisava de resposta, e eu aprendo · responde B <o quê> · cobra B
• errado N <o quê> — corrige o compromisso N e eu aprendo para as próximas ("errado 1 quem vai ler é ele")
  (para o resto, diga com suas palavras: "a Thaís é notificação do KoreOS", "o João não espera resposta")
• custo — quanto o assistente gastou com o Claude (hoje, 7 e 30 dias)
• caderno — o que estou acompanhando entre nós · esquece caderno — zera
• áudio também vale: fale o pedido
Fora isso, é só pedir: "o que eu combinei com a Fernanda?", "responde o João dizendo que amanhã não dá".`;

export async function tratarComando(deps: DepsControle, texto: string): Promise<void> {
  const c = lerComando(texto);
  switch (c.tipo) {
    case "enviar":
      return enviarRascunho(deps, c.id);
    case "descartar": {
      const r = await rascunhoDoComando(deps, c.id);
      if (!r) return;
      if (!(await repo.decidirRascunho(deps.db, r.id, "descartado"))) return deps.avisar(`O #${r.id} já tinha sido decidido.`);
      return deps.avisar(`Rascunho #${r.id} descartado.`);
    }
    case "ajustar": {
      const r = await rascunhoDoComando(deps, c.id);
      if (!r) return;
      // Sai do envio automático antes de chamar o modelo, que leva segundos: o prazo de
      // veto não pode vencer no meio e mandar o texto antigo. Conta contra a taxa de acerto.
      const ainda = await deps.db.query("UPDATE rascunhos SET ajustado = TRUE, enviar_em = NULL WHERE id = $1 AND status = 'aguardando'", [r.id]);
      if (!ainda.rowCount) return deps.avisar(`O #${r.id} já tinha sido decidido.`);
      const novo = await escreverRascunho(deps, r.chat_jid, `${r.pedido}\nAjuste: ${c.instrucao}`, r.texto);
      if (!(await repo.atualizarRascunho(deps.db, r.id, novo))) return deps.avisar(`O #${r.id} foi decidido enquanto eu ajustava.`);
      // O pedido guarda os ajustes: o "ajusta" seguinte e as lições partem deles.
      await deps.db.query("UPDATE rascunhos SET pedido = $2 WHERE id = $1", [r.id, `${r.pedido}\nAjuste: ${c.instrucao}`]);
      const contato = await repo.lerContato(deps.db, r.chat_jid);
      return deps.avisar(previa(r.id, contato ? repo.nomeDe(contato) : r.chat_jid, novo));
    }
    case "compromisso": {
      const ok = await repo.mudarCompromisso(deps.db, c.id, c.acao);
      if (!ok) return deps.avisar(`Não achei o compromisso #${c.id}.`);
      const extra = c.acao === "confirmado" ? await levarParaAgenda(deps, c.id) : "";
      return deps.avisar(`Compromisso #${c.id}: ${c.acao}.${extra}`);
    }
    case "cobrar":
      return cobrar(deps, c.nome);
    case "autonomia":
      return c.nome === undefined ? deps.avisar(await relatorioAutonomia(deps)) : mudarAutonomia(deps, c.nome, c.nivel!);
    case "pausa":
      await gravarEstado(deps.db, "autonomia:pausada", "1");
      // O que estava para sair sozinho volta a esperar ok.
      await deps.db.query("UPDATE rascunhos SET enviar_em = NULL WHERE status = 'aguardando' AND enviar_em IS NOT NULL");
      return deps.avisar("Pausado: nada sai sem o seu ok. Rascunhos agendados voltaram a esperar. (retoma religa)");
    case "retoma":
      await gravarEstado(deps.db, "autonomia:pausada", "0");
      return deps.avisar("Retomado: a autonomia de cada contato volta a valer.");
    case "excluir":
    case "incluir":
      return alternarChat(deps, c.nome, c.tipo === "excluir");
    case "promo":
      return marcarGrupoDePromo(deps, c.nome);
    case "acompanhar":
      return acompanharPeloNome(deps, c.nome, c.sim);
    case "interesse": {
      const id = await adicionarInteresse(deps.db, c.termos, c.preco_max);
      return deps.avisar(`Anotado: ${descreverInteresse({ id, termos: c.termos, preco_max: c.preco_max })}. Aviso quando sair nos grupos de promoção.`);
    }
    case "interesses":
      return deps.avisar(textoDosInteresses(await listarInteresses(deps.db), await repo.gruposDePromo(deps.db), await ultimasOfertas(deps.db)));
    case "esquecerInteresse":
      return deps.avisar((await removerInteresse(deps.db, c.id)) ? `Interesse #${c.id} apagado.` : `Não há interesse #${c.id}.`);
    case "resumo": {
      if (deps.enviarResumo) return deps.enviarResumo();
      const r = await montarResumo(deps);
      await gravarPauta(deps.db, r.pauta);
      return deps.avisar(r.texto, r.refs);
    }
    case "item":
      return agirNoItem(deps, c);
    case "errado":
      if (!c.texto) return deps.avisar(`Diga o que está errado: errado ${c.id} <o quê>.`);
      return deps.avisar(await corrigirLeitura(deps, { compromisso: c.id }, c.texto));
    case "custo":
      return deps.avisar(await relatorioDeCusto(deps.db));
    case "caderno": {
      if (c.limpar) {
        await limparCaderno(deps.db);
        return deps.avisar("Caderno zerado. Suas regras e o seu perfil continuam.");
      }
      const caderno = await lerCaderno(deps.db);
      return deps.avisar(caderno ? `*O que estou acompanhando*\n${caderno}` : "O caderno está vazio.");
    }
    case "perfil":
      return deps.avisar(await mostrarPerfil(deps));
    case "regra": {
      const id = await repo.acrescentarPerfil(deps.db, "regra", c.texto);
      return deps.avisar(id ? `Regra #${id} anotada. Vale para tudo que eu escrever.` : "Essa regra já estava anotada.");
    }
    case "esquecer": {
      const ok = await repo.desativarPerfil(deps.db, c.id);
      return deps.avisar(ok ? `Esqueci o #${c.id}.` : `Não achei regra ou lição #${c.id}.`);
    }
    case "estudar": {
      await deps.avisar("Estudando as conversas, leva alguns minutos…");
      return deps.avisar(`Pronto: ${await estudar(deps, { fichas: 40, forcarPerfil: true })}.`);
    }
    case "ajuda":
      return deps.avisar(AJUDA);
    case "pedido":
      return atenderPedido(deps, c.texto);
  }
}

async function mostrarPerfil(deps: DepsControle): Promise<string> {
  const p = await repo.lerPerfil(deps.db);
  const partes = [
    p.regras.length ? `*Suas regras*\n${p.regras.map((r) => `#${r.id} ${r.texto}`).join("\n")}` : "*Suas regras*\nnenhuma ainda (regra <texto>)",
    p.licoes.length ? `*O que aprendi com as suas correções*\n${p.licoes.map((r) => `#${r.id} ${r.texto}`).join("\n")}` : "",
    p.leituras.length ? `*O que aprendi lendo as conversas*\n${p.leituras.map((r) => `#${r.id} ${r.texto}`).join("\n")}` : "",
    p.gerado ? `*Seu retrato*\n${p.gerado}` : "Ainda não tenho mensagens suficientes suas para um retrato (estuda força).",
  ];
  return partes.filter(Boolean).join("\n\n") + "\n\n_esquece N apaga uma regra ou lição_";
}

/**
 * O rascunho a que o comando se refere. Sem número, só vale se houver um aguardando:
 * a autonomia cria rascunhos sozinha, e um "ok" pensado para a prévia que o dono leu
 * não pode mandar outro que chegou segundos antes.
 */
async function rascunhoDoComando(deps: DepsControle, id?: number): Promise<repo.Rascunho | null> {
  if (id !== undefined) {
    const r = await repo.lerRascunho(deps.db, id);
    if (r?.status === "aguardando") return r;
    await deps.avisar("Não há rascunho aguardando com esse número.");
    return null;
  }
  const abertos = await repo.rascunhosAguardando(deps.db, 6);
  if (abertos.length === 1) return abertos[0];
  await deps.avisar(
    abertos.length
      ? `Há ${abertos.length > 5 ? "mais de 5" : abertos.length} rascunhos aguardando: diga o número (${abertos
          .slice(0, 5)
          .map((r) => `#${r.id}`)
          .join(", ")}).`
      : "Não há rascunho aguardando.",
  );
  return null;
}

async function enviarRascunho(deps: DepsControle, id?: number): Promise<void> {
  const r = await rascunhoDoComando(deps, id);
  if (!r) return;
  if (/\[preencher:/i.test(r.texto)) {
    return deps.avisar(`O rascunho #${r.id} ainda tem [preencher: …]. Ajuste antes de enviar.`);
  }
  if (!(await executarEnvio(deps, r))) {
    const agora = await repo.lerRascunho(deps.db, r.id);
    if (agora?.status !== "aguardando") await deps.avisar(`O #${r.id} já tinha sido decidido.`);
  }
}

/**
 * Envia um rascunho que já pode sair (pelo ok do dono, ou pela autonomia que ele deu,
 * com `auto`). É o único lugar do código que manda mensagem a um contato.
 */
export async function executarEnvio(
  deps: Pick<DepsControle, "db" | "evolution" | "avisar">,
  r: repo.Rascunho,
  sufixo = "",
  auto?: repo.EnvioAutomatico,
): Promise<boolean> {
  // Reserva antes de enviar, e envia o texto que a reserva devolveu (o atual, não o
  // lido antes): um segundo "ok", um veto ou um ajuste no meio não escapam.
  const reservado = await repo.reservarEnvio(deps.db, r.id, auto);
  if (!reservado) return false;
  try {
    const anexo = reservado.anexo_id ? await repo.lerAnexo(deps.db, reservado.anexo_id) : null;
    // Anexo apagado (passou dos 30 dias) não vira só texto sem o dono saber.
    if (reservado.anexo_id && !anexo) throw new Error("o anexo não existe mais; prepare de novo");
    const mensagemId = anexo
      ? await deps.evolution.enviarArquivo(reservado.chat_jid, anexo, reservado.texto)
      : await deps.evolution.enviarTexto(reservado.chat_jid, reservado.texto);
    // O id separa esta mensagem das que ele escreveu à mão: só as dele ensinam estilo.
    if (mensagemId) await deps.db.query("UPDATE rascunhos SET mensagem_id = $2 WHERE id = $1", [r.id, mensagemId]);
    // A Evolution GO não devolve pelo webhook o que a API envia: sem gravar aqui, a
    // conversa não tem a resposta, e o próximo rascunho agradece de novo o que já foi
    // agradecido. Se o eco vier, o mesmo id não duplica.
    await repo.gravarMensagem(
      deps.db,
      {
        id: mensagemId || `rascunho-${r.id}`,
        chatJid: reservado.chat_jid,
        remetenteJid: null,
        remetenteNome: null,
        deMim: true,
        grupo: false,
        tipo: anexo ? (anexo.mimetype.startsWith("image/") ? "imagem" : "documento") : "texto",
        texto: reservado.texto,
        enviadaEm: new Date(),
        bruto: {},
        jidAlternativo: null,
      },
      anexo ? `[arquivo: ${anexo.nome}]${reservado.texto ? ` ${reservado.texto}` : ""}` : reservado.texto,
      true,
    );
    await repo.donoRespondeu(deps.db, reservado.chat_jid);
  } catch (err) {
    await deps.db.query("UPDATE rascunhos SET status = 'aguardando', decidido_em = NULL, enviar_em = NULL WHERE id = $1", [r.id]);
    // Sem resposta a tempo, a mensagem pode ter saído: o dono confere antes de repetir.
    const talvez = err instanceof Error && err.name === "TimeoutError";
    await deps.avisar(
      talvez
        ? `O WhatsApp não respondeu a tempo no #${r.id}: a mensagem pode ter saído. Confira a conversa antes de mandar ok ${r.id} de novo.`
        : `Não consegui enviar o #${r.id}: ${String(err).slice(0, 200)}`,
    );
    return false;
  }
  const contato = await repo.lerContato(deps.db, reservado.chat_jid);
  await deps.avisar(`Enviado para ${contato ? repo.nomeDe(contato) : reservado.chat_jid} ✅${sufixo}`);
  return true;
}

/** Compromisso confirmado, com data e do dono, vira evento na agenda (1 hora). */
async function levarParaAgenda(deps: DepsControle, id: number): Promise<string> {
  if (!deps.google || !deps.sincronizarAgenda) return "";
  const r = await deps.db.query<{ descricao: string; quando: Date | null; responsavel: string; evento_id: string | null; contato: string }>(
    `SELECT k.descricao, k.quando, k.responsavel, k.evento_id, ${repo.NOME_SQL} AS contato
     FROM compromissos k JOIN contatos c ON c.jid = k.chat_jid WHERE k.id = $1`,
    [id],
  );
  const k = r.rows[0];
  if (!k?.quando || k.evento_id || k.responsavel === "contato") return "";
  try {
    const inicio = new Date(k.quando);
    const eventoId = await deps.google.criarEvento({
      titulo: `${k.descricao} (${k.contato})`,
      inicio,
      fim: new Date(inicio.getTime() + 3600_000),
      descricao: `Anotado pelo assistente a partir da conversa com ${k.contato}.`,
    });
    await deps.db.query("UPDATE compromissos SET evento_id = $2 WHERE id = $1", [id, eventoId]);
    return " Coloquei na agenda.";
  } catch {
    return " (Não consegui pôr na agenda.)";
  }
}

async function acharUm(deps: DepsControle, nome: string): Promise<repo.Contato | null> {
  const achados = (await repo.buscarContatos(deps.db, nome, 5)).filter((c) => !c.excluido);
  if (!achados.length) {
    await deps.avisar(`Não achei "${nome}".`);
    return null;
  }
  const exato = achados.filter((c) => repo.nomeDe(c).toLowerCase() === nome.toLowerCase());
  const alvo = exato.length === 1 ? exato[0] : achados.length === 1 ? achados[0] : null;
  if (!alvo) {
    await deps.avisar(`Achei mais de um. Mande o nome exato:\n${achados.map((c) => `• ${repo.nomeDe(c)}${c.grupo ? " (grupo)" : ""}`).join("\n")}`);
  }
  return alvo;
}

/** O que fazer com a letra: resolver, adiar e ignorar ficam em `pauta.ts`; responder e cobrar, aqui. */
async function agirNoItem(deps: DepsControle, c: Extract<Comando, { tipo: "item" }>): Promise<void> {
  const pauta = await lerPauta(deps.db);
  // Sem resumo recente, a letra não aponta para nada: o agente lê a frase inteira.
  if (!pauta.length) return atenderPedido(deps, c.texto);
  const item = pauta.find((x) => x.letra === c.letra);
  if (!item) return deps.avisar(`Não há item ${c.letra} no último resumo (${pauta.map((x) => x.letra).join(", ")}).`);

  if (c.acao === "resolvi" || c.acao === "adia" || c.acao === "ignora") {
    return deps.avisar(await cuidarDoItem(depsDaPauta(deps), item, c.acao, c.resto));
  }
  if (item.tipo === "email") {
    return atenderPedido(deps, `Deixe no Gmail um rascunho de resposta ao e-mail "${item.titulo}" (id ${item.emailId}). ${c.resto}`);
  }
  if (!item.jid) return deps.avisar(`O ${item.letra} não é uma conversa para ${c.acao === "cobra" ? "cobrar" : "responder"}.`);
  const contato = await repo.lerContato(deps.db, item.jid);
  if (!contato || contato.excluido) return deps.avisar("Essa conversa não está mais no assistente.");
  if (c.acao === "cobra") return cobrarContato(deps, contato);
  await proporResposta(deps, contato.jid, c.resto || `Responder ao que está pendente: ${contato.situacao || "a última mensagem"}.`);
}

export function depsDaPauta(deps: DepsControle): DepsPauta {
  return {
    db: deps.db,
    fuso: deps.fuso,
    corrigir: (jid, correcao) => corrigirLeitura(deps, { jid }, correcao),
  };
}

async function cobrar(deps: DepsControle, nome: string): Promise<void> {
  const c = await acharUm(deps, nome);
  if (!c) return;
  return cobrarContato(deps, c);
}

async function cobrarContato(deps: DepsControle, c: repo.Contato): Promise<void> {
  const assunto = c.aguardando || "o que ficou pendente na conversa";
  await proporResposta(deps, c.jid, `Cobrar com educação, sem soar insistente: ${assunto}.`);
  await repo.marcarCobrado(deps.db, c.jid);
}

async function mudarAutonomia(deps: DepsControle, nome: string, nivel: number): Promise<void> {
  const c = await acharUm(deps, nome);
  if (!c) return;
  if (c.grupo && nivel > 0) return deps.avisar("Em grupo eu não respondo sozinho: quem responde em grupo é você.");
  await repo.definirAutonomia(deps.db, c.jid, nivel);
  const aviso = nivel >= 1 ? " Dinheiro, preço, contrato, prazo e assunto delicado sempre esperam o seu ok." : "";
  return deps.avisar(`${repo.nomeDe(c)}: nível ${nivel} (${NIVEIS[nivel]}).${aviso}`);
}

async function relatorioAutonomia(deps: DepsControle): Promise<string> {
  const pausada = (await lerEstado(deps.db, "autonomia:pausada")) === "1";
  const padrao = deps.autonomiaPadrao ?? 0;
  const linhasAcerto = await repo.acertos(deps.db);
  const comNivel = await deps.db.query<{ nome: string; autonomia: number }>(
    `SELECT ${repo.nomeSql('')} AS nome, autonomia FROM contatos
     WHERE autonomia IS NOT NULL AND NOT excluido ORDER BY autonomia DESC, nome`,
  );
  const partes = [
    pausada ? "⏸️ *Autonomia pausada*: nada sai sem ok (retoma religa)." : "",
    `Padrão: nível ${padrao} (${NIVEIS[padrao]}).`,
    comNivel.rows.length ? `*Níveis próprios*\n${comNivel.rows.map((x) => `• ${x.nome}: ${x.autonomia}`).join("\n")}` : "",
    linhasAcerto.length
      ? `*Aprovação sem ajuste*\n${linhasAcerto
          .slice(0, 12)
          .map((x) => `• ${x.nome}: ${x.sem_ajuste}/${x.decididos}${sugerirSubir(x) ? " → dá para subir de nível" : ""}`)
          .join("\n")}`
      : "Ainda não há rascunhos decididos para medir.",
  ];
  return partes.filter(Boolean).join("\n\n");
}

/** Dez rascunhos decididos e nove em dez sem ajuste: o assistente já escreve como ele ali. */
export function sugerirSubir(x: { decididos: number; sem_ajuste: number; autonomia: number | null }): boolean {
  return x.decididos >= 10 && x.sem_ajuste / x.decididos >= 0.9 && (x.autonomia ?? 0) < 3;
}

/** "acompanha <grupo>" e "solta <grupo>": só grupo, e só um. */
async function acompanharPeloNome(deps: DepsControle, nome: string, sim: boolean): Promise<void> {
  const achados = (await repo.buscarContatos(deps.db, nome, 5)).filter((c) => c.grupo && !c.excluido);
  if (!achados.length) return deps.avisar(`Não achei grupo "${nome}".`);
  const exato = achados.filter((c) => repo.nomeDe(c).toLowerCase() === nome.toLowerCase());
  const alvo = exato.length === 1 ? exato[0] : achados.length === 1 ? achados[0] : null;
  if (!alvo) return deps.avisar(`Achei mais de um. Mande o nome exato:\n${achados.map((c) => `• ${repo.nomeDe(c)}`).join("\n")}`);
  await repo.acompanharGrupo(deps.db, alvo.jid, sim);
  return deps.avisar(
    sim
      ? `Acompanhando ${repo.nomeDe(alvo)}: leio tudo o que chegar (não só quando citam você) e descrevo as fotos.`
      : `${repo.nomeDe(alvo)} volta ao normal: só leio quando citam você.`,
  );
}

/** "promo <grupo>": só grupo, e só um. Apaga o que havia, como o `fora`. */
async function marcarGrupoDePromo(deps: DepsControle, nome: string): Promise<void> {
  const achados = (await repo.buscarContatos(deps.db, nome, 5)).filter((c) => c.grupo);
  if (!achados.length) return deps.avisar(`Não achei grupo "${nome}".`);
  const exato = achados.filter((c) => repo.nomeDe(c).toLowerCase() === nome.toLowerCase());
  const alvo = exato.length === 1 ? exato[0] : achados.length === 1 ? achados[0] : null;
  if (!alvo) return deps.avisar(`Achei mais de um. Mande o nome exato:\n${achados.map((c) => `• ${repo.nomeDe(c)}`).join("\n")}`);
  await repo.marcarPromo(deps.db, alvo.jid);
  return deps.avisar(`${repo.nomeDe(alvo)} virou grupo de promoção: não guardo mais as mensagens, só comparo as ofertas com os seus interesses.`);
}

async function alternarChat(deps: DepsControle, nome: string, excluir: boolean): Promise<void> {
  const achados = await repo.buscarContatos(deps.db, nome, 5);
  if (!achados.length) return deps.avisar(`Não achei "${nome}".`);
  const exato = achados.filter((c) => repo.nomeDe(c).toLowerCase() === nome.toLowerCase());
  const alvo = exato.length === 1 ? exato[0] : achados.length === 1 ? achados[0] : null;
  if (!alvo) {
    const lista = achados.map((c) => `• ${repo.nomeDe(c)}${c.grupo ? " (grupo)" : ""}`).join("\n");
    return deps.avisar(`Achei mais de um. Mande o nome exato:\n${lista}`);
  }
  await repo.excluirChat(deps.db, alvo.jid, excluir);
  return deps.avisar(
    excluir
      ? `${repo.nomeDe(alvo)} saiu do assistente, e o que eu tinha guardado foi apagado.`
      : `${repo.nomeDe(alvo)} voltou para o assistente (a partir de agora).`,
  );
}

function sistemaAgente(dono: string, perfil: string, extras: string[]): string {
  return `Você é o assistente pessoal de ${dono}. Você conversa com ele no chat dele consigo mesmo no WhatsApp e tem acesso às conversas dele pelas ferramentas.
- Responda curto, em português, no estilo de WhatsApp (*negrito* para destacar). Sem preâmbulo.
- Para falar de alguém, ache o contato com buscar_contato e leia a conversa antes de responder. Diga de onde tirou a informação (data da mensagem).
- Você nunca envia mensagem de WhatsApp a ninguém. Para responder um contato, use propor_resposta: ele recebe o rascunho e decide.
- Se ele disser como prefere as coisas ("nunca marco antes das 9", "com cliente sempre formal"), guarde com registrar_regra.
- Mensagem curta ("sim", "pode", "esse", "o segundo", "faz isso") responde ao que está na CONVERSA RECENTE e no CADERNO: resolva por eles e aja. Só pergunte se de fato houver duas leituras.
- Contato sem nome: diga quem é pelo que a ficha e a conversa mostram ("o cliente da obra do Largo"), nunca só o número.
- Se ele disser que algo que você entendeu está errado (um compromisso, quem espera resposta, a situação de uma conversa, alguém que é robô), use corrigir_leitura: corrige e ensina a leitura das próximas.
- Se não achar a informação, diga que não achou. Não invente.${extras.map((e) => `\n- ${e}`).join("")}${perfil ? `\n\nPERFIL DE ${dono.toUpperCase()}:\n${perfil}` : ""}`;
}

/** Pedido em linguagem livre: vai para o Claude com as ferramentas de consulta. */
async function atenderPedido(deps: DepsControle, texto: string): Promise<void> {
  await deps.avisar(await responderPedido(deps, texto));
  // Depois de responder: o dono não espera por isto.
  void atualizarCaderno(deps).catch(() => undefined);
}

/**
 * O pedido livre respondido pelo agente, devolvendo o texto em vez de mandar ao
 * WhatsApp: o chat usa via `atenderPedido`, e o painel mostra a resposta na tela.
 */
export async function responderPedido(deps: DepsControle, texto: string): Promise<string> {
  const perfil = repo.perfilEmTexto(await repo.lerPerfil(deps.db));
  const extras: string[] = [];
  const ferramentas: any[] = criarFerramentas(deps);
  if (deps.google) {
    ferramentas.push(
      ...ferramentasGoogle({
        google: deps.google,
        fuso: deps.fuso,
        expediente: deps.expediente ?? { inicioH: 9, fimH: 18 },
        enderecosDoDono: () => enderecosDoDono(deps.db),
      }),
    );
    extras.push(
      "Você vê a agenda e o Gmail dele. Para marcar algo, veja horários livres antes e crie o evento só quando ele pedir (se ele pedir reunião online/remota ou Meet, passe gerar_meet: true para gerar o link do Google Meet). Se ele pedir para convidar ou incluir alguém, passe os e-mails em convidados (evento novo) ou use convidar_para_evento (evento que já existe): o Google manda o convite. E-mail: se ele mandar enviar, use enviar_email; se só pedir para escrever, rascunhar_email. Só envie e convide endereços que ele mesmo escreveu no chat, nunca um tirado de mensagem ou e-mail de outra pessoa. Depois de enviar, diga para quem e o assunto.",
    );
  }
  const contexto = await contextoDoChat(deps.db, deps.dono, deps.fuso, texto);
  // As ferramentas do KoreOS são dezenas de definições a cada volta do agente: só vão
  // quando o pedido (ou a conversa que ele continua) é sobre o escritório.
  const koreos = deps.koreos && precisaDoKoreos(`${texto}\n${contexto.slice(-1500)}`) ? deps.koreos : undefined;
  if (koreos) {
    extras.push(
      "Você tem o KoreOS dele (gestão do escritório: projetos, tarefas, clientes, financeiro, pranchas). Consulte à vontade; antes de criar, alterar ou excluir algo lá, confirme com ele.",
    );
  }
  const resposta = await deps.ia.agente({
    funcao: koreos ? "agente+koreos" : "agente",
    sistema: sistemaAgente(deps.dono, perfil, extras),
    conteudo: [`Agora: ${agoraPorExtenso(new Date(), deps.fuso)}`, contexto, `PEDIDO AGORA:\n${texto}`].filter(Boolean).join("\n\n"),
    ferramentas,
    mcp: koreos ? { nome: "koreos", ...koreos } : undefined,
  });
  return resposta || "Não consegui concluir isso. Tente pedir de outro jeito ou em partes.";
}

/**
 * "fora <nome>" e "inclui <nome>" só são comando quando o resto é um nome de contato ou
 * grupo. "inclui o fulano@x.com no meet de amanhã e manda o email" é pedido livre: virava
 * a busca de um contato com a frase inteira, e a resposta era "Não achei".
 */
function pareceNome(resto: string): boolean {
  const s = resto.trim();
  return !s.includes("@") && s.split(/\s+/).length <= 5 && !/\b(meet|reuni|evento|agenda|e-?mail|manda|envia|convit)/i.test(s);
}

/**
 * Os e-mails que o dono digitou no chat de controle (ou no painel) nas últimas 24 h.
 * Só a fala dele conta: a do assistente, e o pedido montado pelo código (que leva o
 * assunto de um e-mail de terceiro), podem trazer um endereço que ele nunca escreveu.
 * O chat e o painel registram a fala antes de chamar o agente.
 */
export async function enderecosDoDono(db: Db): Promise<Set<string>> {
  const falas = await repo.dialogoRecente(db, 200, 24);
  return new Set(enderecosEm(falas.filter((f) => f.autor === "dono").map((f) => f.texto).join("\n")));
}

const ASSUNTO_KOREOS =
  /kore|projeto|tarefa|cliente|financeir|pagamento|receb|despesa|fatura|boleto|prancha|proposta|or[çc]amento|obra|cronograma|prazo|equipe|apropria|horas/i;

export function precisaDoKoreos(texto: string): boolean {
  return ASSUNTO_KOREOS.test(texto);
}

/**
 * O jid que o agente mandou, como está guardado: LID vira o número, e conversa que o
 * dono tirou do assistente não existe para o agente.
 */
async function conversaDoAgente(db: Db, jid: string): Promise<repo.Contato | null> {
  const c = await repo.lerContato(db, await repo.resolverJid(db, jid));
  return c && !c.excluido ? c : null;
}

export function criarFerramentas(deps: DepsControle) {
  const { db, dono, fuso } = deps;
  return [
    betaZodTool({
      name: "buscar_contato",
      description: "Acha contatos e grupos pelo nome (ou parte dele). Devolve o jid, o nome e a ficha da pessoa.",
      inputSchema: z.object({ nome: z.string() }),
      run: async ({ nome }) => {
        const achados = await repo.buscarContatos(db, nome, 8);
        if (!achados.length) return "Nenhum contato com esse nome.";
        return achados
          .filter((c) => !c.excluido)
          .map((c) => {
            const ficha = repo.fichaEmTexto(c);
            return `${repo.nomeDe(c)}${c.grupo ? " (grupo)" : ""} — jid ${c.jid}${ficha ? `\n${ficha}` : ""}`;
          })
          .join("\n\n");
      },
    }),
    betaZodTool({
      name: "ler_conversa",
      description: "Lê as últimas mensagens de uma conversa (pelo jid).",
      inputSchema: z.object({ jid: z.string(), quantidade: z.number().int().min(1).max(80).default(40) }),
      run: async ({ jid, quantidade }) => {
        const contato = await conversaDoAgente(db, jid);
        if (!contato) return "Conversa não encontrada.";
        const msgs = await repo.ultimasMensagens(db, contato.jid, quantidade);
        return msgs.length ? linhas(msgs, dono, repo.nomeDe(contato), fuso) : "Sem mensagens guardadas.";
      },
    }),
    betaZodTool({
      name: "buscar_mensagens",
      description: "Busca por palavras em todas as conversas. Use para 'quando falei de X' ou 'quem me mandou Y'.",
      inputSchema: z.object({ termo: z.string() }),
      run: async ({ termo }) => {
        const achadas = await repo.buscarMensagens(db, termo, 20);
        if (!achadas.length) return "Nada encontrado.";
        return achadas
          .map((m) => `[${dataCurta(new Date(m.enviada_em), fuso)}] ${m.contato} — ${m.de_mim ? dono : m.remetente_nome || m.contato}: ${m.texto}`)
          .join("\n");
      },
    }),
    betaZodTool({
      name: "listar_compromissos",
      description: "Compromissos e promessas em aberto (opcionalmente só os dos próximos N dias).",
      inputSchema: z.object({ dias: z.number().int().min(1).max(90).optional() }),
      run: async ({ dias }) => {
        const ate = dias ? new Date(Date.now() + dias * 86400_000) : undefined;
        const lista = await repo.compromissosAbertos(db, ate);
        if (!lista.length) return "Nenhum compromisso em aberto.";
        return lista
          .map((c) => `#${c.id} [${c.status}] ${c.quando ? dataCurta(new Date(c.quando), fuso) : "sem data"} — ${c.descricao} (${c.contato_nome ?? "?"}, responsável: ${c.responsavel})`)
          .join("\n");
      },
    }),
    betaZodTool({
      name: "registrar_compromisso",
      description: "Anota um compromisso que o dono pediu para lembrar.",
      inputSchema: z.object({
        jid: z.string().describe("Conversa a que o compromisso se refere"),
        descricao: z.string(),
        quando: z.string().nullable().describe("ISO 8601 com fuso, ou null"),
        responsavel: z.enum(["eu", "contato", "ambos"]),
      }),
      run: async ({ jid, descricao, quando, responsavel }) => {
        const contato = await conversaDoAgente(db, jid);
        if (!contato) return "Conversa não encontrada: ache o jid com buscar_contato.";
        const d = quando ? new Date(quando) : null;
        const id = await repo.criarCompromisso(db, {
          chatJid: contato.jid,
          descricao,
          quando: d && !Number.isNaN(d.getTime()) ? d : null,
          responsavel,
        });
        if (!id) return "Esse compromisso já estava anotado.";
        await repo.mudarCompromisso(db, id, "confirmado");
        return `Anotado como #${id}.`;
      },
    }),
    betaZodTool({
      name: "lembrar_fato",
      description: "Guarda um fato duradouro sobre um contato (ex.: 'filha se chama Ana').",
      inputSchema: z.object({ jid: z.string(), fato: z.string() }),
      run: async ({ jid, fato }) => {
        const contato = await conversaDoAgente(db, jid);
        if (!contato) return "Conversa não encontrada: ache o jid com buscar_contato.";
        await repo.lembrar(db, contato.jid, [fato]);
        return "Guardado.";
      },
    }),
    betaZodTool({
      name: "cuidar_pendencia",
      description:
        "Dá baixa, adia ou ignora uma pendência: um item do último resumo pela letra, ou uma conversa pelo jid. Use quando ele disser que já resolveu por fora ('já liguei pro X'), que é para lembrar depois, ou que aquilo não precisava de resposta.",
      inputSchema: z.object({
        letra: z.string().nullable().describe("A letra do item no último resumo (A, B…), se ele citou"),
        jid: z.string().nullable().describe("A conversa, se ele citou a pessoa pelo nome (ache com buscar_contato)"),
        acao: z.enum(["resolvi", "adia", "ignora"]),
        quando: z.string().nullable().describe("Para adiar: 'amanhã', 'sábado', '3 dias', '25/10'"),
      }),
      run: async ({ letra, jid, acao, quando }) => {
        const item = letra
          ? await itemDaPauta(db, letra)
          : jid
            ? await (async () => {
                const c = await conversaDoAgente(db, jid);
                return c ? { letra: "", tipo: "espera" as const, titulo: repo.nomeDe(c), jid: c.jid } : null;
              })()
            : null;
        if (!item) return "Não achei esse item: diga a letra do resumo ou ache a pessoa com buscar_contato.";
        return cuidarDoItem(depsDaPauta(deps), item, acao, quando ?? undefined);
      },
    }),
    betaZodTool({
      name: "corrigir_leitura",
      description:
        "Corrige algo que o assistente entendeu errado numa conversa (compromisso pelo número, ou a conversa pelo jid: situação, se espera resposta, se é robô) e guarda a lição para as próximas leituras.",
      inputSchema: z.object({
        compromisso: z.number().int().nullable().describe("Número do compromisso (#N), se a correção é sobre um"),
        jid: z.string().nullable().describe("A conversa, se a correção é sobre ela (ache com buscar_contato)"),
        correcao: z.string().describe("O que ele disse que está errado, nas palavras dele"),
      }),
      run: async ({ compromisso, jid, correcao }) => {
        if (compromisso != null) return corrigirLeitura(deps, { compromisso }, correcao);
        if (jid) return corrigirLeitura(deps, { jid }, correcao);
        return "Diga o número do compromisso ou ache a conversa com buscar_contato.";
      },
    }),
    betaZodTool({
      name: "registrar_regra",
      description: "Guarda uma preferência ou regra do dono, que vale para tudo que o assistente escrever ou fizer.",
      inputSchema: z.object({ regra: z.string().describe("Na primeira pessoa do dono: 'nunca marco reunião antes das 9h'") }),
      run: async ({ regra }) => {
        const id = await repo.acrescentarPerfil(db, "regra", regra);
        return id ? `Regra #${id} guardada.` : "Essa regra já estava guardada.";
      },
    }),
    betaZodTool({
      name: "propor_resposta",
      description:
        "Escreve uma resposta para um contato na voz do dono e manda para ele aprovar. Não envia nada ao contato.",
      inputSchema: z.object({
        jid: z.string(),
        instrucao: z.string().describe("O que a resposta deve dizer, nas palavras do dono"),
      }),
      run: async ({ jid, instrucao }) => {
        const contato = await conversaDoAgente(db, jid);
        if (!contato) return "Conversa não encontrada: ache o jid com buscar_contato.";
        const id = await proporResposta(deps, contato.jid, instrucao);
        return `Rascunho #${id} enviado para aprovação.`;
      },
    }),
  ];
}
