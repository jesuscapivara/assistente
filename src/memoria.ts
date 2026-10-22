import { z } from "zod";
import { gravarEstado, lerEstado, type Db } from "./db.js";
import { agoraPorExtenso, dataCurta } from "./formato.js";
import type { Ia } from "./ia.js";
import * as repo from "./repo.js";

/**
 * A memória de trabalho do chat de controle, em duas camadas:
 *
 * - o **diálogo**: as últimas falas dos dois lados, literais. É o que faz um "sim", um
 *   "esse aí" ou um "responde o segundo" terem a que se referir;
 * - o **caderno**: uma nota curta e viva do que está em andamento entre o dono e o
 *   assistente (pedidos abertos, propostas esperando resposta, decisões do dia, quem é
 *   quem nas listas recentes). Sobrevive ao diálogo, que é cortado, e é reescrita pelo
 *   modelo leve depois de cada pedido livre, a custo de centavos por mês.
 *
 * O perfil (regras, lições, retrato) continua sendo o que vale para sempre; o caderno
 * é o que vale para esta semana.
 */

const CHAVE = "caderno";
const TETO = 1800;
const FALAS = 14;

export async function lerCaderno(db: Db): Promise<string> {
  return (await lerEstado(db, CHAVE)) ?? "";
}

function falaEmTexto(f: repo.Fala, dono: string, fuso: string, limite = 700): string {
  const quem = f.autor === "dono" ? dono : "Assistente";
  const corpo = f.texto.length > limite ? `${f.texto.slice(0, limite)}…` : f.texto;
  return `[${dataCurta(new Date(f.criado_em), fuso)}] ${quem}: ${corpo}${f.refs ? `\n  (citados: ${f.refs.replace(/\n/g, "; ")})` : ""}`;
}

/**
 * O contexto que vai antes de todo pedido livre. `pedido` sai do fim do diálogo: ele
 * já foi gravado ao chegar e vai separado, como o pedido de agora.
 */
export async function contextoDoChat(db: Db, dono: string, fuso: string, pedido: string): Promise<string> {
  const caderno = await lerCaderno(db);
  const falas = await repo.dialogoRecente(db, FALAS + 1, 48);
  const ultima = falas.at(-1);
  if (ultima?.autor === "dono" && ultima.texto.trim() === pedido.trim()) falas.pop();
  return [
    caderno ? `CADERNO (o que está em andamento entre você e ${dono}):\n${caderno}` : "",
    falas.length ? `CONVERSA RECENTE NESTE CHAT (mais nova por último):\n${falas.map((f) => falaEmTexto(f, dono, fuso)).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const CadernoSchema = z.object({
  caderno: z.string().describe(`A nota inteira, reescrita, em tópicos curtos; até ${TETO} caracteres`),
});

/** Reescreve o caderno com o que a última troca mudou. Falha aqui não incomoda o dono. */
export async function atualizarCaderno(deps: { db: Db; ia: Ia; dono: string; fuso: string }): Promise<void> {
  const atual = await lerCaderno(deps.db);
  const falas = await repo.dialogoRecente(deps.db, 8, 48);
  if (!falas.length) return;
  const r = await deps.ia
    .estruturar(CadernoSchema, {
      sistema: `Você mantém o caderno de trabalho de um assistente pessoal: uma nota curta do que está em andamento entre o assistente e ${deps.dono}.
Guarde só o que ajuda a entender a próxima mensagem dele:
- pedidos dele ainda abertos e o que falta;
- o que o assistente propôs ou perguntou e espera resposta ("propus refazer o resumo com nomes; ele não respondeu");
- decisões e preferências passageiras desta semana (as permanentes ele grava como regra, não aqui);
- quem é quem nas listas recentes, com o jid quando aparecer ("Ana Ribeiro = 5511…@s.whatsapp.net").
Tire o que já se resolveu e o que tem mais de 3 dias sem menção. Nada de conteúdo de conversas com terceiros além do necessário para se localizar. Escreva em português, em tópicos, sem enfeite.`,
      conteudo: `Agora: ${agoraPorExtenso(new Date(), deps.fuso)}\n\nCADERNO ATUAL:\n${atual || "(vazio)"}\n\nÚLTIMAS FALAS:\n${falas.map((f) => falaEmTexto(f, deps.dono, deps.fuso, 1200)).join("\n")}`,
      esforco: "low",
      peso: "leve",
      funcao: "caderno",
    })
    .catch(() => null);
  if (!r) return;
  await gravarEstado(deps.db, CHAVE, r.caderno.trim().slice(0, TETO));
}

export async function limparCaderno(db: Db): Promise<void> {
  await gravarEstado(db, CHAVE, "");
}
