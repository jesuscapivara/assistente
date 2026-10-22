import { z } from "zod";
import type { Db } from "./db.js";
import { linhas, relogio } from "./formato.js";
import type { Ia } from "./ia.js";
import * as repo from "./repo.js";

export interface DepsConhecer {
  db: Db;
  ia: Ia;
  dono: string;
  fuso: string;
  log?: (o: object, txt: string) => void;
}

const FichaSchema = z.object({
  relacao: z.enum(["cliente", "familia", "amigo", "trabalho", "fornecedor", "outro"]),
  resumo: z.string().describe("Quem é a pessoa para o dono, em uma ou duas frases"),
  tom: z
    .string()
    .describe("Como o dono escreve para ela: formal ou não, apelidos, emojis, tamanho das mensagens, como cumprimenta"),
  assuntos_abertos: z.string().describe("O que está pendente entre os dois agora, curto; vazio se nada"),
  fatos: z.array(z.string()).describe("Fatos duradouros novos (família, trabalho, preferências)"),
  datas: z
    .array(z.object({ descricao: z.string(), dia: z.number().int(), mes: z.number().int() }))
    .describe("Datas que se repetem todo ano e aparecem na conversa: aniversário, casamento. Só com dia e mês certos"),
});

/**
 * Lê a conversa com a pessoa e escreve a ficha dela. Grupo também tem ficha (do que se
 * trata, qual o papel do dono ali), mas fatos de grupo não viram memória de pessoa.
 */
