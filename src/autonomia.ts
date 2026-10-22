import { z } from "zod";
import { lerEstado, type Db } from "./db.js";
import { executarEnvio } from "./controle.js";
import { relogio } from "./formato.js";
import type { Ia } from "./ia.js";
import { escreverRascunho, previa } from "./rascunho.js";
import * as repo from "./repo.js";
import type { Evolution } from "./whatsapp/evolution.js";

/**
 * Autonomia por contato. Nível 0 é o padrão: o assistente só age quando o dono pede.
 *   1 — propõe a resposta sozinho e espera o ok;
 *   2 — envia sozinho se o dono não vetar em JANELA_VETO_MIN;
 *   3 — envia direto o que é simples e avisa depois.
 * Em qualquer nível, risco alto (dinheiro, prazo, contrato, assunto delicado) e
 * rascunho com [preencher] esperam o ok. Grupo nunca passa de 0.
 */
export interface DepsAutonomia {
  db: Db;
  ia: Ia;
  evolution: Evolution;
  dono: string;
  fuso: string;
  avisar(texto: string): Promise<void>;
  padrao: number;
  janelaMin: number;
  agora?: () => Date;
}

/**
 * Primeira barreira, sem modelo: palavra de dinheiro, prazo, contrato ou de assunto
 * delicado e o rascunho não sai sozinho, diga o classificador o que disser.
 */
const SEMPRE_HUMANO =
  /R\$|\breais\b|\bvalor|pre[çc]o|\bpix\b|pagamento|boleto|transfer[eê]ncia|desconto|or[çc]amento|contrato|assinatura|\bprazo|\bentreg|multa|advogad|processo|desculp|sinto muito|faleceu|falecimento|hospital|doen[çc]a|\bpromet/i;

export function riscoPorPalavra(texto: string): string | null {
  const m = texto.match(SEMPRE_HUMANO);
  return m ? `fala de "${m[0]}"` : null;
}

const RiscoSchema = z.object({
  risco: z.enum(["baixo", "alto"]),
  motivo: z.string().describe("Curto: por que é alto, ou 'resposta simples'"),
});

/** Horas em que mensagem automática pode sair: ninguém recebe "resposta do dono" às 3h. */
function horaDecente(d: Date, fuso: string): boolean {
  const h = Number(relogio(d, fuso).hora.slice(0, 2));
  return h >= 8 && h < 21;
}

export async function pausada(db: Db): Promise<boolean> {
  return (await lerEstado(db, "autonomia:pausada")) === "1";
}

async function classificar(deps: DepsAutonomia, conversa: string, texto: string): Promise<{ risco: "baixo" | "alto"; motivo: string }> {
  const palavra = riscoPorPalavra(texto);
  if (palavra) return { risco: "alto", motivo: palavra };
  const r = await deps.ia
    .estruturar(RiscoSchema, {
      sistema: `Você decide se uma resposta de WhatsApp pode sair sem o dono (${deps.dono}) revisar.
Baixo risco: confirmar recebimento, horário já combinado, agradecer, cumprimento, "vejo e te falo", resposta factual sem compromisso novo, e reagir a foto ou novidade que a pessoa compartilhou ("ficou top!", "parabéns!") sem prometer nada.
Alto risco: qualquer compromisso novo, dinheiro, prazo, opinião técnica, negociação, reclamação, assunto pessoal ou delicado, ou se o rascunho pode estar errado sobre algo. Na dúvida, alto.`,
      conteudo: `CONVERSA:\n${conversa}\n\nRESPOSTA PROPOSTA:\n${texto}`,
      esforco: "low",
      // Decide se algo sai sem o dono olhar: fica no modelo principal, não no leve.
      funcao: "risco",
    })
    .catch(() => null);
  return r ?? { risco: "alto", motivo: "não consegui avaliar" };
}

/**
 * Alguém espera resposta do dono. Conforme o nível do contato: nada, rascunho para
 * aprovar, envio com janela de veto ou envio direto.
 */
