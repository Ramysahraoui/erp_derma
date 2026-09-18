import type { Db } from '../db/pool.js';

/** Journalise une action sensible (audit trail BPF / ISO 22716). */
export async function tracer(
  db: Db,
  utilisateurId: number | null,
  action: string,
  entite: string,
  entiteId: string | number | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (utilisateur_id, action, entite, entite_id, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [utilisateurId, action, entite, entiteId === null ? null : String(entiteId), JSON.stringify(details)],
  );
}
