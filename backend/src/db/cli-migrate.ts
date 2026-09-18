import { pool, closePool } from './pool.js';
import { runMigrations } from './migrate.js';

const appliquees = await runMigrations(pool);
console.log(appliquees.length ? `${appliquees.length} migration(s) appliquee(s).` : 'Schema deja a jour.');
await closePool();
