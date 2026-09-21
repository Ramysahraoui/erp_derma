import { construireApp } from './app.js';
import { env } from './env.js';
import { pool, closePool, transaction } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { amorcer } from './db/amorcage.js';

const app = await construireApp();

// Une installation neuve est operationnelle des le premier demarrage :
// application du schema puis amorcage idempotent (parametres, plan analytique,
// compte administrateur). Aucune donnee fictive n'est injectee.
if (process.env.MIGRATE_ON_BOOT !== 'false') {
  const appliquees = await runMigrations(pool, (m) => app.log.info(m));
  if (appliquees.length) app.log.info(`${appliquees.length} migration(s) appliquee(s).`);
}

if (process.env.AMORCAGE_AUTO !== 'false') {
  await transaction((client) =>
    amorcer(
      client,
      {
        adminEmail: process.env.ADMIN_EMAIL,
        adminMotDePasse: process.env.ADMIN_MOT_DE_PASSE,
        adminNom: process.env.ADMIN_NOM,
      },
      // Sortie directe : le mot de passe initial doit rester lisible dans les
      // journaux d'installation (`docker compose logs api`).
      (message) => console.log(message),
    ),
  );
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
