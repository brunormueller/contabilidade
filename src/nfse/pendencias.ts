import type { Ambiente } from "../env.js";
import { exigeIbsCbs } from "./ambiente.js";

/** O que falta configurar para emitir. A tela mostra, e o envio recusa enquanto houver algo. */
export function pendenciasFiscais(e: { pTotTribSn: number | null; ibsCbs: unknown }, ambiente: Ambiente, competencia: string, temCert: boolean) {
  const p: string[] = [];
  if (!temCert) p.push("Envie o certificado A1 da empresa.");
  if (e.pTotTribSn == null) p.push("Informe o percentual aproximado de tributos do Simples Nacional (pTotTribSN).");
  if (e.ibsCbs == null && exigeIbsCbs(ambiente, competencia))
    p.push("Informe a classificação de IBS/CBS (CST, cClassTrib e indDest). Neste ambiente ela é obrigatória para competência a partir de 01/10/2026.");
  return p;
}
