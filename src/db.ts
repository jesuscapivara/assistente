import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export type Db = pg.Pool;

export function abrirDb(url: string): Db {
  return new pg.Pool({ connectionString: url, max: 5 });
}

const pastaMigracoes = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * Aplica os `.sql` de `migrations/` em ordem, uma vez cada. Sem ferramenta de
 * migração: são poucos arquivos e todos idempotentes.
 */
export async function migrar(db: Db): Promise<string[]> {
  await db.query(
    "CREATE TABLE IF NOT EXISTS migracoes (nome TEXT PRIMARY KEY, aplicada_em TIMESTAMPTZ NOT NULL DEFAULT now())",
  );
  const feitas = new Set((await db.query<{ nome: string }>("SELECT nome FROM migracoes")).rows.map((r) => r.nome));
  const arquivos = (await readdir(pastaMigracoes)).filter((f) => f.endsWith(".sql")).sort();
  const aplicadas: string[] = [];
  for (const nome of arquivos) {
    if (feitas.has(nome)) continue;
    const sql = await readFile(path.join(pastaMigracoes, nome), "utf8");
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      await c.query(sql);
      await c.query("INSERT INTO migracoes (nome) VALUES ($1)", [nome]);
      await c.query("COMMIT");
      aplicadas.push(nome);
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    } finally {
      c.release();
    }
  }
  return aplicadas;
}

export async function lerEstado(db: Db, chave: string): Promise<string | null> {
  const r = await db.query<{ valor: string }>("SELECT valor FROM estado WHERE chave = $1", [chave]);
  return r.rows[0]?.valor ?? null;
}

export async function gravarEstado(db: Db, chave: string, valor: string): Promise<void> {
  await db.query(
    "INSERT INTO estado (chave, valor) VALUES ($1, $2) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor",
    [chave, valor],
  );
}
