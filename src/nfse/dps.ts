// Monta a DPS (Declaração de Prestação de Serviço) no leiaute nacional, sem assinatura.
// Cada escolha abaixo vem do XSD (xsd/) ou de uma regra do Anexo I citada pelo código.
import type { Ambiente } from "../env.js";
import { LAYOUTS, exigeIbsCbs } from "./ambiente.js";

export const NS = "http://www.sped.fazenda.gov.br/nfse";
export const VERSAO = "1.01";
export const VER_APLIC = "nfse-lote-1.0";

export type IbsCbs = { cst: string; cClassTrib: string; cIndOp?: string; indDest: "0" | "1"; indFinal?: "0" | "1" };

export type EmpresaDps = {
  cnpj: string;
  im: string;
  ibge: string;
  cLocPrestacao: string; // vazio = município da empresa
  pTotTribSN: number | null; // centésimos de %, como no banco (6,00% = 600)
  ibsCbs: IbsCbs | null;
};

export type NotaDps = {
  serie: string;
  nDps: number;
  competencia: string;
  tomadorDoc: string;
  tomadorNome: string;
  tomadorEmail: string;
  descricao: string;
  cTribNac: string;
  cNbs: string;
  valor: number; // centavos
  issRetido: boolean;
  aliqIss: number | null; // centésimos de %
  vInssRet: number; // centavos
};

/** "DPS" + município (7) + tipo de inscrição (2 = CNPJ) + CNPJ (14) + série (5) + número (15). TSIdDPS. */
export const idDps = (ibge: string, cnpj: string, serie: string, nDps: number) =>
  `DPS${ibge}2${cnpj}${serie.padStart(5, "0")}${String(nDps).padStart(15, "0")}`;

/** TSDateTimeUTC: AAAA-MM-DDThh:mm:ss±hh:mm, no horário de Brasília e sem milissegundos. */
export function dhBrasilia(d: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23", timeZoneName: "longOffset",
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  const off = String(p.timeZoneName).replace("GMT", "") || "+00:00";
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`;
}

const esc = (s: string) =>
  s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

type Filho = string | false | null | undefined;
/** Elemento com texto (escapado). Sem texto, o elemento some. */
const t = (nome: string, v: string | number | null | undefined) => (v === null || v === undefined || v === "" ? "" : `<${nome}>${esc(String(v))}</${nome}>`);
/** Elemento com filhos já montados. Sem filhos, some. */
const g = (nome: string, ...f: Filho[]) => {
  const c = f.filter(Boolean).join("");
  return c ? `<${nome}>${c}</${nome}>` : "";
};
const dec2 = (centavos: number) => (centavos / 100).toFixed(2);

export class ConfigIncompleta extends Error {}

export function montarDps(a: { empresa: EmpresaDps; nota: NotaDps; ambiente: Ambiente; dhEmi: Date }) {
  const { empresa: e, nota: n, ambiente } = a;
  const lay = LAYOUTS[ambiente];
  // E0712: ME/EPP não pode usar indTotTrib; fica pTotTribSN
  if (e.pTotTribSN == null) throw new ConfigIncompleta("Configure o percentual aproximado de tributos do Simples Nacional (pTotTribSN).");
  const comIbsCbs = e.ibsCbs != null;
  if (!comIbsCbs && exigeIbsCbs(ambiente, n.competencia))
    throw new ConfigIncompleta("Configure a classificação de IBS/CBS: obrigatória neste ambiente para competência a partir de 01/10/2026 (E0855).");
  if (comIbsCbs && !n.cNbs) throw new ConfigIncompleta("Informe o código NBS: obrigatório quando a nota leva IBS/CBS.");
  if (comIbsCbs && lay.cIndOpObrigatorio && !e.ibsCbs!.cIndOp) throw new ConfigIncompleta("Configure o cIndOp do IBS/CBS: obrigatório no leiaute deste ambiente.");
  if (n.issRetido && n.aliqIss == null) throw new ConfigIncompleta("ISS retido sem alíquota.");

  const id = idDps(e.ibge, e.cnpj, n.serie, n.nDps);
  const tomaDoc = n.tomadorDoc.length === 11 ? t("CPF", n.tomadorDoc) : t("CNPJ", n.tomadorDoc);

  const cServ = g(
    "cServ",
    t("cTribNac", n.cTribNac),
    lay.descAntesDoNbs && t("xDescServ", n.descricao),
    t("cNBS", n.cNbs),
    !lay.descAntesDoNbs && t("xDescServ", n.descricao),
  );

  const ibs = e.ibsCbs;
  const xml =
    `<DPS xmlns="${NS}" versao="${VERSAO}">` +
    `<infDPS Id="${id}">` +
    t("tpAmb", lay.tpAmb) +
    t("dhEmi", dhBrasilia(a.dhEmi)) +
    t("verAplic", VER_APLIC) +
    t("serie", n.serie) +
    t("nDPS", n.nDps) +
    t("dCompet", n.competencia) +
    t("tpEmit", "1") + // emitente = prestador
    (lay.finNFSe === "infDPS" ? t("finNFSe", "0") : "") + // NFS-e regular
    t("cLocEmi", e.ibge) +
    // E0121/E0128: com tpEmit = 1 o prestador não leva nome nem endereço
    g(
      "prest",
      t("CNPJ", e.cnpj),
      t("IM", e.im),
      // ME/EPP apurando pelo SN; E0175: regEspTrib = 0 nesse caso
      g("regTrib", t("opSimpNac", "3"), t("regApTribSN", "1"), t("regEspTrib", "0")),
    ) +
    g("toma", tomaDoc, t("xNome", n.tomadorNome), t("email", n.tomadorEmail)) +
    g("serv", g("locPrest", t("cLocPrestacao", e.cLocPrestacao || e.ibge)), cServ) +
    g(
      "valores",
      g("vServPrest", t("vServ", dec2(n.valor))),
      g(
        "trib",
        // E0621/E0625: pAliq só quando o ISS é retido pelo tomador (tpRetISSQN = 2)
        g("tribMun", t("tribISSQN", "1"), t("tpRetISSQN", n.issRetido ? "2" : "1"), n.issRetido && t("pAliq", dec2(n.aliqIss!))),
        n.vInssRet > 0 && g("tribFed", t("vRetCP", dec2(n.vInssRet))),
        g("totTrib", t("pTotTribSN", dec2(e.pTotTribSN))),
      ),
    ) +
    (ibs
      ? g(
          "IBSCBS",
          lay.finNFSe === "IBSCBS" && t("finNFSe", "0"),
          t("indFinal", ibs.indFinal),
          t("cIndOp", ibs.cIndOp),
          t("indDest", ibs.indDest),
          g(
            "valores",
            g("trib", lay.cstEmGIBSCBS
              ? g("gIBSCBS", t("CST", ibs.cst), t("cClassTrib", ibs.cClassTrib))
              : t("CST", ibs.cst) + t("cClassTrib", ibs.cClassTrib)),
          ),
        )
      : "") +
    `</infDPS></DPS>`;
  return { id, xml };
}