export async function responderSozinho(deps: DepsAutonomia, jid: string): Promise<"nada" | "proposto" | "agendado" | "enviado"> {
  const nivel = await repo.nivelDeAutonomia(deps.db, jid, deps.padrao);
  if (nivel < 1 || (await repo.rascunhoAberto(deps.db, jid))) return "nada";

  const texto = await escreverRascunho(
    deps,
    jid,
    "Responda o que o contato mandou desde a última mensagem do dono (o bloco todo, não só a última linha), do jeito que o dono responderia. Se precisar de algo que só ele sabe (decisão, valor, data, opinião), deixe [preencher: …]. " +
      "Se for foto ou novidade compartilhada, reaja ao que ela mostra de fato (cite o detalhe: o boné, a loja, a aprovação), curto e com a energia do dono; nunca um elogio genérico que serviria para qualquer foto, e não repita a frase de reações anteriores. " +
      "Se não dá para saber o que é (vídeo, arquivo ou foto sem descrição), deixe [preencher: o que achou].",
  );
  const id = await repo.criarRascunho(deps.db, jid, texto, "resposta proposta pelo assistente");
  const contato = await repo.lerContato(deps.db, jid);
  const nome = contato ? repo.nomeDe(contato) : jid;
  const conversa = (await repo.ultimasMensagens(deps.db, jid, 12)).map((m) => `${m.de_mim ? deps.dono : nome}: ${m.texto}`).join("\n");

  const agora = deps.agora?.() ?? new Date();
  const pausado = await pausada(deps.db);
  const preencher = /\[preencher:/i.test(texto);
  const { risco, motivo } = nivel >= 2 && !preencher && !pausado ? await classificar(deps, conversa, texto) : { risco: "alto" as const, motivo: "" };
  await deps.db.query("UPDATE rascunhos SET automatico = TRUE, risco = $2, motivo_risco = $3 WHERE id = $1", [id, risco, motivo]);

  // Nível, pausa e exclusão foram lidos antes de duas chamadas ao modelo: o envio e o
  // agendamento conferem tudo de novo no banco, na hora (reservarEnvio, agendarEnvio).
  const podeSozinho = nivel >= 2 && risco === "baixo" && !preencher && !pausado && horaDecente(agora, deps.fuso);
  if (podeSozinho && nivel === 3) {
    const r = await repo.lerRascunho(deps.db, id);
    const auto = { padrao: deps.padrao, nivelMinimo: 3 as const, agendado: false, agora };
    if (r && (await executarEnvio(deps, r, `\n> ${texto}\n_(nível 3: risco baixo, enviei direto)_`, auto))) return "enviado";
  }
  const quando = new Date(agora.getTime() + deps.janelaMin * 60_000);
  if (podeSozinho && nivel === 2 && (await repo.agendarEnvio(deps.db, id, quando))) {
    await deps.avisar(
      `Respondo *${nome}* em ${deps.janelaMin} min se você não vetar:\n\n${texto}\n\n_veta ${id} · ok ${id} (manda já) · ajusta ${id} <o quê>_`,
    );
    return "agendado";
  }
  const porque = nivel >= 2 ? (preencher ? " (falta informação)" : risco === "alto" && motivo ? ` (precisa de você: ${motivo})` : "") : "";
  await deps.avisar(`💬 ${nome} espera resposta${porque}.\n\n${previa(id, nome, texto)}`);
  return "proposto";
}

/** A cada minuto: o que passou da janela de veto sem veto sai agora. */
export async function enviarAgendados(deps: DepsAutonomia): Promise<number> {
  if (await pausada(deps.db)) return 0;
  const agora = deps.agora?.() ?? new Date();
  let enviados = 0;
  for (const r of await repo.rascunhosParaEnviar(deps.db, agora)) {
    // O nível pode ter baixado durante a janela: confere de novo.
    if ((await repo.nivelDeAutonomia(deps.db, r.chat_jid, deps.padrao)) < 2 || !horaDecente(agora, deps.fuso)) {
      await deps.db.query("UPDATE rascunhos SET enviar_em = NULL WHERE id = $1", [r.id]);
      continue;
    }
    const auto = { padrao: deps.padrao, nivelMinimo: 2 as const, agendado: true, agora };
    if (await executarEnvio(deps, r, " _(ninguém vetou)_", auto)) {
      enviados++;
      continue;
    }
    // Não saiu porque algo mudou (o dono respondeu à mão, ajustou, pausou): volta a
    // esperar o ok, em vez de ser tentado de novo a cada minuto.
    await deps.db.query("UPDATE rascunhos SET enviar_em = NULL WHERE id = $1 AND status = 'aguardando'", [r.id]);
  }
  return enviados;
}
