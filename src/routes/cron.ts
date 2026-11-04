import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { db } from "../db/client.js";
import { env } from "../env.js";
import { HttpError, naoAutenticado } from "../lib/erros.js";
import { processarFila } from "../nfse/fila.js";
import type { AppEnv } from "../tipos.js";

// Rede de segurança da fila: pega o que ficou para trás quando ninguém está com a tela aberta
// (notas em "verificar" esperando nova consulta, função que caiu no meio). A Vercel Cron chama
// com GET e "Authorization: Bearer <CRON_SECRET>".
export const rotaCron = new Hono<AppEnv>();

const resumo = (s: string) => createHash("sha256").update(s).digest();

rotaCron.get("/processar", async (c) => {
  const segredo = env().CRON_SECRET;
  if (!segredo) throw new HttpError(503, "CRON_SECRET não configurado.");
  const enviado = c.req.header("authorization") ?? "";
  if (!timingSafeEqual(resumo(enviado), resumo(`Bearer ${segredo}`))) throw naoAutenticado();
  return c.json(await processarFila(await db(), { ambiente: env().NFSE_AMBIENTE }));
});
