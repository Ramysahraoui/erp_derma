import { transaction, closePool } from './pool.js';
import { semerDemonstration } from './donnees-demo.js';

console.log('Injection du jeu de DEMONSTRATION (donnees fictives) — a reserver a la formation et a la recette.\n');
await transaction((client) => semerDemonstration(client));
await closePool();
