// Aplica as migrations de drizzle/ no banco. Usa a URL direta (sem pooler) se existir.
// Rode à mão antes de publicar uma versão que muda o schema: npm run db:migrate
import { existsSync } from "node:fs";
import { conectar, migrar } from "../src/db/client.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) throw new Error("Defina DATABASE_URL ou DATABASE_URL_UNPOOLED.");

const d = await conectar(url);
await migrar(d);
console.log("Migrations aplicadas.");
process.exit(0);
