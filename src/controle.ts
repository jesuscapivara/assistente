import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { gravarEstado, lerEstado, type Db } from "./db.js";
import { estudar } from "./conhecer.js";
import { ferramentasGoogle } from "./ferramentas_google.js";
import { agoraPorExtenso, dataCurta, linhas } from "./formato.js";
import type { Google } from "./google.js";
import type { Ia } from "./ia.js";
import { escreverRascunho, previa, proporResposta } from "./rascunho.js";
import * as repo from "./repo.js";
import { montarResumo } from "./resumo.js";
import type { Evolution } from "./whatsapp/evolution.js";

export interface DepsControle {
  db: Db;
  ia: Ia;
  evolution: Evolution;
  dono: string;
  fuso: string;
  avisar(texto: string): Promise<void>;
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
  | { tipo: "resumo" }
  | { tipo: "perfil" }
  | { tipo: "regra"; texto: string }
  | { tipo: "esquecer"; id: number }
  | { tipo: "estudar" }
  | { tipo: "cobrar"; nome: string }
  | { tipo: "autonomia"; nome?: string; nivel?: number }
  | { tipo: "pausa" }
  | { tipo: "retoma" }
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
  if ((m = t.match(/^(fora|exclui|excluir)\s+(.+)$/i))) return { tipo: "excluir", nome: m[2].trim() };
  if ((m = t.match(/^(volta|inclui|incluir)\s+(.+)$/i))) return { tipo: "incluir", nome: m[2].trim() };
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
  if (/^(ajuda|help|\?)$/i.test(t)) return { tipo: "ajuda" };
  return { tipo: "pedido", texto: t };
}

const AJUDA = `*Comandos*
• ok N — envia o rascunho N (sem número: o último)
• ajusta N <o quê> — refaz o rascunho
• descarta N
• confirma N · feito N · ignora N — compromissos
• fora <nome> — tira a conversa ou o grupo do assistente (e apaga o que já tinha)
• volta <nome> — põe de volta
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
• áudio também vale: fale o pedido
Fora isso, é só pedir: "o que eu combinei com a Fernanda?", "responde o João dizendo que amanhã não dá".`;

