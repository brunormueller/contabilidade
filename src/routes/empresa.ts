import { and, count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import { certificados, empresa, notas } from "../db/schema.js";
import { pctParaInt } from "../domain/dinheiro.js";
import { normDoc, soDigitos, validCNPJ } from "../domain/documentos.js";
import { carregarEmpresa, definirProxDps, empresaParaApi, maiorDpsUsado, SERIE_DPS } from "../domain/empresa.js";
import { ALIQ_ISS_MAX, ALIQ_ISS_MIN } from "../domain/planilha.js";
import { env } from "../env.js";
import { auditar } from "../lib/auditoria.js";
import { invalido } from "../lib/erros.js";
import { corpo } from "../lib/http.js";
import type { AppEnv } from "../tipos.js";

export const rotaEmpresa = new Hono<AppEnv>();

rotaEmpresa.get("/", async (c) => {
  return c.json(await empresaParaApi(await db(), c.get("user").empresaId, env().NFSE_AMBIENTE));
});

const Cfg = z.object({
  razao: z.string().trim().max(150),
  cnpj: z.string().max(20),
  im: z.string().trim().max(30).default(""),
  cServPadrao: z.string().max(20).default(""),
  cNBSPadrao: z.string().max(20).default(""),
  aliqIss: z.number().nullable().default(null),
  vencDias: z.number().int().min(0).max(365),
  serie: z.string().trim().max(5),
  proxDPS: z.number().int().min(1).max(999_999_999_999_999),
  // configuração fiscal: ausente = mantém o que está gravado
  pTotTribSN: z.number().gt(0, "pTotTribSN deve ser maior que 0%.").lt(100, "pTotTribSN deve ser menor que 100%.").nullable().optional(),
  cLocPrestacao: z.string().regex(/^(\d{7})?$/, "Município de prestação deve ter o código IBGE de 7 dígitos.").optional(),
  ibsCbs: z
    .object({
      cst: z.string().regex(/^\d{3}$/, "CST do IBS/CBS tem 3 dígitos."),
      cClassTrib: z.string().regex(/^\d{6}$/, "cClassTrib tem 6 dígitos."),
      cIndOp: z.string().regex(/^\d{6}$/, "cIndOp tem 6 dígitos.").optional(),
      indDest: z.enum(["0", "1"], { message: "indDest deve ser 0 ou 1." }),
      indFinal: z.enum(["0", "1"], { message: "indFinal deve ser 0 ou 1." }).optional(),
    })
    .nullable()
    .optional(),
});

rotaEmpresa.put("/", async (c) => {
  const b = await corpo(c, Cfg);
  const cnpj = normDoc(b.cnpj);
  if (!validCNPJ(cnpj)) throw invalido("CNPJ inválido.");
  const cServ = soDigitos(b.cServPadrao);
  if (cServ && cServ.length !== 6) throw invalido("O código de serviço precisa ter 6 dígitos.");
  const nbs = soDigitos(b.cNBSPadrao);
  if (nbs && nbs.length !== 9) throw invalido("O código NBS precisa ter 9 dígitos.");
  if (b.aliqIss != null && !(b.aliqIss >= ALIQ_ISS_MIN && b.aliqIss <= ALIQ_ISS_MAX))
    throw invalido("A alíquota do ISS retido deve ficar entre 1,8% e 5%.");
  if (!SERIE_DPS.test(b.serie)) throw invalido("Série da DPS inválida: use até 5 dígitos, de 0 a 89999.");

  const { empresaId } = c.get("user");
  const amb = env().NFSE_AMBIENTE;
  const d = await db();
  const r = await d.transaction(async (tx) => {
    const atual = await carregarEmpresa(tx, empresaId);
    let certDesativado = false;
    if (cnpj !== atual.cnpj) {
      const [n] = await tx.select({ n: count() }).from(notas).where(eq(notas.empresaId, empresaId));
      if (n!.n > 0) throw invalido("O CNPJ não pode mudar depois que há notas emitidas.");
      const des = await tx
        .update(certificados)
        .set({ ativo: false })
        .where(and(eq(certificados.empresaId, empresaId), eq(certificados.ativo, true)))
        .returning({ id: certificados.id });
      certDesativado = des.length > 0;
    }
    const usado = await maiorDpsUsado(tx, empresaId, amb, b.serie);
    if (b.proxDPS <= usado) throw invalido(`O próximo nº da DPS precisa ser maior que ${usado}, o último já usado nesta série.`);

    await tx
      .update(empresa)
      .set({
        razao: b.razao || "Sua empresa",
        cnpj,
        im: b.im,
        cTribNacPadrao: cServ,
        cNbsPadrao: nbs,
        aliqIssPadrao: b.aliqIss != null ? pctParaInt(b.aliqIss) : null,
        vencDias: b.vencDias,
        serieDps: b.serie,
        ...(b.pTotTribSN !== undefined && { pTotTribSn: b.pTotTribSN == null ? null : pctParaInt(b.pTotTribSN) }),
        ...(b.cLocPrestacao !== undefined && { cLocPrestacao: b.cLocPrestacao === atual.ibge ? "" : b.cLocPrestacao }),
        ...(b.ibsCbs !== undefined && { ibsCbs: b.ibsCbs }),
        atualizadoEm: new Date(),
      })
      .where(eq(empresa.id, empresaId));
    await definirProxDps(tx, empresaId, amb, b.serie, b.proxDPS);
    await auditar(tx, c, "salvar_empresa", "empresa", empresaId, { ...b, certDesativado });
    return { certDesativado };
  });
  return c.json({ ...(await empresaParaApi(d, empresaId, amb)), ...r });
});
