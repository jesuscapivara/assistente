import type { Db } from "./db.js";
import type { MensagemRecebida } from "./whatsapp/evento.js";

export interface Contato {
  jid: string;
  nome: string | null;
  nome_push: string | null;
  grupo: boolean;
  excluido: boolean;
  memoria: string;
}

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
     RETURNING jid, nome, nome_push, grupo, excluido, memoria`,
    [jid, dados.grupo, dados.nomePush ?? null],
  );
  return r.rows[0];
}

/** Grava a mensagem; `false` quando o webhook repetiu uma que já estava lá. */
export async function gravarMensagem(db: Db, m: MensagemRecebida, texto: string): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO mensagens (id, chat_jid, remetente_jid, remetente_nome, de_mim, tipo, texto, enviada_em)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
    [m.id, m.chatJid, m.remetenteJid, m.remetenteNome, m.deMim, m.tipo, texto, m.enviadaEm],
  );
  return (r.rowCount ?? 0) > 0;
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
  const r = await db.query<Contato>("SELECT jid, nome, nome_push, grupo, excluido, memoria FROM contatos WHERE jid = $1", [
    jid,
  ]);
  return r.rows[0] ?? null;
}

/** Busca por nome (ou trecho do número), nos dois nomes que o contato pode ter. */
export async function buscarContatos(db: Db, termo: string, limite = 8): Promise<Contato[]> {
  const r = await db.query<Contato>(
    `SELECT c.jid, c.nome, c.nome_push, c.grupo, c.excluido, c.memoria FROM contatos c
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
  await db.query("UPDATE contatos SET excluido = $2, atualizado_em = now() WHERE jid = $1", [jid, excluido]);
  // Quem sai do assistente sai por inteiro: o texto já gravado vai junto.
  if (excluido) await db.query("DELETE FROM mensagens WHERE chat_jid = $1", [jid]);
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
     WHERE k.status IN ('sugerido','confirmado') AND ($1::timestamptz IS NULL OR k.quando IS NULL OR k.quando <= $1)
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

/** Exemplos de como o dono escreve, para o rascunho sair na voz dele. */
export async function exemplosDoDono(db: Db, chatJid: string | null, limite = 40): Promise<string[]> {
  const r = await db.query<{ texto: string }>(
    `(SELECT texto, enviada_em FROM mensagens WHERE de_mim AND tipo = 'texto' AND length(texto) > 3 AND chat_jid = $1
      ORDER BY enviada_em DESC LIMIT $2)
     UNION ALL
     (SELECT texto, enviada_em FROM mensagens m JOIN contatos c ON c.jid = m.chat_jid
      WHERE m.de_mim AND m.tipo = 'texto' AND length(m.texto) > 3 AND NOT c.grupo AND m.chat_jid <> COALESCE($1, '')
      ORDER BY enviada_em DESC LIMIT $2)`,
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

export async function lerRascunho(db: Db, id?: number): Promise<Rascunho | null> {
  const r = id
    ? await db.query<Rascunho>("SELECT id, chat_jid, texto, pedido, status FROM rascunhos WHERE id = $1", [id])
    : await db.query<Rascunho>(
        "SELECT id, chat_jid, texto, pedido, status FROM rascunhos WHERE status = 'aguardando' ORDER BY id DESC LIMIT 1",
      );
  return r.rows[0] ?? null;
}

export async function atualizarRascunho(db: Db, id: number, texto: string): Promise<void> {
  await db.query("UPDATE rascunhos SET texto = $2 WHERE id = $1", [id, texto]);
}

export async function decidirRascunho(db: Db, id: number, status: "enviado" | "descartado"): Promise<boolean> {
  // Só sai de "aguardando": dois "ok" seguidos não mandam a mesma resposta duas vezes.
  const r = await db.query(
    "UPDATE rascunhos SET status = $2, decidido_em = now() WHERE id = $1 AND status = 'aguardando'",
    [id, status],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function apagarAntigas(db: Db, dias: number): Promise<number> {
  const r = await db.query("DELETE FROM mensagens WHERE enviada_em < now() - make_interval(days => $1)", [dias]);
  await db.query("DELETE FROM enviadas WHERE criada_em < now() - interval '30 days'");
  return r.rowCount ?? 0;
}
