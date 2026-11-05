import knex from 'knex';
export const db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 10 } });