export async function tratarComando(deps: DepsControle, texto: string): Promise<void> {
  const c = lerComando(texto);
  switch (c.tipo) {
    case "enviar":
      return enviarRascunho(deps, c.id);
    case "descartar": {
      const r = await repo.lerRascunho(deps.db, c.id);
      if (!r || r.status !== "aguardando") return deps.avisar("Não há rascunho aguardando com esse número.");
      await repo.decidirRascunho(deps.db, r.id, "descartado");
      return deps.avisar(`Rascunho #${r.id} descartado.`);
    }
    case "ajustar": {
      const r = await repo.lerRascunho(deps.db, c.id);
      if (!r || r.status !== "aguardando") return deps.avisar("Não há rascunho aguardando com esse número.");
      const novo = await escreverRascunho(deps, r.chat_jid, `${r.pedido}\nAjuste: ${c.instrucao}`, r.texto);
      await repo.atualizarRascunho(deps.db, r.id, novo);
      // Mexeu, então decide: sai do envio automático e conta contra a taxa de acerto.
      await deps.db.query("UPDATE rascunhos SET ajustado = TRUE, enviar_em = NULL WHERE id = $1", [r.id]);
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
    case "resumo":
      return deps.avisar(await montarResumo(deps));
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
    p.gerado ? `*Seu retrato*\n${p.gerado}` : "Ainda não tenho mensagens suficientes suas para um retrato (estuda força).",
  ];
  return partes.filter(Boolean).join("\n\n") + "\n\n_esquece N apaga uma regra ou lição_";
}

async function enviarRascunho(deps: DepsControle, id?: number): Promise<void> {
  const r = await repo.lerRascunho(deps.db, id);
  if (!r || r.status !== "aguardando") return deps.avisar("Não há rascunho aguardando com esse número.");
  if (/\[preencher:/i.test(r.texto)) {
    return deps.avisar(`O rascunho #${r.id} ainda tem [preencher: …]. Ajuste antes de enviar.`);
  }
  await executarEnvio(deps, r);
}

/**
 * Envia um rascunho que já pode sair (pelo ok do dono, ou pela autonomia que ele deu).
 * É o único lugar do código que manda mensagem a um contato.
 */
export async function executarEnvio(
  deps: Pick<DepsControle, "db" | "evolution" | "avisar">,
  r: repo.Rascunho,
  sufixo = "",
): Promise<boolean> {
  // Marca antes de enviar: um segundo "ok" que chegue no meio não manda de novo.
  if (!(await repo.decidirRascunho(deps.db, r.id, "enviado"))) return false;
  try {
    // Volta pelo webhook como mensagem "de mim" na conversa do contato, e é gravada
    // ali como qualquer outra: entra no contexto e nos exemplos de estilo.
    const mensagemId = await deps.evolution.enviarTexto(r.chat_jid, r.texto);
    // O id separa esta mensagem das que ele escreveu à mão: só as dele ensinam estilo.
    if (mensagemId) await deps.db.query("UPDATE rascunhos SET mensagem_id = $2 WHERE id = $1", [r.id, mensagemId]);
  } catch (err) {
    await deps.db.query("UPDATE rascunhos SET status = 'aguardando', decidido_em = NULL, enviar_em = NULL WHERE id = $1", [r.id]);
    await deps.avisar(`Não consegui enviar o #${r.id}: ${String(err).slice(0, 200)}`);
    return false;
  }
  const contato = await repo.lerContato(deps.db, r.chat_jid);
  await deps.avisar(`Enviado para ${contato ? repo.nomeDe(contato) : r.chat_jid} ✅${sufixo}`);
  return true;
}

/** Compromisso confirmado, com data e do dono, vira evento na agenda (1 hora). */
async function levarParaAgenda(deps: DepsControle, id: number): Promise<string> {
  if (!deps.google || !deps.sincronizarAgenda) return "";
  const r = await deps.db.query<{ descricao: string; quando: Date | null; responsavel: string; evento_id: string | null; contato: string }>(
    `SELECT k.descricao, k.quando, k.responsavel, k.evento_id, COALESCE(c.nome, c.nome_push, split_part(c.jid, '@', 1)) AS contato
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

async function cobrar(deps: DepsControle, nome: string): Promise<void> {
  const c = await acharUm(deps, nome);
  if (!c) return;
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
    `SELECT COALESCE(nome, nome_push, split_part(jid, '@', 1)) AS nome, autonomia FROM contatos
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
- Você nunca envia mensagem a ninguém. Para responder um contato, use propor_resposta: ele recebe o rascunho e decide.
- Se ele disser como prefere as coisas ("nunca marco antes das 9", "com cliente sempre formal"), guarde com registrar_regra.
- Se não achar a informação, diga que não achou. Não invente.${extras.map((e) => `\n- ${e}`).join("")}${perfil ? `\n\nPERFIL DE ${dono.toUpperCase()}:\n${perfil}` : ""}`;
}

/** Pedido em linguagem livre: vai para o Claude com as ferramentas de consulta. */
async function atenderPedido(deps: DepsControle, texto: string): Promise<void> {
  const perfil = repo.perfilEmTexto(await repo.lerPerfil(deps.db));
  const extras: string[] = [];
  const ferramentas: any[] = criarFerramentas(deps);
  if (deps.google) {
    ferramentas.push(...ferramentasGoogle({ google: deps.google, fuso: deps.fuso, expediente: deps.expediente ?? { inicioH: 9, fimH: 18 } }));
    extras.push(
      "Você vê a agenda e o Gmail dele. Para marcar algo, veja horários livres antes e crie o evento só quando ele pedir. E-mail você só deixa em rascunho no Gmail.",
    );
  }
  if (deps.koreos) {
    extras.push(
      "Você tem o KoreOS dele (gestão do escritório: projetos, tarefas, clientes, financeiro, pranchas). Consulte à vontade; antes de criar, alterar ou excluir algo lá, confirme com ele.",
    );
  }
  const resposta = await deps.ia.agente({
    sistema: sistemaAgente(deps.dono, perfil, extras),
    conteudo: `Agora: ${agoraPorExtenso(new Date(), deps.fuso)}\n\n${texto}`,
    ferramentas,
    mcp: deps.koreos ? { nome: "koreos", ...deps.koreos } : undefined,
  });
  if (resposta) await deps.avisar(resposta);
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
        const contato = await repo.lerContato(db, jid);
        if (!contato || contato.excluido) return "Conversa não encontrada.";
        const msgs = await repo.ultimasMensagens(db, jid, quantidade);
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
        const d = quando ? new Date(quando) : null;
        const id = await repo.criarCompromisso(db, {
          chatJid: jid,
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
        await repo.lembrar(db, jid, [fato]);
        return "Guardado.";
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
        const id = await proporResposta(deps, jid, instrucao);
        return `Rascunho #${id} enviado para aprovação.`;
      },
    }),
  ];
}
