import { and, eq, max, sql } from "drizzle-orm";
import type { DB, Tx } from "../db/client.js";
import { certificados, dpsSequencia, empresa, notas } from "../db/schema.js";
import type { Ambiente } from "../env.js";
import { hojeBR } from "../lib/datas.js";
import { naoEncontrado } from "../lib/erros.js";
import { pendenciasFiscais } from "../nfse/pendencias.js";
import { intParaPct } from "./dinheiro.js";

// Série da DPS no XSD (TSSerieDPS): 1 a 4 dígitos ou 5 dígitos começando de 0 a 8.
export const SERIE_DPS = /^([0-9]{1,4}|[0-8][0-9]{4})$/;

export async function carregarEmpresa(d: DB | Tx, empresaId: string) {
  const [e] = await d.select().from(empresa).where(eq(empresa.id, empresaId));
  if (!e) throw naoEncontrado("Empresa");
  return e;
}

/** Próximo número de DPS que será reservado, sem reservar. */
export async function proxDps(d: DB | Tx, empresaId: string, ambiente: Ambiente, serie: string) {
  const [s] = await d
    .select({ prox: dpsSequencia.proxNdps })
    .from(dpsSequencia)
    .where(and(eq(dpsSequencia.empresaId, empresaId), eq(dpsSequencia.ambiente, ambiente), eq(dpsSequencia.serie, serie)));
  return s?.prox ?? 1;
}

/** Maior nDPS já usado na série, para não deixar o contador voltar para trás. */
export async function maiorDpsUsado(d: DB | Tx, empresaId: string, ambiente: Ambiente, serie: string) {
  const [r] = await d
    .select({ m: max(notas.nDps) })
    .from(notas)
    .where(and(eq(notas.empresaId, empresaId), eq(notas.ambiente, ambiente), eq(notas.serie, serie)));
  return Number(r?.m ?? 0);
}

export async function definirProxDps(d: DB | Tx, empresaId: string, ambiente: Ambiente, serie: string, prox: number) {
  await d
    .insert(dpsSequencia)
    .values({ empresaId, ambiente, serie, proxNdps: prox })
    .onConflictDoUpdate({ target: [dpsSequencia.empresaId, dpsSequencia.ambiente, dpsSequencia.serie], set: { proxNdps: prox } });
}

/** Reserva n números seguidos de DPS de forma atômica. Devolve o primeiro. */
export async function reservarDps(tx: Tx, empresaId: string, ambiente: Ambiente, serie: string, n: number) {
  const [r] = await tx
    .insert(dpsSequencia)
    .values({ empresaId, ambiente, serie, proxNdps: 1 + n })
    .onConflictDoUpdate({
      target: [dpsSequencia.empresaId, dpsSequencia.ambiente, dpsSequencia.serie],
      set: { proxNdps: sql`${dpsSequencia.proxNdps} + ${n}` },
    })
    .returning({ prox: dpsSequencia.proxNdps });
  return r!.prox - n;
}

/** Metadados do certificado ativo. Nunca seleciona o PFX nem a senha. */
export async function resumoCertificado(d: DB | Tx, empresaId: string) {
  const [c] = await d
    .select({
      id: certificados.id,
      titular: certificados.titular,
      cnpj: certificados.cnpj,
      emissor: certificados.emissor,
      serial: certificados.serial,
      validoDe: certificados.validoDe,
      validoAte: certificados.validoAte,
      verificadoEm: certificados.criadoEm,
    })
    .from(certificados)
    .where(and(eq(certificados.empresaId, empresaId), eq(certificados.ativo, true)));
  return c ?? null;
}

export async function empresaParaApi(d: DB | Tx, empresaId: string, ambiente: Ambiente) {
  const e = await carregarEmpresa(d, empresaId);
  const cert = await resumoCertificado(d, empresaId);
  return {
    razao: e.razao,
    cnpj: e.cnpj,
    im: e.im,
    ibge: e.ibge,
    serie: e.serieDps,
    proxDPS: await proxDps(d, empresaId, ambiente, e.serieDps),
    vencDias: e.vencDias,
    cServPadrao: e.cTribNacPadrao,
    cNBSPadrao: e.cNbsPadrao,
    aliqIss: intParaPct(e.aliqIssPadrao),
    pTotTribSN: intParaPct(e.pTotTribSn),
    cLocPrestacao: e.cLocPrestacao || e.ibge,
    ibsCbs: e.ibsCbs ?? null,
    cert,
    ambiente,
    pendencias: pendenciasFiscais(e, ambiente, hojeBR(), cert != null),
  };
}
