import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type pg from 'pg';

const migrationsDir = fileURLToPath(new URL('./migrations/', import.meta.url));

/** Applique les migrations SQL non encore jouees, dans l'ordre lexicographique. */
export async function runMigrations(db: pg.Pool | pg.PoolClient, log = console.log): Promise<string[]> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applique_le TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  const fichiers = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await db.query<{ version: string }>('SELECT version FROM schema_migrations');
  const deja = new Set(rows.map((r) => r.version));
  const appliquees: string[] = [];
  for (const fichier of fichiers) {
    if (deja.has(fichier)) continue;
    const sql = await readFile(path.join(migrationsDir, fichier), 'utf8');
    await db.query('BEGIN');
    try {
      await db.query(sql);
      await db.query('INSERT INTO schema_migrations (version) VALUES ($1)', [fichier]);
      await db.query('COMMIT');
      appliquees.push(fichier);
      log(`[migration] applique ${fichier}`);
    } catch (err) {
      await db.query('ROLLBACK');
      throw new Error(`Migration ${fichier} echouee: ${(err as Error).message}`);
    }
  }
  return appliquees;
}
