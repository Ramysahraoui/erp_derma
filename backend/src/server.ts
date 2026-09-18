import { construireApp } from './app.js';
import { env } from './env.js';
import { pool, closePool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';

const app = await construireApp();

if (process.env.MIGRATE_ON_BOOT !== 'false') {
  await runMigrations(pool, (m) => app.log.info(m));
}

await app.listen({ port: env.port, host: env.host });
app.log.info(`ERP dermo-cosmetique demarre sur http://${env.host}:${env.port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    await closePool();
    process.exit(0);
  });
}
