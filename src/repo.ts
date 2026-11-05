import { TIPOS_DE_ARQUIVO, semMiniatura } from "./arquivos.js";
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
  situacao: string;
  espera_resposta: boolean;
  sistema: boolean;
  sugestoes: string;
  /** Grupo de promoção: fora do assistente, só passa pelas ofertas. */
  promo: boolean;
  /** Grupo lido sempre (obra, projeto), não só quando cita o dono; as fotos são descritas. */
  acompanhado: boolean;
}

const COLUNAS_CONTATO =
  "jid, nome, nome_push, grupo, excluido, memoria, relacao, resumo, tom, assuntos_abertos, aguardando, autonomia, situacao, espera_resposta, sistema, sugestoes, promo, acompanhado";

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
  /** Arquivo que vai junto, com o texto como legenda (só por pedido do dono). */
  anexo_id?: number | null;
}

/**
 * Como a pessoa aparece para o dono. Sem nome na agenda nem no perfil, o número
 * formatado; e o LID, que é um código interno do WhatsApp e não um telefone, nunca
 * aparece: "#81690412224708" não diz nada a ninguém.
 */
export function nomeDe(c: Pick<Contato, "nome" | "nome_push" | "jid">): string {
  if (c.nome || c.nome_push) return (c.nome || c.nome_push)!;
  return c.jid.endsWith("@s.whatsapp.net") ? `+${c.jid.split("@")[0]}` : "contato sem nome";
}

