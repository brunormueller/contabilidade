// Servidor local: API em /api e o front estático de public/. Lê o .env, se existir.
import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

if (existsSync(".env")) process.loadEnvFile(".env");

const { app } = await import("../src/app.js");

// Só aqui, nunca no deploy: SEFIN_SIMULADA=1 troca a Sefin pelo simulador dos testes, para
// experimentar a tela de lote antes do cliente real (etapa 11).
if (process.env.SEFIN_SIMULADA === "1") {
  const { instalarSefinFake } = await import("../test/sefinFake.js");
  instalarSefinFake();
  console.log("Sefin SIMULADA: nada é enviado à Receita.");
}

const dev = new Hono();
dev.route("/", app);
dev.use("/*", serveStatic({ root: "./public" }));

const port = Number(process.env.PORT) || 3000;
serve({ fetch: dev.fetch, port }, () => console.log(`http://localhost:${port}`));
