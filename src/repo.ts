import type { Db } from "./db.js";
import type { MensagemRecebida } from "./whatsapp/evento.js";

export interface Contato {
  jid: string;
  nome: string | null;
  nome_push: string | null;
  grupo: boolean;
  excluido: boolean;
  memoria: string;
  relacao: string | null;
  resumo: string;
  tom: string;
  assuntos_abertos: string;
  aguardando: string;
  autonomia: number | null;
}

const COLUNAS_CONTATO =
  "jid, nome, nome_push, grupo, excluido, memoria, relacao, resumo, tom, assuntos_abertos, aguardando, autonomia";

export interface Mensagem {
  id: string;
  chat_jid: string;
  remetente_nome: string | null;
  de_mim: boolean;
  tipo: string;
  texto: string;
  enviada_em: Date;
}

export interface Compromisso {
  id: number;
  chat_jid: string;
  descricao: string;
  quando: Date | null;
  responsavel: "eu" | "contato" | "ambos";
  status: string;
  contato_nome: string | null;
}

export interface Rascunho {
  id: number;
  chat_jid: string;
  texto: string;
  pedido: string;
  status: string;
}

export function nomeDe(c: Pick<Contato, "nome" | "nome_push" | "jid">): string {
  return c.nome || c.nome_push || c.jid.split("@")[0];
}

/** Garante o contato e devolve se ele está fora do assistente. */
export async function garantirContato(
  db: Db,
  jid: string,
  dados: { grupo: boolean; nomePush?: string | null },
): Promise<Contato> {
  const r = await db.query<Contato>(
    `INSERT INTO contatos (jid, grupo, nome_push) VALUES ($1, $2, $3)
     ON CONFLICT (jid) DO UPDATE
       SET nome_push = COALESCE(EXCLUDED.nome_push, contatos.nome_push), atualizado_em = now()
     RETURNING ${COLUNAS_CONTATO}`,
    [jid, dados.grupo, dados.nomePush ?? null],
  );
  return r.rows[0];
}

/**
 * Grava a mensagem; `false` quando o webhook repetiu uma que já estava lá.
 * `extraida` já marcada é para o histórico: conversa antiga ensina quem é quem, mas
 * não pode virar aviso de compromisso de meses atrás.
 */
