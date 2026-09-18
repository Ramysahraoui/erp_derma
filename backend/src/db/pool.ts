import pg from 'pg';
import { env } from '../env.js';

// Les colonnes NUMERIC sont renvoyees en chaine par node-postgres : c'est
// volontaire (aucune perte de precision). Les conversions passent par decimal.js.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
});

export type Db = pg.Pool | pg.PoolClient;

export async function query<T extends pg.QueryResultRow = any>(
  db: Db,
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const res = await db.query<T>(text, params as unknown[]);
  return res.rows;
}

export async function queryOne<T extends pg.QueryResultRow = any>(
  db: Db,
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(db, text, params);
  return rows[0] ?? null;
}

/** Execute un bloc dans une transaction ACID (rollback automatique sur erreur). */
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connexion deja perdue */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
