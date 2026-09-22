import { transaction, closePool } from './pool.js';
import { amorcer } from './amorcage.js';

await transaction((client) =>
  amorcer(
    client,
    {
      adminEmail: process.env.ADMIN_EMAIL,
      adminMotDePasse: process.env.ADMIN_MOT_DE_PASSE,
      adminNom: process.env.ADMIN_NOM,
    },
    console.log,
  ),
);
console.log('Amorcage termine.');
await closePool();
