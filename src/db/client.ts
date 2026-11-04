import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { env } from "../env.js";
import * as schema from "./schema.js";

// Postgres real (Neon) via node-postgres; "pglite:memory" ou "pglite:<pasta>" para teste e dev local.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DB = PgDatabase<any, typeof schema>;
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));
const pglites = new WeakSet<DB>();

let atual: Promise<DB> | null = null;

export function db(): Promise<DB> {
  atual ??= conectar(env().DATABASE_URL);
  return atual;
}

/** Testes trocam o banco por um PGlite novo. */
export function usarDb(novo: DB) {
  atual = Promise.resolve(novo);
}

export async function conectar(url: string): Promise<DB> {
  if (url.startsWith("pglite:")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const alvo = url.slice("pglite:".length);
    if (alvo !== "memory") mkdirSync(dirname(alvo), { recursive: true });
    const d = drizzle({ client: alvo === "memory" ? new PGlite() : new PGlite(alvo), schema, casing: "snake_case" });
    pglites.add(d);
    return d;
  }
  const { Pool } = (await import("pg")).default;
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const pool = new Pool({ connectionString: url, max: 3, idleTimeoutMillis: 5_000 });
  return drizzle({ client: pool, schema, casing: "snake_case" });
}

export async function migrar(alvo: DB) {
  const { migrate } = pglites.has(alvo)
    ? await import("drizzle-orm/pglite/migrator")
    : await import("drizzle-orm/node-postgres/migrator");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await migrate(alvo as any, { migrationsFolder: MIGRATIONS });
}
