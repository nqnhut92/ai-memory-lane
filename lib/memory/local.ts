import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { createMemoryStore, type MemoryStore } from "./store.js";

/**
 * A memory store on an embedded PostgreSQL (PGlite with pg_trgm), the same SQL as production with no network.
 * Pass a directory to keep the data there between runs; without one it lives in memory and ends with the process.
 */
export function pgliteMemoryStore(dataDir?: string): { store: MemoryStore; db: PGlite } {
  const db = new PGlite({ ...(dataDir ? { dataDir } : {}), extensions: { pg_trgm } });
  const store = createMemoryStore({
    query: async (text, params = []) => (await db.query<Record<string, any>>(text, params)).rows,
    transaction: async (statements) => { await db.transaction(async (tx) => { for (const text of statements) await tx.query(text); }); },
  });
  return { store, db };
}
