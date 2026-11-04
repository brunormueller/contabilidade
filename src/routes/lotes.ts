import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import type { empresa } from "../db/schema.js";
import { intParaPct } from "../domain/dinheiro.js";
import { carregarEmpresa } from "../domain/empresa.js";
import { LIMITE_LINHAS, type Padroes, validarLinhas } from "../domain/planilha.js";
import { env } from "../env.js";
import { exigeIbsCbs } from "../nfse/ambiente.js";
import { hojeBR } from "../lib/datas.js";
import { corpo } from "../lib/http.js";
import type { AppEnv } from "../tipos.js";

export const rotaLotes = new Hono<AppEnv>();

export const padroesDaEmpresa = (e: typeof empresa.$inferSelect): Padroes => ({
  cServPadrao: e.cTribNacPadrao,
  cNBSPadrao: e.cNbsPadrao,
  aliqIss: intParaPct(e.aliqIssPadrao),
  vencDias: e.vencDias,
  cnpjEmpresa: e.cnpj,
  levaIbsCbs: (comp) => e.ibsCbs != null || exigeIbsCbs(env().NFSE_AMBIENTE, comp),
});

const Linhas = z.object({
  linhas: z
    .array(z.record(z.string(), z.union([z.string().max(5000), z.number(), z.boolean(), z.null()])))
    .max(LIMITE_LINHAS, `A planilha pode ter até ${LIMITE_LINHAS} linhas por lote.`),
});

/** Confere as linhas sem gravar nada: é a tela "Conferir lote". */
rotaLotes.post("/validar", async (c) => {
  const { linhas } = await corpo(c, Linhas);
  const e = await carregarEmpresa(await db(), c.get("user").empresaId);
  return c.json(validarLinhas(linhas, padroesDaEmpresa(e), hojeBR()));
});