export async function gravarMensagem(db: Db, m: MensagemRecebida, texto: string, extraida = false): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO mensagens (id, chat_jid, remetente_jid, remetente_nome, de_mim, tipo, texto, enviada_em, extraida)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING`,
    [m.id, m.chatJid, m.remetenteJid, m.remetenteNome, m.deMim, m.tipo, texto, m.enviadaEm, extraida],
  );
  return (r.rowCount ?? 0) > 0;
}

/** O endereço com que a pessoa é guardada (o número, quando já se sabe). */
export async function resolverJid(db: Db, jid: string): Promise<string> {
  const r = await db.query<{ principal: string }>("SELECT principal FROM apelidos WHERE jid = $1", [jid]);
  return r.rows[0]?.principal ?? jid;
}

/**
 * Liga o LID ao número e junta as duas conversas, se as duas já existirem: mensagens,
 * compromissos e rascunhos passam para o número, e os fatos se somam.
 */
export async function registrarApelido(db: Db, a: string, b: string): Promise<string> {
  const principal = a.endsWith("@s.whatsapp.net") ? a : b;
  const apelido = principal === a ? b : a;
  if (apelido === principal || !apelido.endsWith("@lid")) return principal;
  const ja = await db.query("SELECT 1 FROM apelidos WHERE jid = $1", [apelido]);
  if (ja.rowCount) return principal;

  const c = await db.connect();
  try {
    await c.query("BEGIN");
    await c.query("INSERT INTO apelidos (jid, principal) VALUES ($1, $2) ON CONFLICT DO NOTHING", [apelido, principal]);
    const velho = await c.query("SELECT 1 FROM contatos WHERE jid = $1", [apelido]);
    if (velho.rowCount) {
      await c.query(
        `INSERT INTO contatos (jid, nome, nome_push, grupo, excluido, memoria, relacao, resumo, tom, assuntos_abertos,
                               aguardando, aguardando_desde, cobrado_em, autonomia, ficha_em)
         SELECT $1, nome, nome_push, FALSE, excluido, memoria, relacao, resumo, tom, assuntos_abertos,
                aguardando, aguardando_desde, cobrado_em, autonomia, ficha_em
         FROM contatos WHERE jid = $2
         ON CONFLICT (jid) DO UPDATE SET
           nome = COALESCE(contatos.nome, EXCLUDED.nome),
           nome_push = COALESCE(contatos.nome_push, EXCLUDED.nome_push),
           excluido = contatos.excluido OR EXCLUDED.excluido,
           memoria = trim(both E'\n' FROM contatos.memoria || E'\n' || EXCLUDED.memoria),
           relacao = COALESCE(contatos.relacao, EXCLUDED.relacao),
           resumo = CASE WHEN contatos.resumo = '' THEN EXCLUDED.resumo ELSE contatos.resumo END,
           tom = CASE WHEN contatos.tom = '' THEN EXCLUDED.tom ELSE contatos.tom END,
           assuntos_abertos = CASE WHEN contatos.assuntos_abertos = '' THEN EXCLUDED.assuntos_abertos ELSE contatos.assuntos_abertos END,
           aguardando = CASE WHEN contatos.aguardando = '' THEN EXCLUDED.aguardando ELSE contatos.aguardando END,
           aguardando_desde = CASE WHEN contatos.aguardando = '' THEN EXCLUDED.aguardando_desde ELSE contatos.aguardando_desde END,
           cobrado_em = CASE WHEN contatos.aguardando = '' THEN EXCLUDED.cobrado_em ELSE contatos.cobrado_em END,
           -- O nível mais cauteloso vence: juntar não pode dar autonomia que o dono não deu.
           autonomia = CASE WHEN contatos.autonomia IS NULL THEN EXCLUDED.autonomia
                            WHEN EXCLUDED.autonomia IS NULL THEN contatos.autonomia
                            ELSE LEAST(contatos.autonomia, EXCLUDED.autonomia) END,
           -- A ficha mais antiga: as mensagens juntas pedem leitura nova.
           ficha_em = LEAST(contatos.ficha_em, EXCLUDED.ficha_em)`,
        [principal, apelido],
      );
      for (const t of ["mensagens", "compromissos", "rascunhos"]) {
        await c.query(`UPDATE ${t} SET chat_jid = $2 WHERE chat_jid = $1`, [apelido, principal]);
      }
      // Datas têm chave única por pessoa e dia: a que já existir no número fica.
      await c.query(
        `INSERT INTO datas (chat_jid, descricao, mes, dia) SELECT $1, descricao, mes, dia FROM datas WHERE chat_jid = $2
         ON CONFLICT (chat_jid, mes, dia) DO NOTHING`,
        [principal, apelido],
      );
      await c.query("DELETE FROM contatos WHERE jid = $1", [apelido]);
    }
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
  return principal;
}

export async function registrarEnviada(db: Db, id: string | null): Promise<void> {
  if (!id) return;
  await db.query("INSERT INTO enviadas (id) VALUES ($1) ON CONFLICT DO NOTHING", [id]);
}

export async function foiEnviadaPeloAssistente(db: Db, id: string): Promise<boolean> {
  const r = await db.query("SELECT 1 FROM enviadas WHERE id = $1", [id]);
  return (r.rowCount ?? 0) > 0;
}

export async function ultimasMensagens(db: Db, chatJid: string, limite: number): Promise<Mensagem[]> {
  const r = await db.query<Mensagem>(
    `SELECT id, chat_jid, remetente_nome, de_mim, tipo, texto, enviada_em FROM mensagens
     WHERE chat_jid = $1 ORDER BY enviada_em DESC LIMIT $2`,
    [chatJid, limite],
  );
  return r.rows.reverse();
}

/**
 * Chats com mensagem ainda não extraída e quietos há `quietoMin` minutos: a conversa
 * terminou a rajada, então uma chamada só cobre o trecho inteiro.
 */
export async function chatsParaExtrair(db: Db, quietoMin: number, limite = 20): Promise<string[]> {
  const r = await db.query<{ chat_jid: string }>(
    `SELECT m.chat_jid FROM mensagens m JOIN contatos c ON c.jid = m.chat_jid
     WHERE NOT m.extraida AND NOT c.excluido
     GROUP BY m.chat_jid
     HAVING max(m.enviada_em) < now() - make_interval(mins => $1)
     ORDER BY max(m.enviada_em) LIMIT $2`,
    [quietoMin, limite],
  );
  return r.rows.map((x) => x.chat_jid);
}

export async function marcarExtraidas(db: Db, chatJid: string, ate: Date): Promise<void> {
  await db.query("UPDATE mensagens SET extraida = TRUE WHERE chat_jid = $1 AND enviada_em <= $2 AND NOT extraida", [
    chatJid,
    ate,
  ]);
}

export async function lerContato(db: Db, jid: string): Promise<Contato | null> {
  const r = await db.query<Contato>(`SELECT ${COLUNAS_CONTATO} FROM contatos WHERE jid = $1`, [jid]);
  return r.rows[0] ?? null;
}

/** Busca por nome (ou trecho do número), nos dois nomes que o contato pode ter. */
export async function buscarContatos(db: Db, termo: string, limite = 8): Promise<Contato[]> {
  const r = await db.query<Contato>(
    `SELECT c.jid, c.nome, c.nome_push, c.grupo, c.excluido, c.memoria, c.relacao, c.resumo, c.tom, c.assuntos_abertos,
            c.aguardando, c.autonomia
     FROM contatos c
     LEFT JOIN LATERAL (SELECT max(enviada_em) AS ultima FROM mensagens WHERE chat_jid = c.jid) u ON TRUE
     WHERE c.nome ILIKE $1 OR c.nome_push ILIKE $1 OR c.jid ILIKE $1
     ORDER BY u.ultima DESC NULLS LAST LIMIT $2`,
    [`%${termo}%`, limite],
  );
  return r.rows;
}

/** Acrescenta fatos novos à memória, sem repetir linha e com teto de tamanho. */
export async function lembrar(db: Db, jid: string, fatos: string[], teto = 4000): Promise<void> {
  if (!fatos.length) return;
  const atual = (await lerContato(db, jid))?.memoria ?? "";
  const linhas = atual.split("\n").filter(Boolean);
  const vistas = new Set(linhas.map((l) => l.toLowerCase()));
  for (const f of fatos) {
    const linha = `- ${f.trim().replace(/^-\s*/, "")}`;
    if (!vistas.has(linha.toLowerCase())) {
      linhas.push(linha);
      vistas.add(linha.toLowerCase());
    }
  }
  // Mantém as mais recentes quando passa do teto: a memória antiga já virou contexto.
  let texto = linhas.join("\n");
  while (texto.length > teto && linhas.length > 1) {
    linhas.shift();
    texto = linhas.join("\n");
  }
  await db.query("UPDATE contatos SET memoria = $2, atualizado_em = now() WHERE jid = $1", [jid, texto]);
}

export async function excluirChat(db: Db, jid: string, excluido: boolean): Promise<void> {
  if (!excluido) {
    await db.query("UPDATE contatos SET excluido = FALSE, atualizado_em = now() WHERE jid = $1", [jid]);
    return;
  }
  // Quem sai do assistente sai por inteiro: texto, ficha, compromissos, datas e os
  // rascunhos (inclusive o que estava agendado para sair). Fica só o nome, para o "volta".
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      `UPDATE contatos SET excluido = TRUE, memoria = '', relacao = NULL, resumo = '', tom = '', assuntos_abertos = '',
         aguardando = '', aguardando_desde = NULL, cobrado_em = NULL, autonomia = NULL, ficha_em = NULL, atualizado_em = now()
       WHERE jid = $1`,
      [jid],
    );
    for (const t of ["mensagens", "compromissos", "datas", "rascunhos"]) {
      await c.query(`DELETE FROM ${t} WHERE chat_jid = $1`, [jid]);
    }
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}

export async function criarCompromisso(
  db: Db,
  c: { chatJid: string; descricao: string; quando: Date | null; responsavel: string; mensagemId?: string | null },
): Promise<number | null> {
  // O mesmo combinado aparece em mais de uma rodada de extração: não duplica.
  const dup = await db.query(
    `SELECT 1 FROM compromissos WHERE chat_jid = $1 AND lower(descricao) = lower($2) AND status IN ('sugerido','confirmado')`,
    [c.chatJid, c.descricao],
  );
  if (dup.rowCount) return null;
  const r = await db.query<{ id: number }>(
    `INSERT INTO compromissos (chat_jid, descricao, quando, responsavel, mensagem_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [c.chatJid, c.descricao, c.quando, c.responsavel, c.mensagemId ?? null],
  );
  return r.rows[0].id;
}

