import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { db } from "../db/client.js";
import { env } from "../env.js";
import { HttpError, naoAutenticado } from "../lib/erros.js";
import { processarEnvios } from "../domain/envios.js";
import { faturarDoDia } from "../domain/faturamento.js";
import { hojeBR } from "../lib/datas.js";
import { processarFila } from "../nfse/fila.js";
import type { AppEnv } from "../tipos.js";

// Uma vez por dia: cria as notas do faturamento mensal de quem chegou no dia de emissão, anda a
// fila (inclusive o que ficou para trás: notas em "verificar", função que caiu no meio) e manda
// os e-mails das notas autorizadas. A Vercel Cron chama com GET e "Authorization: Bearer <CRON_SECRET>".
export const rotaCron = new Hono<AppEnv>();

const resumo = (s: string) => createHash("sha256").update(s).digest();

rotaCron.get("/processar", async (c) => {
  const segredo = env().CRON_SECRET;
  if (!segredo) throw new HttpError(503, "CRON_SECRET não configurado.");
  const enviado = c.req.header("authorization") ?? "";
  if (!timingSafeEqual(resumo(enviado), resumo(`Bearer ${segredo}`))) throw naoAutenticado();
  const d = await db();
  const amb = env().NFSE_AMBIENTE;
  const faturamento = await faturarDoDia(d, amb, hojeBR());
  const fila = await processarFila(d, { ambiente: amb });
  const emails = await processarEnvios(d, {}, { orcamentoMs: 12_000 });
  return c.json({ ...fila, faturamento, emails });
});
