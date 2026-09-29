import pg from "pg";

const globalForDb = globalThis as typeof globalThis & { pool?: pg.Pool };

export function db(): pg.Pool {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  return (globalForDb.pool ??= new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 5000,
  }));
}
