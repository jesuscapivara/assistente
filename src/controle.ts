import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { Db } from "./db.js";
import { estudar } from "./conhecer.js";
import { agoraPorExtenso, dataCurta, linhas } from "./formato.js";
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
}

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
  | { tipo: "ajuda" }
  | { tipo: "pedido"; texto: string };

export function lerComando(texto: string): Comando {
  const t = texto.trim();
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(ok|envia|enviar|manda|pode mandar)(?:\s+#?(\d+))?[.!]?$/i)))
    return { tipo: "enviar", id: m[2] ? Number(m[2]) : undefined };
  if ((m = t.match(/^(descarta|descartar|cancela|não manda|nao manda)(?:\s+#?(\d+))?[.!]?$/i)))
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
      const contato = await repo.lerContato(deps.db, r.chat_jid);
      return deps.avisar(previa(r.id, contato ? repo.nomeDe(contato) : r.chat_jid, novo));
    }
    case "compromisso": {
      const ok = await repo.mudarCompromisso(deps.db, c.id, c.acao);
      return deps.avisar(ok ? `Compromisso #${c.id}: ${c.acao}.` : `Não achei o compromisso #${c.id}.`);
    }
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
  // Marca antes de enviar: um segundo "ok" que chegue no meio não manda de novo.
  if (!(await repo.decidirRascunho(deps.db, r.id, "enviado"))) return;
  try {
    // Volta pelo webhook como mensagem "de mim" na conversa do contato, e é gravada
    // ali como qualquer outra: entra no contexto e nos exemplos de estilo.
    const mensagemId = await deps.evolution.enviarTexto(r.chat_jid, r.texto);
    // O id separa esta mensagem das que ele escreveu à mão: só as dele ensinam estilo.
    if (mensagemId) await deps.db.query("UPDATE rascunhos SET mensagem_id = $2 WHERE id = $1", [r.id, mensagemId]);
  } catch (err) {
    await deps.db.query("UPDATE rascunhos SET status = 'aguardando', decidido_em = NULL WHERE id = $1", [r.id]);
    return deps.avisar(`Não consegui enviar o #${r.id}: ${String(err).slice(0, 200)}`);
  }
  const contato = await repo.lerContato(deps.db, r.chat_jid);
  await deps.avisar(`Enviado para ${contato ? repo.nomeDe(contato) : r.chat_jid} ✅`);
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

function sistemaAgente(dono: string, perfil: string): string {
  return `Você é o assistente pessoal de ${dono}. Você conversa com ele no chat dele consigo mesmo no WhatsApp e tem acesso às conversas dele pelas ferramentas.
- Responda curto, em português, no estilo de WhatsApp (*negrito* para destacar). Sem preâmbulo.
- Para falar de alguém, ache o contato com buscar_contato e leia a conversa antes de responder. Diga de onde tirou a informação (data da mensagem).
- Você nunca envia mensagem a ninguém. Para responder um contato, use propor_resposta: ele recebe o rascunho e decide.
- Se ele disser como prefere as coisas ("nunca marco antes das 9", "com cliente sempre formal"), guarde com registrar_regra.
- Se não achar a informação, diga que não achou. Não invente.${perfil ? `\n\nPERFIL DE ${dono.toUpperCase()}:\n${perfil}` : ""}`;
}

/** Pedido em linguagem livre: vai para o Claude com as ferramentas de consulta. */
async function atenderPedido(deps: DepsControle, texto: string): Promise<void> {
  const perfil = repo.perfilEmTexto(await repo.lerPerfil(deps.db));
  const resposta = await deps.ia.agente({
    sistema: sistemaAgente(deps.dono, perfil),
    conteudo: `Agora: ${agoraPorExtenso(new Date(), deps.fuso)}\n\n${texto}`,
    ferramentas: criarFerramentas(deps),
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
