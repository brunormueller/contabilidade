import type { Ambiente } from "../env.js";

// O que muda na DPS entre os ambientes, conforme os pacotes XSD e o Anexo I de cada um
// (xsd/LEIAME.md). Quando a NT 009 for para produção, copie o pacote novo para xsd/producao
// e iguale a linha de produção à de produção restrita.
export type Layout = {
  tpAmb: "1" | "2";
  xsdDir: string;
  /** onde fica finNFSe: no infDPS, sempre (NT 009), ou dentro do grupo IBSCBS, quando ele existe */
  finNFSe: "infDPS" | "IBSCBS";
  /** TCCServ: xDescServ vem antes de cNBS (layout de produção) ou depois (NT 009) */
  descAntesDoNbs: boolean;
  /** CST e cClassTrib dentro de valores/trib/gIBSCBS (produção) ou direto em valores/trib (NT 009) */
  cstEmGIBSCBS: boolean;
  /** cIndOp obrigatório no grupo IBSCBS */
  cIndOpObrigatorio: boolean;
  /** Regra E0855: grupo IBSCBS obrigatório a partir desta competência */
  ibsCbsObrigatorioDesde: string | null;
};

export const LAYOUTS: Record<Ambiente, Layout> = {
  producao: {
    tpAmb: "1", xsdDir: "producao", finNFSe: "IBSCBS", descAntesDoNbs: true, cstEmGIBSCBS: true, cIndOpObrigatorio: true,
    ibsCbsObrigatorioDesde: null,
  },
  producao_restrita: {
    tpAmb: "2", xsdDir: "producao-restrita", finNFSe: "infDPS", descAntesDoNbs: false, cstEmGIBSCBS: false, cIndOpObrigatorio: false,
    ibsCbsObrigatorioDesde: "2026-10-01",
  },
};

export const exigeIbsCbs = (amb: Ambiente, competencia: string) => {
  const desde = LAYOUTS[amb].ibsCbsObrigatorioDesde;
  return desde != null && competencia >= desde;
};