export async function compromissosAbertos(db: Db, ate?: Date): Promise<Compromisso[]> {
  const r = await db.query<Compromisso>(
    `SELECT k.id, k.chat_jid, k.descricao, k.quando, k.responsavel, k.status,
            COALESCE(c.nome, c.nome_push) AS contato_nome
     FROM compromissos k JOIN contatos c ON c.jid = k.chat_jid
     WHERE k.status IN ('sugerido','confirmado') AND NOT c.excluido AND ($1::timestamptz IS NULL OR k.quando IS NULL OR k.quando <= $1)
     ORDER BY k.quando NULLS LAST, k.id`,
    [ate ?? null],
  );
  return r.rows;
}

export async function mudarCompromisso(db: Db, id: number, status: string): Promise<boolean> {
  const r = await db.query("UPDATE compromissos SET status = $2 WHERE id = $1", [id, status]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Conversas individuais em que a última palavra é do outro, há mais de `horas`
 * horas: é a lista do "quem está esperando resposta".
 */
export async function esperandoResposta(
  db: Db,
  horas: number,
  limite = 15,
): Promise<{ jid: string; nome: string; ultima: string; quando: Date }[]> {
  const r = await db.query<{ jid: string; nome: string; ultima: string; quando: Date }>(
    `SELECT DISTINCT ON (m.chat_jid) m.chat_jid AS jid,
            COALESCE(c.nome, c.nome_push, split_part(c.jid, '@', 1)) AS nome,
            m.texto AS ultima, m.enviada_em AS quando, m.de_mim
     FROM mensagens m JOIN contatos c ON c.jid = m.chat_jid
     WHERE NOT c.grupo AND NOT c.excluido
     ORDER BY m.chat_jid, m.enviada_em DESC`,
  );
  const corte = Date.now() - horas * 3600_000;
  return (r.rows as any[])
    .filter((x) => !x.de_mim && new Date(x.quando).getTime() < corte)
    .sort((a, b) => new Date(b.quando).getTime() - new Date(a.quando).getTime())
    .slice(0, limite)
    .map(({ de_mim, ...x }) => x);
}

export async function buscarMensagens(
  db: Db,
  termo: string,
  limite = 20,
): Promise<(Mensagem & { contato: string })[]> {
  const r = await db.query<Mensagem & { contato: string }>(
    `SELECT m.id, m.chat_jid, m.remetente_nome, m.de_mim, m.tipo, m.texto, m.enviada_em,
            COALESCE(c.nome, c.nome_push, split_part(c.jid, '@', 1)) AS contato
     FROM mensagens m JOIN contatos c ON c.jid = m.chat_jid
     WHERE to_tsvector('portuguese', m.texto) @@ websearch_to_tsquery('portuguese', $1)
     ORDER BY m.enviada_em DESC LIMIT $2`,
    [termo, limite],
  );
  return r.rows;
}

/** Mensagem "de mim" que foi o assistente quem escreveu: não ensina estilo. */
export const NAO_FOI_RASCUNHO = "NOT EXISTS (SELECT 1 FROM rascunhos r WHERE r.mensagem_id = m.id)";

/** Exemplos de como o dono escreve, para o rascunho sair na voz dele. */
export async function exemplosDoDono(db: Db, chatJid: string | null, limite = 40): Promise<string[]> {
  const r = await db.query<{ texto: string }>(
    `(SELECT m.texto, m.enviada_em FROM mensagens m
      WHERE m.de_mim AND m.tipo = 'texto' AND length(m.texto) > 3 AND m.chat_jid = $1 AND ${NAO_FOI_RASCUNHO}
      ORDER BY m.enviada_em DESC LIMIT $2)
     UNION ALL
     (SELECT m.texto, m.enviada_em FROM mensagens m JOIN contatos c ON c.jid = m.chat_jid
      WHERE m.de_mim AND m.tipo = 'texto' AND length(m.texto) > 3 AND NOT c.grupo AND NOT c.excluido
        AND m.chat_jid <> COALESCE($1, '') AND ${NAO_FOI_RASCUNHO}
      ORDER BY m.enviada_em DESC LIMIT $2)`,
    [chatJid, limite],
  );
  return r.rows.map((x) => x.texto).slice(0, limite);
}

export async function criarRascunho(db: Db, chatJid: string, texto: string, pedido: string): Promise<number> {
  const r = await db.query<{ id: number }>(
    "INSERT INTO rascunhos (chat_jid, texto, pedido) VALUES ($1,$2,$3) RETURNING id",
    [chatJid, texto, pedido],
  );
  return r.rows[0].id;
}

export async function lerRascunho(db: Db, id: number): Promise<Rascunho | null> {
  const r = await db.query<Rascunho>("SELECT id, chat_jid, texto, pedido, status FROM rascunhos WHERE id = $1", [id]);
  return r.rows[0] ?? null;
}

/** Os rascunhos aguardando, do mais novo ao mais velho. */
export async function rascunhosAguardando(db: Db, limite = 10): Promise<Rascunho[]> {
  const r = await db.query<Rascunho>(
    "SELECT id, chat_jid, texto, pedido, status FROM rascunhos WHERE status = 'aguardando' ORDER BY id DESC LIMIT $1",
    [limite],
  );
  return r.rows;
}

/** Troca o texto só se o rascunho ainda espera: o que já saiu não muda depois. */
export async function atualizarRascunho(db: Db, id: number, texto: string): Promise<boolean> {
  const r = await db.query("UPDATE rascunhos SET texto = $2 WHERE id = $1 AND status = 'aguardando'", [id, texto]);
  return (r.rowCount ?? 0) > 0;
}

export async function decidirRascunho(db: Db, id: number, status: "enviado" | "descartado"): Promise<boolean> {
  // Só sai de "aguardando": dois "ok" seguidos não mandam a mesma resposta duas vezes.
  const r = await db.query(
    "UPDATE rascunhos SET status = $2, decidido_em = now(), enviar_em = NULL WHERE id = $1 AND status = 'aguardando'",
    [id, status],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Condições do envio sem o dono olhar (autonomia nível 2 ou 3). */
export interface EnvioAutomatico {
  padrao: number;
  nivelMinimo: 2 | 3;
  /** Nível 2: só sai se continua agendado (veto, ajuste e pausa limpam o horário). */
  agendado: boolean;
  agora: Date;
}

/**
 * Reserva o rascunho para envio e devolve o texto que vai sair. Tudo é conferido no
 * mesmo UPDATE: entre ler e enviar o dono pode ter vetado, ajustado, pausado, baixado o
 * nível, tirado a pessoa do assistente ou respondido à mão, e nada disso pode escapar.
 */
export async function reservarEnvio(
  db: Db,
  id: number,
  auto?: EnvioAutomatico,
): Promise<{ chat_jid: string; texto: string } | null> {
  const r = await db.query<{ chat_jid: string; texto: string }>(
    `UPDATE rascunhos r SET status = 'enviado', decidido_em = now(), enviar_em = NULL
     FROM contatos c
     WHERE r.id = $1 AND r.status = 'aguardando' AND c.jid = r.chat_jid AND NOT c.excluido
       AND r.texto !~* '\\[preencher:'
       AND ($2::int IS NULL OR (
         NOT c.grupo AND NOT r.ajustado AND r.risco = 'baixo'
         AND COALESCE(c.autonomia, $3::int) >= $2::int
         AND (NOT $4::boolean OR (r.enviar_em IS NOT NULL AND r.enviar_em <= $5::timestamptz))
         AND NOT EXISTS (SELECT 1 FROM estado WHERE chave = 'autonomia:pausada' AND valor = '1')
         AND NOT EXISTS (SELECT 1 FROM mensagens m WHERE m.chat_jid = r.chat_jid AND m.de_mim AND m.enviada_em > r.criado_em)
       ))
     RETURNING r.chat_jid, r.texto`,
    [id, auto?.nivelMinimo ?? null, auto?.padrao ?? 0, auto?.agendado ?? false, auto?.agora ?? new Date()],
  );
  return r.rows[0] ?? null;
}

/** Agenda o envio com janela de veto, se o rascunho ainda espera e nada foi pausado. */
export async function agendarEnvio(db: Db, id: number, quando: Date): Promise<boolean> {
  const r = await db.query(
    `UPDATE rascunhos SET enviar_em = $2 WHERE id = $1 AND status = 'aguardando'
       AND NOT EXISTS (SELECT 1 FROM estado WHERE chave = 'autonomia:pausada' AND valor = '1')`,
    [id, quando],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function apagarAntigas(db: Db, dias: number): Promise<number> {
  const r = await db.query("DELETE FROM mensagens WHERE enviada_em < now() - make_interval(days => $1)", [dias]);
  await db.query("DELETE FROM enviadas WHERE criada_em < now() - interval '30 days'");
  return r.rowCount ?? 0;
}

export interface Ficha {
  relacao?: string | null;
  resumo?: string;
  tom?: string;
  assuntos_abertos?: string;
}

const RELACOES = new Set(["cliente", "familia", "amigo", "trabalho", "fornecedor", "outro"]);

/** Atualiza só o que veio preenchido: uma leitura curta não apaga o que uma longa já sabia. */
export async function atualizarFicha(db: Db, jid: string, f: Ficha): Promise<void> {
  const relacao = f.relacao && RELACOES.has(f.relacao) ? f.relacao : null;
  await db.query(
    `UPDATE contatos SET
       relacao = COALESCE($2, relacao),
       resumo = COALESCE(NULLIF($3, ''), resumo),
       tom = COALESCE(NULLIF($4, ''), tom),
       assuntos_abertos = COALESCE($5, assuntos_abertos),
       ficha_em = now(), atualizado_em = now()
     WHERE jid = $1`,
    [jid, relacao, f.resumo ?? "", f.tom ?? "", f.assuntos_abertos ?? null],
  );
}

/**
 * Contatos que pedem ficha nova: nunca lidos, ou com conversa nova desde a última
 * leitura. Os mais ativos primeiro, porque são os que o dono mais vai consultar.
 */
export async function contatosParaConhecer(db: Db, limite: number, minimoMensagens = 6): Promise<string[]> {
  const r = await db.query<{ jid: string }>(
    `SELECT c.jid FROM contatos c
     JOIN mensagens m ON m.chat_jid = c.jid
     WHERE NOT c.excluido AND (c.ficha_em IS NULL OR m.enviada_em > c.ficha_em)
     GROUP BY c.jid
     HAVING count(*) >= $2
     ORDER BY count(*) DESC LIMIT $1`,
    [limite, minimoMensagens],
  );
  return r.rows.map((x) => x.jid);
}

export interface Perfil {
  regras: { id: number; texto: string }[];
  licoes: { id: number; texto: string }[];
  gerado: string;
}

export async function lerPerfil(db: Db): Promise<Perfil> {
  const r = await db.query<{ id: number; tipo: string; texto: string }>(
    "SELECT id, tipo, texto FROM perfil WHERE ativo ORDER BY id",
  );
  return {
    regras: r.rows.filter((x) => x.tipo === "regra"),
    licoes: r.rows.filter((x) => x.tipo === "licao").slice(-40),
    gerado: r.rows.filter((x) => x.tipo === "gerado").at(-1)?.texto ?? "",
  };
}

/** Acrescenta regra ou lição, sem repetir texto igual. */
export async function acrescentarPerfil(db: Db, tipo: "regra" | "licao", texto: string): Promise<number | null> {
  const t = texto.trim();
  if (!t) return null;
  const dup = await db.query("SELECT 1 FROM perfil WHERE ativo AND tipo = $1 AND lower(texto) = lower($2)", [tipo, t]);
  if (dup.rowCount) return null;
  const r = await db.query<{ id: number }>("INSERT INTO perfil (tipo, texto) VALUES ($1, $2) RETURNING id", [tipo, t]);
  return r.rows[0].id;
}

export async function trocarPerfilGerado(db: Db, texto: string): Promise<void> {
  await db.query("UPDATE perfil SET ativo = FALSE WHERE tipo = 'gerado' AND ativo");
  await db.query("INSERT INTO perfil (tipo, texto) VALUES ('gerado', $1)", [texto]);
}

export async function desativarPerfil(db: Db, id: number): Promise<boolean> {
  const r = await db.query("UPDATE perfil SET ativo = FALSE WHERE id = $1 AND tipo <> 'gerado'", [id]);
  return (r.rowCount ?? 0) > 0;
}

/** O perfil em texto, como entra nos prompts: regra do dono antes de tudo. */
export function perfilEmTexto(p: Perfil): string {
  return [
    p.regras.length ? `Regras que ele mesmo deu (valem acima de tudo):\n${p.regras.map((r) => `- ${r.texto}`).join("\n")}` : "",
    p.licoes.length ? `Lições das correções dele:\n${p.licoes.map((r) => `- ${r.texto}`).join("\n")}` : "",
    p.gerado ? `Retrato dele (escrito a partir das mensagens):\n${p.gerado}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** A ficha em texto, como entra nos prompts. */
export function fichaEmTexto(c: Contato): string {
  return [
    c.relacao ? `Relação: ${c.relacao}` : "",
    c.resumo ? `Quem é: ${c.resumo}` : "",
    c.tom ? `Como o dono fala com essa pessoa: ${c.tom}` : "",
    c.assuntos_abertos ? `Assuntos em aberto: ${c.assuntos_abertos}` : "",
    c.aguardando ? `O dono está esperando dela: ${c.aguardando}` : "",
    c.memoria ? `Fatos:\n${c.memoria}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Atualiza o que o dono espera do contato; a data só muda quando o assunto muda. */
export async function atualizarAguardando(db: Db, jid: string, aguardando: string | null): Promise<void> {
  const novo = (aguardando ?? "").trim();
  await db.query(
    `UPDATE contatos SET
       aguardando_desde = CASE WHEN $2 = '' THEN NULL WHEN aguardando = $2 THEN aguardando_desde ELSE now() END,
       cobrado_em = CASE WHEN aguardando = $2 THEN cobrado_em ELSE NULL END,
       aguardando = $2
     WHERE jid = $1`,
    [jid, novo],
  );
}

/** Quem ficou de mandar algo há `dias` dias e ainda não foi cobrado desde então. */
export async function paraCobrar(db: Db, dias: number): Promise<(Contato & { aguardando_desde: Date })[]> {
  const r = await db.query<Contato & { aguardando_desde: Date }>(
    `SELECT ${COLUNAS_CONTATO}, aguardando_desde FROM contatos
     WHERE NOT excluido AND NOT grupo AND aguardando <> '' AND aguardando_desde < now() - make_interval(days => $1)
       AND (cobrado_em IS NULL OR cobrado_em < aguardando_desde)
     ORDER BY aguardando_desde`,
    [dias],
  );
  return r.rows;
}

export async function marcarCobrado(db: Db, jid: string): Promise<void> {
  await db.query("UPDATE contatos SET cobrado_em = now() WHERE jid = $1", [jid]);
}

/** Aviso ainda não dado? Grava e devolve true; já dado, false. Uma chave por aviso. */
export async function alertaNovo(db: Db, chave: string): Promise<boolean> {
  const r = await db.query("INSERT INTO alertas (chave) VALUES ($1) ON CONFLICT DO NOTHING", [chave]);
  return (r.rowCount ?? 0) > 0;
}

export async function gravarDatas(db: Db, jid: string, datas: { descricao: string; mes: number; dia: number }[]): Promise<void> {
  for (const d of datas) {
    if (!(d.mes >= 1 && d.mes <= 12 && d.dia >= 1 && d.dia <= 31)) continue;
    await db.query(
      `INSERT INTO datas (chat_jid, descricao, mes, dia) VALUES ($1, $2, $3, $4)
       ON CONFLICT (chat_jid, mes, dia) DO UPDATE SET descricao = EXCLUDED.descricao`,
      [jid, d.descricao, d.mes, d.dia],
    );
  }
}

/** Datas dos próximos `dias` dias (virando o ano), a partir de `hoje` no fuso do dono. */
export async function datasProximas(
  db: Db,
  hoje: { mes: number; dia: number; ano: number },
  dias: number,
): Promise<{ jid: string; nome: string; descricao: string; mes: number; dia: number; faltam: number }[]> {
  const r = await db.query<{ jid: string; nome: string; descricao: string; mes: number; dia: number }>(
    `SELECT d.chat_jid AS jid, COALESCE(c.nome, c.nome_push, split_part(c.jid, '@', 1)) AS nome, d.descricao, d.mes, d.dia
     FROM datas d JOIN contatos c ON c.jid = d.chat_jid WHERE NOT c.excluido`,
  );
  const base = Date.UTC(hoje.ano, hoje.mes - 1, hoje.dia);
  return r.rows
    .map((x) => {
      let alvo = Date.UTC(hoje.ano, x.mes - 1, x.dia);
      if (alvo < base) alvo = Date.UTC(hoje.ano + 1, x.mes - 1, x.dia);
      return { ...x, faltam: Math.round((alvo - base) / 86400_000) };
    })
    .filter((x) => x.faltam <= dias)
    .sort((a, b) => a.faltam - b.faltam);
}

export async function nivelDeAutonomia(db: Db, jid: string, padrao: number): Promise<number> {
  const r = await db.query<{ autonomia: number | null; grupo: boolean; excluido: boolean }>(
    "SELECT autonomia, grupo, excluido FROM contatos WHERE jid = $1",
    [jid],
  );
  const c = r.rows[0];
  if (!c || c.excluido) return 0;
  // Grupo nunca recebe resposta automática: quem responde em grupo é o dono.
  if (c.grupo) return 0;
  return c.autonomia ?? padrao;
}

export async function definirAutonomia(db: Db, jid: string, nivel: number | null): Promise<void> {
  await db.query("UPDATE contatos SET autonomia = $2, atualizado_em = now() WHERE jid = $1", [jid, nivel]);
}

/** Taxa de acerto: rascunhos decididos, e quantos saíram sem ajuste. */
export async function acertos(db: Db, jid?: string): Promise<{ jid: string; nome: string; decididos: number; sem_ajuste: number; autonomia: number | null }[]> {
  const r = await db.query(
    `SELECT r.chat_jid AS jid, COALESCE(c.nome, c.nome_push, split_part(c.jid, '@', 1)) AS nome, c.autonomia,
            count(*)::int AS decididos,
            count(*) FILTER (WHERE r.status = 'enviado' AND NOT r.ajustado)::int AS sem_ajuste
     FROM rascunhos r JOIN contatos c ON c.jid = r.chat_jid
     WHERE r.status IN ('enviado', 'descartado') AND ($1::text IS NULL OR r.chat_jid = $1)
     GROUP BY r.chat_jid, c.nome, c.nome_push, c.jid, c.autonomia
     ORDER BY count(*) DESC`,
    [jid ?? null],
  );
  return r.rows;
}

export async function rascunhosParaEnviar(db: Db, agora: Date): Promise<Rascunho[]> {
  const r = await db.query<Rascunho>(
    `SELECT id, chat_jid, texto, pedido, status FROM rascunhos
     WHERE status = 'aguardando' AND enviar_em IS NOT NULL AND enviar_em <= $1 ORDER BY enviar_em`,
    [agora],
  );
  return r.rows;
}

export async function rascunhoAberto(db: Db, jid: string): Promise<boolean> {
  const r = await db.query("SELECT 1 FROM rascunhos WHERE chat_jid = $1 AND status = 'aguardando'", [jid]);
  return (r.rowCount ?? 0) > 0;
}