export async function conhecerContato(deps: DepsConhecer, jid: string): Promise<boolean> {
  const contato = await repo.lerContato(deps.db, jid);
  if (!contato || contato.excluido) return false;
  const msgs = await repo.ultimasMensagens(deps.db, jid, 150);
  if (!msgs.length) return false;
  const nome = repo.nomeDe(contato);

  const ficha = await deps.ia.estruturar(FichaSchema, {
    sistema: `Você monta a ficha de uma pessoa (ou grupo) a partir da conversa dela com ${deps.dono} no WhatsApp.
É para ${deps.dono} lembrar quem é quem e para escrever no tom certo com cada um. Seja factual: nada que a conversa não mostre.
Para grupo: resumo = do que se trata e qual o papel de ${deps.dono} nele; tom = como ${deps.dono} escreve ali.`,
    conteudo: [
      `${contato.grupo ? "Grupo" : "Contato"}: ${nome}`,
      repo.fichaEmTexto(contato) ? `Ficha atual:\n${repo.fichaEmTexto(contato)}` : "",
      `CONVERSA:\n${linhas(msgs, deps.dono, nome, deps.fuso)}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    esforco: "low",
  });
  if (!ficha) return false;
  await repo.atualizarFicha(deps.db, jid, ficha);
  if (!contato.grupo) {
    await repo.lembrar(deps.db, jid, ficha.fatos);
    await repo.gravarDatas(deps.db, jid, ficha.datas ?? []);
  }
  return true;
}

/** Em que horas o dono costuma escrever: dado, não opinião do modelo. */
async function horasDeAtividade(deps: DepsConhecer): Promise<string> {
  const r = await deps.db.query<{ enviada_em: Date }>(
    "SELECT enviada_em FROM mensagens WHERE de_mim ORDER BY enviada_em DESC LIMIT 2000",
  );
  if (r.rows.length < 30) return "";
  const porHora = new Array(24).fill(0);
  for (const { enviada_em } of r.rows) porHora[Number(relogio(new Date(enviada_em), deps.fuso).hora.slice(0, 2))]++;
  const total = r.rows.length;
  const ativas = porHora.map((n, h) => ({ h, p: n / total })).filter((x) => x.p >= 0.04);
  return ativas.map((x) => `${String(x.h).padStart(2, "0")}h (${Math.round(x.p * 100)}%)`).join(", ");
}

/**
 * O retrato do dono: como ele escreve com cada tipo de pessoa, o que costuma
 * prometer, como marca as coisas. Sai das mensagens dele, de várias conversas.
 */
export async function estudarDono(deps: DepsConhecer): Promise<boolean> {
  const r = await deps.db.query<{ texto: string; relacao: string | null; contato: string; grupo: boolean }>(
    `SELECT m.texto, c.relacao, COALESCE(c.nome, c.nome_push, split_part(c.jid, '@', 1)) AS contato, c.grupo
     FROM mensagens m JOIN contatos c ON c.jid = m.chat_jid
     WHERE m.de_mim AND m.tipo = 'texto' AND length(m.texto) > 2 AND NOT c.excluido AND ${repo.NAO_FOI_RASCUNHO}
     ORDER BY m.enviada_em DESC LIMIT 600`,
  );
  if (r.rows.length < 30) return false;
  // Até 25 mensagens por conversa: o retrato precisa de variedade, não do contato mais falante.
  const porContato = new Map<string, string[]>();
  for (const x of r.rows) {
    const chave = `${x.contato}${x.grupo ? " (grupo)" : ""} — ${x.relacao ?? "relação desconhecida"}`;
    const lista = porContato.get(chave) ?? [];
    if (lista.length < 25) lista.push(x.texto);
    porContato.set(chave, lista);
  }
  const amostra = [...porContato.entries()]
    .map(([k, v]) => `### ${k}\n${v.map((t) => `> ${t}`).join("\n")}`)
    .join("\n\n");
  const horas = await horasDeAtividade(deps);
  const atual = await repo.lerPerfil(deps.db);

  const texto = await deps.ia.escrever({
    sistema: `Você escreve o retrato de ${deps.dono} para um assistente que vai escrever mensagens em nome dele.
Escreva em tópicos curtos, só o que as mensagens mostram:
- Jeito de escrever em geral (tamanho, pontuação, emojis, gírias, cumprimentos, despedidas).
- Diferenças por tipo de relação (clientes, família, amigos, trabalho).
- Expressões e palavras que ele usa muito, e as que ele não usa.
- Como ele marca compromissos, confirma, recusa e cobra.
- O que ele evita prometer ou como lida com prazo e valor, se aparecer.
Nada de elogio nem de psicologia: é um manual prático de imitação.`,
    conteudo: [
      horas ? `Horas em que ele mais escreve: ${horas}` : "",
      atual.regras.length ? `Regras que ele já deu (respeite):\n${atual.regras.map((x) => `- ${x.texto}`).join("\n")}` : "",
      `MENSAGENS DELE, por conversa:\n${amostra}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    esforco: "medium",
  });
  if (!texto) return false;
  await repo.trocarPerfilGerado(deps.db, texto);
  return true;
}

const LicoesSchema = z.object({
  licoes: z
    .array(z.string())
    .describe("Regras de estilo gerais, curtas e acionáveis; vazio se a diferença for só de conteúdo"),
});

/** Quanto tempo depois do rascunho uma mensagem à mão ainda conta como "a versão dele". */
const JANELA_MIN = 90;

/**
 * Aprende com o que o dono fez com cada rascunho:
 * - descartou (ou deixou de lado) e escreveu a própria resposta: compara as duas;
 * - mandou depois de "ajusta": as instruções de ajuste dizem o que estava errado.
 */
export async function aprenderComCorrecoes(deps: DepsConhecer): Promise<number> {
  const r = await deps.db.query<{ id: number; chat_jid: string; texto: string; pedido: string; status: string; criado_em: Date; mensagem_id: string | null }>(
    `SELECT id, chat_jid, texto, pedido, status, criado_em, mensagem_id FROM rascunhos
     WHERE NOT aprendido AND criado_em < now() - make_interval(mins => $1)
     ORDER BY id LIMIT 20`,
    [JANELA_MIN],
  );
  let aprendidas = 0;
  for (const rasc of r.rows) {
    const proprias = (
      await deps.db.query<{ texto: string }>(
        `SELECT texto FROM mensagens
         WHERE chat_jid = $1 AND de_mim AND tipo = 'texto' AND enviada_em > $2
           AND enviada_em < $2 + make_interval(mins => $3) AND id IS DISTINCT FROM $4
         ORDER BY enviada_em`,
        [rasc.chat_jid, rasc.criado_em, JANELA_MIN, rasc.mensagem_id],
      )
    ).rows.map((x) => x.texto);
    const ajustes = rasc.pedido.split("\n").filter((l) => l.startsWith("Ajuste:")).map((l) => l.slice(7).trim());
    const escreveuAMao = rasc.status !== "enviado" && proprias.length > 0;

    if (escreveuAMao || ajustes.length) {
      const resp = await deps.ia.estruturar(LicoesSchema, {
        sistema: `Um assistente escreveu um rascunho em nome de ${deps.dono}. Compare com o que ${deps.dono} fez e tire regras de estilo que valham para as próximas mensagens.
Só diferenças de JEITO de escrever (tom, tamanho, palavras, emoji, formalidade, estrutura). Diferença só de assunto ou de fato não é lição.`,
        conteudo: [
          `RASCUNHO:\n${rasc.texto}`,
          escreveuAMao ? `O QUE ELE MANDOU NO LUGAR:\n${proprias.join("\n")}` : "",
          ajustes.length ? `AJUSTES QUE ELE PEDIU:\n${ajustes.map((a) => `- ${a}`).join("\n")}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        esforco: "low",
      });
      for (const l of resp?.licoes ?? []) if (await repo.acrescentarPerfil(deps.db, "licao", l)) aprendidas++;
    }
    await deps.db.query("UPDATE rascunhos SET aprendido = TRUE WHERE id = $1", [rasc.id]);
  }
  return aprendidas;
}

/**
 * A rodada de estudo (madrugada, e depois do histórico do pareamento): lições, fichas
 * das pessoas com conversa nova e, uma vez por semana, o retrato do dono.
 */
export async function estudar(deps: DepsConhecer, opts: { fichas?: number; forcarPerfil?: boolean } = {}): Promise<string> {
  const licoes = await aprenderComCorrecoes(deps).catch((err) => (deps.log?.({ err: String(err) }, "lições falharam"), 0));
  let fichas = 0;
  for (const jid of await repo.contatosParaConhecer(deps.db, opts.fichas ?? 25)) {
    try {
      if (await conhecerContato(deps, jid)) fichas++;
    } catch (err) {
      deps.log?.({ err: String(err), jid }, "ficha falhou");
    }
  }
  const ultimo = await deps.db.query<{ criado_em: Date }>(
    "SELECT criado_em FROM perfil WHERE tipo = 'gerado' AND ativo ORDER BY id DESC LIMIT 1",
  );
  const velho = !ultimo.rows[0] || Date.now() - new Date(ultimo.rows[0].criado_em).getTime() > 7 * 86400_000;
  const perfil = (opts.forcarPerfil || velho) && (await estudarDono(deps).catch(() => false));
  return `${fichas} fichas, ${licoes} lições${perfil ? ", retrato atualizado" : ""}`;
}
