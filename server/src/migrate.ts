import { db } from './db.js';
const [, done] = await db.migrate.latest({ directory: new URL('./migrations', import.meta.url).pathname, loadExtensions: ['.ts'] });
console.log('migrated', done);
await db.destroy();