/** O mesmo `nomeDe`, em SQL. `a` é o apelido da tabela de contatos ("c" ou ""). */
export function nomeSql(a = "c"): string {
  const p = a ? `${a}.` : "";
  return `COALESCE(${p}nome, ${p}nome_push, CASE WHEN ${p}jid LIKE '%@s.whatsapp.net' THEN '+' || split_part(${p}jid, '@', 1) ELSE 'contato sem nome' END)`;
}
export const NOME_SQL = nomeSql("c");

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
  // Mídia guarda a mensagem original (sem miniatura): é o que permite baixar o arquivo depois.
  const midia = TIPOS_DE_ARQUIVO.has(m.tipo) && m.bruto ? JSON.stringify(semMiniatura(m.bruto)) : null;
  const r = await db.query(
    `INSERT INTO mensagens (id, chat_jid, remetente_jid, remetente_nome, de_mim, tipo, texto, enviada_em, extraida, midia)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
    [m.id, m.chatJid, m.remetenteJid, m.remetenteNome, m.deMim, m.tipo, texto, m.enviadaEm, extraida, midia],
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
                               aguardando, aguardando_desde, cobrado_em, autonomia, ficha_em, situacao, espera_resposta, sistema)
         SELECT $1, nome, nome_push, FALSE, excluido, memoria, relacao, resumo, tom, assuntos_abertos,
                aguardando, aguardando_desde, cobrado_em, autonomia, ficha_em, situacao, espera_resposta, sistema
         FROM contatos WHERE jid = $2
         ON CONFLICT (jid) DO UPDATE SET
           situacao = CASE WHEN contatos.situacao = '' THEN EXCLUDED.situacao ELSE contatos.situacao END,
           espera_resposta = contatos.espera_resposta OR EXCLUDED.espera_resposta,
           sistema = contatos.sistema OR EXCLUDED.sistema,
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
    `SELECT ${COLUNAS_CONTATO.split(", ").map((x) => `c.${x}`).join(", ")}
     FROM contatos c
     LEFT JOIN LATERAL (SELECT max(enviada_em) AS ultima FROM mensagens WHERE chat_jid = c.jid) u ON TRUE
     WHERE c.nome ILIKE $1 OR c.nome_push ILIKE $1 OR c.jid ILIKE $1
        -- Contato sem nome se acha pelo que se sabe dele ("o cliente da pavimentação"),
        -- mas só quando nenhum nome bate: senão "cobra João" acharia quem fala do João.
        OR (c.resumo ILIKE $1 AND NOT EXISTS (SELECT 1 FROM contatos n WHERE n.nome ILIKE $1 OR n.nome_push ILIKE $1))
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

/**
 * Grupo de promoção: sai do assistente como o `fora` (apaga o que havia, não grava mais),
 * mas as ofertas novas passam pela lista de interesses. `volta` desfaz os dois.
 */
export async function marcarPromo(db: Db, jid: string): Promise<void> {
  await excluirChat(db, jid, true);
  await db.query("UPDATE contatos SET promo = TRUE WHERE jid = $1", [jid]);
}

export interface ArquivoGuardado {
  id: string;
  chat_jid: string;
  contato: string;
  tipo: string;
  texto: string;
  de_mim: boolean;
  enviada_em: Date;
  midia: unknown;
}

/**
 * Os arquivos que dá para baixar (os que chegaram depois da 1.18.0, com a mídia guardada),
 * do mais novo para o mais antigo. Conversa fora do assistente não aparece.
 */
export async function arquivos(
  db: Db,
  f: { jid?: string; tipos: string[]; desde?: Date; limite: number },
): Promise<ArquivoGuardado[]> {
  const r = await db.query<ArquivoGuardado>(
    `SELECT m.id, m.chat_jid, ${NOME_SQL} AS contato, m.tipo, m.texto, m.de_mim, m.enviada_em, m.midia
     FROM mensagens m JOIN contatos c ON c.jid = m.chat_jid
     WHERE m.midia IS NOT NULL AND NOT c.excluido AND m.tipo = ANY($1)
       AND ($2::text IS NULL OR m.chat_jid = $2) AND ($3::timestamptz IS NULL OR m.enviada_em > $3)
     ORDER BY m.enviada_em DESC LIMIT $4`,
    [f.tipos, f.jid ?? null, f.desde ?? null, f.limite],
  );
  return r.rows;
}

export async function lerArquivo(db: Db, id: string): Promise<ArquivoGuardado | null> {
  const r = await db.query<ArquivoGuardado>(
    `SELECT m.id, m.chat_jid, ${NOME_SQL} AS contato, m.tipo, m.texto, m.de_mim, m.enviada_em, m.midia
     FROM mensagens m JOIN contatos c ON c.jid = m.chat_jid
     WHERE m.id = $1 AND m.midia IS NOT NULL AND NOT c.excluido`,
    [id],
  );
  return r.rows[0] ?? null;
}

/** Liga ou desliga o acompanhamento de um grupo. Pessoa não tem isso: já é lida sempre. */
export async function acompanharGrupo(db: Db, jid: string, sim: boolean): Promise<boolean> {
  const r = await db.query("UPDATE contatos SET acompanhado = $2 WHERE jid = $1 AND grupo AND NOT excluido", [jid, sim]);
  return (r.rowCount ?? 0) > 0;
}

export async function gruposAcompanhados(db: Db): Promise<string[]> {
  const r = await db.query<{ nome: string }>(`SELECT ${NOME_SQL} AS nome FROM contatos c WHERE c.acompanhado AND NOT c.excluido ORDER BY 1`);
  return r.rows.map((x) => x.nome);
}

/** Os nomes dos grupos de promoção vigiados. */
export async function gruposDePromo(db: Db): Promise<string[]> {
  const r = await db.query<{ nome: string }>(
    `SELECT ${NOME_SQL} AS nome FROM contatos c WHERE c.promo
     UNION ALL SELECT nome || ' (Telegram)' FROM telegram_chats WHERE promo ORDER BY 1`,
  );
  return r.rows.map((x) => x.nome);
}

export async function excluirChat(db: Db, jid: string, excluido: boolean): Promise<void> {
  if (!excluido) {
    await db.query("UPDATE contatos SET excluido = FALSE, promo = FALSE, atualizado_em = now() WHERE jid = $1", [jid]);
    return;
  }
  // Quem sai do assistente sai por inteiro: texto, ficha, compromissos, datas e os
  // rascunhos (inclusive o que estava agendado para sair). Fica só o nome, para o "volta".
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      `UPDATE contatos SET excluido = TRUE, memoria = '', relacao = NULL, resumo = '', tom = '', assuntos_abertos = '',
         situacao = '', espera_resposta = FALSE,
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
  // O mesmo combinado aparece em mais de uma rodada de extração, e o modelo não repete
  // as palavras ("ligar para o András" e "ligar para o Arq. András Juhász", 22/10/2026).
  // Mesma conversa, mesmo responsável e horário a menos de 1 hora é o mesmo compromisso.
  const dup = await db.query(
    `SELECT 1 FROM compromissos WHERE chat_jid = $1 AND status IN ('sugerido','confirmado')
       AND (lower(descricao) = lower($2)
            OR ($3::timestamptz IS NOT NULL AND quando IS NOT NULL AND responsavel = $4
                AND abs(extract(epoch FROM quando - $3::timestamptz)) < 3600))`,
    [c.chatJid, c.descricao, c.quando, c.responsavel],
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
  const r = await db.query(
    `UPDATE compromissos SET status = $2,
       decidido_em = CASE WHEN $2 IN ('feito', 'descartado') THEN now() ELSE decidido_em END
     WHERE id = $1`,
    [id, status],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Quem espera resposta do dono há mais de `horas` horas: a leitura da conversa disse
 * que sim (`espera_resposta`), é gente (não sistema) e a última palavra ainda é do
 * outro. A situação vai junto: a última mensagem sozinha não diz do que se trata.
 */
export async function esperandoResposta(
  db: Db,
  horas: number,
  limite = 15,
): Promise<{ jid: string; nome: string; ultima: string; quando: Date; situacao: string }[]> {
  const r = await db.query<{ jid: string; nome: string; ultima: string; quando: Date; situacao: string; de_mim: boolean }>(
    `SELECT c.jid, ${NOME_SQL} AS nome, c.situacao, u.texto AS ultima, u.enviada_em AS quando, u.de_mim
     FROM contatos c
     JOIN LATERAL (SELECT texto, enviada_em, de_mim FROM mensagens WHERE chat_jid = c.jid ORDER BY enviada_em DESC LIMIT 1) u ON TRUE
     WHERE c.espera_resposta AND NOT c.grupo AND NOT c.sistema AND NOT c.excluido
       AND (c.adiado_ate IS NULL OR c.adiado_ate <= now())`,
  );
  const corte = Date.now() - horas * 3600_000;
  return r.rows
    .filter((x) => !x.de_mim && new Date(x.quando).getTime() < corte)
    .sort((a, b) => new Date(b.quando).getTime() - new Date(a.quando).getTime())
    .slice(0, limite)
    .map(({ de_mim: _, ...x }) => x);
}

/** O que a leitura da conversa concluiu: onde ela está, se espera o dono, se é robô. */
export async function atualizarConversa(
  db: Db,
  jid: string,
  c: { situacao: string; esperaResposta: boolean; sistema?: boolean; sugestoes?: string[] },
): Promise<void> {
  // Sugestão só faz sentido enquanto alguém espera resposta.
  const sugestoes = c.esperaResposta ? (c.sugestoes ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 3) : [];
  await db.query(
    `UPDATE contatos SET situacao = $2, espera_resposta = $3, sistema = sistema OR $4, sugestoes = $5, atualizado_em = now() WHERE jid = $1`,
    [jid, c.situacao.trim(), c.esperaResposta, c.sistema ?? false, JSON.stringify(sugestoes)],
  );
}

export function sugestoesDe(c: { sugestoes?: string | null }): string[] {
  try {
    const x = JSON.parse(c.sugestoes ?? "[]");
    return Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/** O dono respondeu: até a próxima leitura, ninguém ali espera por ele. */
export async function donoRespondeu(db: Db, jid: string): Promise<void> {
  await db.query("UPDATE contatos SET espera_resposta = FALSE WHERE jid = $1 AND espera_resposta", [jid]);
}

/** Nomes da agenda do celular. Só preenche: nome que o dono deu não é trocado. */
export async function gravarNomesDaAgenda(db: Db, nomes: { jid: string; nome: string | null; push: string | null }[]): Promise<number> {
  let n = 0;
  for (const x of nomes) {
    const jid = await resolverJid(db, x.jid);
    const r = await db.query(
      `UPDATE contatos SET nome = COALESCE(nome, $2), nome_push = COALESCE(nome_push, $3)
       WHERE jid = $1 AND ((nome IS NULL AND $2::text IS NOT NULL) OR (nome_push IS NULL AND $3::text IS NOT NULL))`,
      [jid, x.nome, x.push],
    );
    n += r.rowCount ?? 0;
  }
  return n;
}

/**
 * Nome dos grupos, como está no WhatsApp. Ao contrário da agenda, troca o que havia:
 * o nome do grupo é do grupo (alguém pode renomear), não um apelido que o dono deu.
 * Só toca grupo que o assistente já conhece; não cria contato.
 */
export async function gravarNomesDeGrupos(db: Db, grupos: { jid: string; nome: string | null }[]): Promise<number> {
  let n = 0;
  for (const g of grupos) {
    if (!g.nome) continue;
    const r = await db.query("UPDATE contatos SET nome = $2 WHERE jid = $1 AND grupo AND nome IS DISTINCT FROM $2", [g.jid, g.nome]);
    n += r.rowCount ?? 0;
  }
  return n;
}

export interface Fala {
  autor: "dono" | "assistente";
  texto: string;
  refs: string;
  criado_em: Date;
}

/** Uma mensagem do chat de controle, nos dois sentidos. `refs`: quem foi citado, com o jid. */
export async function registrarFala(db: Db, autor: Fala["autor"], texto: string, refs = ""): Promise<void> {
  await db.query("INSERT INTO dialogo (autor, texto, refs) VALUES ($1, $2, $3)", [autor, texto, refs]);
}

/** As últimas falas do chat de controle dentro de `horas`, da mais velha para a mais nova. */
export async function dialogoRecente(db: Db, limite: number, horas = 24): Promise<Fala[]> {
  const r = await db.query<Fala>(
    `SELECT autor, texto, refs, criado_em FROM dialogo
     WHERE criado_em > now() - make_interval(hours => $2) ORDER BY id DESC LIMIT $1`,
    [limite, horas],
  );
  return r.rows.reverse();
}

export async function buscarMensagens(
  db: Db,
  termo: string,
  limite = 20,
): Promise<(Mensagem & { contato: string })[]> {
  const r = await db.query<Mensagem & { contato: string }>(
    `SELECT m.id, m.chat_jid, m.remetente_nome, m.de_mim, m.tipo, m.texto, m.enviada_em,
            ${NOME_SQL} AS contato
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

export async function criarRascunho(db: Db, chatJid: string, texto: string, pedido: string, anexoId: number | null = null): Promise<number> {
  const r = await db.query<{ id: number }>(
    "INSERT INTO rascunhos (chat_jid, texto, pedido, anexo_id) VALUES ($1,$2,$3,$4) RETURNING id",
    [chatJid, texto, pedido, anexoId],
  );
  return r.rows[0].id;
}

export interface Anexo {
  id: number;
  nome: string;
  mimetype: string;
  dados: Buffer;
}

export async function criarAnexo(db: Db, a: { nome: string; mimetype: string; dados: Buffer }): Promise<number> {
  const r = await db.query<{ id: number }>("INSERT INTO anexos (nome, mimetype, dados) VALUES ($1,$2,$3) RETURNING id", [a.nome, a.mimetype, a.dados]);
  return r.rows[0].id;
}

export async function lerAnexo(db: Db, id: number): Promise<Anexo | null> {
  const r = await db.query<Anexo>("SELECT id, nome, mimetype, dados FROM anexos WHERE id = $1", [id]);
  return r.rows[0] ?? null;
}

/** Só o nome e o tamanho, para mostrar ao dono sem carregar o arquivo. */
export async function descreverAnexo(db: Db, id: number): Promise<{ nome: string; tamanho: number } | null> {
  const r = await db.query<{ nome: string; tamanho: number }>("SELECT nome, length(dados)::int AS tamanho FROM anexos WHERE id = $1", [id]);
  return r.rows[0] ?? null;
}

export async function lerRascunho(db: Db, id: number): Promise<Rascunho | null> {
  const r = await db.query<Rascunho>("SELECT id, chat_jid, texto, pedido, status, anexo_id FROM rascunhos WHERE id = $1", [id]);
  return r.rows[0] ?? null;
}

/** Os rascunhos aguardando, do mais novo ao mais velho. */
export async function rascunhosAguardando(db: Db, limite = 10): Promise<Rascunho[]> {
  const r = await db.query<Rascunho>(
    "SELECT id, chat_jid, texto, pedido, status, anexo_id FROM rascunhos WHERE status = 'aguardando' ORDER BY id DESC LIMIT $1",
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
): Promise<{ chat_jid: string; texto: string; anexo_id: number | null } | null> {
  const r = await db.query<{ chat_jid: string; texto: string; anexo_id: number | null }>(
    `UPDATE rascunhos r SET status = 'enviado', decidido_em = now(), enviar_em = NULL
     FROM contatos c
     WHERE r.id = $1 AND r.status = 'aguardando' AND c.jid = r.chat_jid AND NOT c.excluido
       AND r.texto !~* '\\[preencher:'
       AND ($2::int IS NULL OR (
         -- Anexo só sai pelo ok do dono, nunca pela autonomia.
         r.anexo_id IS NULL AND
         NOT c.grupo AND NOT r.ajustado AND r.risco = 'baixo'
         AND COALESCE(c.autonomia, $3::int) >= $2::int
         AND (NOT $4::boolean OR (r.enviar_em IS NOT NULL AND r.enviar_em <= $5::timestamptz))
         AND NOT EXISTS (SELECT 1 FROM estado WHERE chave = 'autonomia:pausada' AND valor = '1')
         AND NOT EXISTS (SELECT 1 FROM mensagens m WHERE m.chat_jid = r.chat_jid AND m.de_mim AND m.enviada_em > r.criado_em)
       ))
     RETURNING r.chat_jid, r.texto, r.anexo_id`,
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
  // O chat de controle vale como memória de curto prazo; o que importa dele vai para o caderno.
  await db.query("DELETE FROM dialogo WHERE criado_em < now() - interval '14 days'");
  await db.query("DELETE FROM consumo WHERE criado_em < now() - interval '180 days'");
  // Anexo de rascunho que ainda espera fica; o resto sai depois de 30 dias.
  await db.query(
    `DELETE FROM anexos a WHERE a.criado_em < now() - interval '30 days'
       AND NOT EXISTS (SELECT 1 FROM rascunhos r WHERE r.anexo_id = a.id AND r.status = 'aguardando')`,
  );
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
     WHERE NOT c.excluido AND NOT c.sistema AND (c.ficha_em IS NULL OR m.enviada_em > c.ficha_em)
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
  /** O que o dono corrigiu na leitura das conversas: vai em toda extração. */
  leituras: { id: number; texto: string }[];
  gerado: string;
}

export async function lerPerfil(db: Db): Promise<Perfil> {
  const r = await db.query<{ id: number; tipo: string; texto: string }>(
    "SELECT id, tipo, texto FROM perfil WHERE ativo ORDER BY id",
  );
  return {
    regras: r.rows.filter((x) => x.tipo === "regra"),
    licoes: r.rows.filter((x) => x.tipo === "licao").slice(-40),
    leituras: r.rows.filter((x) => x.tipo === "leitura").slice(-30),
    gerado: r.rows.filter((x) => x.tipo === "gerado").at(-1)?.texto ?? "",
  };
}

/** Acrescenta regra ou lição, sem repetir texto igual. */
export async function acrescentarPerfil(db: Db, tipo: "regra" | "licao" | "leitura", texto: string): Promise<number | null> {
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

/** As lições de leitura em texto, para a extração. Vazio quando não há. */
export async function licoesDeLeitura(db: Db): Promise<string> {
  const r = await db.query<{ texto: string }>("SELECT texto FROM perfil WHERE ativo AND tipo = 'leitura' ORDER BY id DESC LIMIT 30");
  return r.rows.map((x) => `- ${x.texto}`).join("\n");
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
    c.sistema ? "É um sistema automático (notificações), não uma pessoa." : "",
    c.situacao ? `Onde a conversa está: ${c.situacao}` : "",
    c.aguardando ? `O dono está esperando dela: ${c.aguardando}` : "",
    c.memoria ? `Fatos:\n${c.memoria}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export interface FichaExportada {
  jid: string;
  nome: string;
  grupo: boolean;
  relacao: string | null;
  quem_e: string;
  tom: string;
  assuntos_abertos: string;
  situacao: string;
  espera_resposta: boolean;
  aguardando: string;
  aguardando_desde: Date | null;
  fatos: string;
  mensagens: number;
  primeira_em: Date | null;
  ultima_em: Date | null;
  compromissos: { id: number; descricao: string; quando: Date | null; responsavel: string; status: string; criado_em: Date }[];
  datas: { descricao: string; dia: number; mes: number }[];
}

/**
 * Tudo o que o assistente sabe de cada conversa, num pacote: as anotações do Claude Code
 * no PC do dono são geradas daqui por script, sem modelo. Compromissos abertos sempre;
 * os fechados, só dos últimos `dias`. Fora e sistema não entram; grupo sem leitura e
 * sem compromisso também não, que não teria o que anotar.
 */
export async function exportarFichas(db: Db, dias = 120): Promise<FichaExportada[]> {
  const r = await db.query<Omit<FichaExportada, "compromissos" | "datas">>(
    `SELECT c.jid, ${NOME_SQL} AS nome, c.grupo, c.relacao, c.resumo AS quem_e, c.tom, c.assuntos_abertos, c.situacao,
            c.espera_resposta, c.aguardando, c.aguardando_desde, c.memoria AS fatos,
            u.mensagens, u.primeira_em, u.ultima_em
     FROM contatos c
     JOIN LATERAL (SELECT count(*)::int AS mensagens, min(enviada_em) AS primeira_em, max(enviada_em) AS ultima_em
                   FROM mensagens WHERE chat_jid = c.jid) u ON TRUE
     WHERE NOT c.excluido AND NOT c.sistema
       AND (u.mensagens > 0 OR c.resumo <> '' OR EXISTS (SELECT 1 FROM compromissos k WHERE k.chat_jid = c.jid))
     ORDER BY u.ultima_em DESC NULLS LAST`,
  );
  const ks = await db.query<FichaExportada["compromissos"][number] & { chat_jid: string }>(
    `SELECT id, chat_jid, descricao, quando, responsavel, status, criado_em FROM compromissos
     WHERE status IN ('sugerido', 'confirmado') OR criado_em > now() - make_interval(days => $1)
     ORDER BY COALESCE(quando, criado_em)`,
    [dias],
  );
  const ds = await db.query<{ chat_jid: string; descricao: string; dia: number; mes: number }>("SELECT chat_jid, descricao, dia, mes FROM datas ORDER BY mes, dia");
  const porJid = <T extends { chat_jid: string }>(linhas: T[]) => {
    const m = new Map<string, Omit<T, "chat_jid">[]>();
    for (const { chat_jid, ...resto } of linhas) m.set(chat_jid, [...(m.get(chat_jid) ?? []), resto]);
    return m;
  };
  const kPor = porJid(ks.rows);
  const dPor = porJid(ds.rows);
  return r.rows
    .map((c) => ({ ...c, compromissos: kPor.get(c.jid) ?? [], datas: dPor.get(c.jid) ?? [] }))
    .filter((c) => !c.grupo || c.situacao || c.quem_e || c.compromissos.length);
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
    `SELECT d.chat_jid AS jid, ${NOME_SQL} AS nome, d.descricao, d.mes, d.dia
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
    `SELECT r.chat_jid AS jid, ${NOME_SQL} AS nome, c.autonomia,
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

/**
 * Conversas com mensagem depois de `desde`, da mais recente para a mais antiga, com a
 * situação de cada uma: é o "o que rolou na semana" do MCP, sem chamar modelo.
 */
export async function conversasRecentes(
  db: Db,
  desde: Date,
  limite = 40,
): Promise<{ jid: string; nome: string; grupo: boolean; situacao: string; espera_resposta: boolean; quantas: number; ultima_em: Date }[]> {
  const r = await db.query(
    `SELECT c.jid, ${NOME_SQL} AS nome, c.grupo, c.situacao, c.espera_resposta, u.quantas, u.ultima_em
     FROM contatos c
     JOIN LATERAL (SELECT count(*)::int AS quantas, max(enviada_em) AS ultima_em FROM mensagens
                   WHERE chat_jid = c.jid AND enviada_em > $1) u ON u.quantas > 0
     WHERE NOT c.excluido AND NOT c.sistema
     ORDER BY u.ultima_em DESC LIMIT $2`,
    [desde, limite],
  );
  return r.rows;
}

/** As primeiras `limite` mensagens de uma conversa depois de `desde`, em ordem: ler só o que é novo. */
export async function mensagensDesde(db: Db, chatJid: string, desde: Date, limite: number): Promise<Mensagem[]> {
  const r = await db.query<Mensagem>(
    `SELECT id, chat_jid, remetente_nome, de_mim, tipo, texto, enviada_em FROM mensagens
     WHERE chat_jid = $1 AND enviada_em > $2 ORDER BY enviada_em LIMIT $3`,
    [chatJid, desde, limite],
  );
  return r.rows;
}

/** As `limite` mensagens de uma conversa anteriores a `ate`, em ordem: ler o passado aos pedaços. */
export async function mensagensAte(db: Db, chatJid: string, ate: Date, limite: number): Promise<Mensagem[]> {
  const r = await db.query<Mensagem>(
    `SELECT id, chat_jid, remetente_nome, de_mim, tipo, texto, enviada_em FROM mensagens
     WHERE chat_jid = $1 AND enviada_em < $2 ORDER BY enviada_em DESC LIMIT $3`,
    [chatJid, ate, limite],
  );
  return r.rows.reverse();
}

/** Tudo que o dono espera dos contatos, cobrado ou não (o `paraCobrar` só traz o que falta cobrar). */
export async function aguardandoDeles(db: Db): Promise<(Contato & { aguardando_desde: Date | null })[]> {
  const r = await db.query<Contato & { aguardando_desde: Date | null }>(
    `SELECT ${COLUNAS_CONTATO}, aguardando_desde FROM contatos
     WHERE NOT excluido AND aguardando <> '' ORDER BY aguardando_desde NULLS LAST`,
  );
  return r.rows;
}
