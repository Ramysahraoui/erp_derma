import { transaction, closePool } from './pool.js';
import { semer } from './seed.js';

await transaction((client) => semer(client));
await closePool();
