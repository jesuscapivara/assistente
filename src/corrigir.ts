import { z } from "zod";
import type { Db } from "./db.js";
import { linhas } from "./formato.js";
import type { Ia } from "./ia.js";
import * as repo from "./repo.js";

/**
 * O dono diz que o assistente leu errado ("errado 1 quem vai ler é o Toshio", ou "a
 * Thaís é notificação do KoreOS"). Duas coisas acontecem:
 *  1. o item é corrigido (compromisso, situação da conversa, se espera resposta, se é robô);
 *  2. sai uma lição geral, que vai em toda leitura dali em diante.
 * Sem a segunda, o mesmo engano volta na próxima conversa parecida.
 */

const CorrecaoSchema = z.object({
  compromisso: z
    .object({
      acao: z.enum(["manter", "corrigir", "descartar"]).describe("'descartar' se não era compromisso de ninguém"),
      descricao: z.string().describe("A descrição certa, com quem faz como sujeito"),
      quem_faz: z.enum(["dono", "contato", "ambos"]),
    })
    .nullable()
    .describe("Só se a correção é sobre um compromisso; senão null"),
  conversa: z
    .object({
      situacao: z.string().describe("Onde a conversa está, corrigido; repita a atual se não mudou"),
      espera_resposta: z.boolean(),
      sistema: z.boolean().describe("O outro lado é robô/notificação automática"),
    })
    .nullable()
    .describe("Só se a correção é sobre a conversa (situação, se espera resposta, se é robô); senão null"),
  licao: z
    .string()
    .describe(
      "Uma regra geral de leitura que evita o mesmo erro em outras conversas, curta e sem nomes próprios ('Quem escreve vou ler é quem lê, mesmo que o arquivo tenha vindo do dono'). Vazio se o erro foi só deste caso",
    ),
});

export interface DepsCorrecao {
  db: Db;
  ia: Ia;
  dono: string;
  fuso: string;
}

export type Alvo = { compromisso: number } | { jid: string };

export async function corrigirLeitura(deps: DepsCorrecao, alvo: Alvo, correcao: string): Promise<string> {
  const { db } = deps;
  let compromisso: (repo.Compromisso & { mensagem_id: string | null }) | null = null;
  let jid: string;
  if ("compromisso" in alvo) {
    const r = await db.query<repo.Compromisso & { mensagem_id: string | null }>(
      `SELECT k.id, k.chat_jid, k.descricao, k.quando, k.responsavel, k.status, k.mensagem_id, ${repo.NOME_SQL} AS contato_nome
       FROM compromissos k JOIN contatos c ON c.jid = k.chat_jid WHERE k.id = $1 AND NOT c.excluido`,
      [alvo.compromisso],
    );
    compromisso = r.rows[0] ?? null;
    if (!compromisso) return `Não achei o compromisso #${alvo.compromisso}.`;
    jid = compromisso.chat_jid;
  } else {
    jid = await repo.resolverJid(db, alvo.jid);
  }
  const contato = await repo.lerContato(db, jid);
  if (!contato || contato.excluido) return "Não achei essa conversa.";
  const nome = repo.nomeDe(contato);

  // A conversa como estava quando o compromisso foi lido: o engano está ali.
  const ate = compromisso?.mensagem_id
    ? (await db.query<{ enviada_em: Date }>("SELECT enviada_em FROM mensagens WHERE id = $1", [compromisso.mensagem_id])).rows[0]?.enviada_em
    : undefined;
  const msgs = (
    await db.query<repo.Mensagem>(
      `SELECT id, chat_jid, remetente_nome, de_mim, tipo, texto, enviada_em FROM mensagens
       WHERE chat_jid = $1 AND ($2::timestamptz IS NULL OR enviada_em <= $2 + interval '10 minutes')
       ORDER BY enviada_em DESC LIMIT 30`,
      [jid, ate ?? null],
    )
  ).rows.reverse();

  const r = await deps.ia.estruturar(CorrecaoSchema, {
    sistema: `O assistente pessoal de ${deps.dono} leu uma conversa do WhatsApp e entendeu algo errado. ${deps.dono} corrigiu.
Aplique a correção dele ao item e tire uma lição geral de leitura, se houver. A palavra dele vale mais que a sua leitura da conversa.`,
    conteudo: [
      `${contato.grupo ? "Grupo" : "Contato"}: ${nome}`,
      compromisso
        ? `COMPROMISSO LIDO: "${compromisso.descricao}" — quem faz: ${compromisso.responsavel === "eu" ? deps.dono : compromisso.responsavel === "contato" ? nome : "os dois"}`
        : `LEITURA DA CONVERSA: situação "${contato.situacao}"; espera resposta: ${contato.espera_resposta ? "sim" : "não"}; robô: ${contato.sistema ? "sim" : "não"}`,
      `CORREÇÃO DE ${deps.dono.toUpperCase()}: ${correcao}`,
      msgs.length ? `CONVERSA:\n${linhas(msgs, deps.dono, nome, deps.fuso)}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    esforco: "low",
    peso: "leve",
    funcao: "correcao",
  });
  if (!r) return "Não consegui aplicar a correção. Tente dizer de outro jeito.";

  const feito: string[] = [];
  if (compromisso && r.compromisso) {
    if (r.compromisso.acao === "descartar") {
      await repo.mudarCompromisso(db, compromisso.id, "descartado");
      feito.push(`tirei o #${compromisso.id}`);
    } else if (r.compromisso.acao === "corrigir") {
      const responsavel = r.compromisso.quem_faz === "dono" ? "eu" : r.compromisso.quem_faz;
      await db.query("UPDATE compromissos SET descricao = $2, responsavel = $3 WHERE id = $1", [compromisso.id, r.compromisso.descricao, responsavel]);
      const quem = responsavel === "eu" ? "seu" : responsavel === "contato" ? `de ${nome}` : "dos dois";
      feito.push(`o #${compromisso.id} agora é ${quem}: ${r.compromisso.descricao}`);
    }
  }
  if (r.conversa && !contato.grupo) {
    await db.query("UPDATE contatos SET situacao = $2, espera_resposta = $3, sistema = $4, atualizado_em = now() WHERE jid = $1", [
      jid,
      r.conversa.situacao.trim(),
      r.conversa.espera_resposta && !r.conversa.sistema,
      r.conversa.sistema,
    ]);
    feito.push(
      r.conversa.sistema
        ? `${nome} agora conta como notificação automática`
        : `${nome}: ${r.conversa.espera_resposta ? "espera resposta" : "não espera resposta"}${r.conversa.situacao ? ` (${r.conversa.situacao})` : ""}`,
    );
  }
  const licao = r.licao.trim();
  const idLicao = licao ? await repo.acrescentarPerfil(db, "leitura", licao) : null;
  return [
    feito.length ? `Corrigido: ${feito.join("; ")}.` : "Não mudei nada no item.",
    idLicao ? `Aprendi (#${idLicao}): ${licao}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
