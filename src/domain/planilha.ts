// Validação das linhas da planilha de notas. Mesmas regras do protótipo (validarLinhas),
// agora no servidor, que é quem decide. O navegador lê o .xlsx/.csv e manda as linhas em JSON;
// datas do Excel chegam como número serial ou texto, nunca como objeto Date.
import { addDias, diaValido } from "../lib/datas.js";
import { normDoc, soDigitos, tipoDoc } from "./documentos.js";

export type Padroes = {
  cServPadrao: string;
  cNBSPadrao: string;
  aliqIss: number | null;
  vencDias: number;
  /** para recusar nota em que o tomador é a própria empresa */
  cnpjEmpresa?: string;
  /** a nota vai levar IBS/CBS nesta competência? Se sim, a NBS é obrigatória */
  levaIbsCbs?: (competencia: string) => boolean;
};

export type Linha = {
  i: number;
  doc: string;
  nome: string;
  email: string;
  descricao: string;
  valor: number; // reais
  cServ: string;
  nbs: string;
  issRetido: boolean;
  aliqIss: number | null; // %
  vInssRet: number;
  vIssRet: number;
  vLiq: number;
  competencia: string;
  vencimento: string;
  errors: string[];
};

const COLS: Record<string, string[]> = {
  doc: ["tomador_documento", "cnpj", "cpf", "cnpj/cpf", "cpf/cnpj", "cnpj_cpf", "cpf_cnpj", "documento", "doc", "tomador cnpj"],
  nome: ["tomador_nome", "nome", "cliente", "tomador", "razao social", "razao_social", "nome do cliente"],
  email: ["tomador_email", "email", "e-mail", "email do cliente"],
  descricao: ["descricao", "descricao do servico", "discriminacao", "discriminacao do servico", "servico", "historico"],
  valor: ["valor", "valor do servico", "valor_servico", "valor total", "total"],
  cServ: ["codigo_servico", "codigo", "cod servico", "codigo do servico", "codigo de tributacao", "ctribnac", "item"],
  nbs: ["codigo_nbs", "nbs", "cod nbs", "codigo nbs", "cnbs"],
  issRet: ["iss_retido", "retencao iss", "retencao de iss", "reter iss", "retem iss"],
  aliqIss: ["aliquota_iss", "aliquota", "aliquota do iss", "aliq iss", "% iss"],
  inss: ["valor_inss_retido", "inss_retido", "inss", "valor inss", "retencao inss", "retencao de inss"],
  competencia: ["competencia", "data competencia", "mes de competencia", "data"],
  vencimento: ["vencimento", "data vencimento", "data de vencimento", "venc"],
};

export const OBRIGATORIAS = ["doc", "nome", "descricao", "valor"] as const;

// Anexo I, regras E0621/E0628: ME/EPP no SN com ISS retido informa pAliq de no mínimo 1,8%.
export const ALIQ_ISS_MIN = 1.8;
export const ALIQ_ISS_MAX = 5;
export const NOMES_COLUNA: Record<string, string> = { doc: "CPF/CNPJ do tomador", nome: "nome do tomador", descricao: "descrição", valor: "valor" };

const norm = (s: unknown) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function mapearColunas(cabecalho: string[]) {
  const map: Record<string, string> = {};
  for (const h of cabecalho) {
    const nh = norm(h);
    for (const k in COLS) {
      if (!map[k] && COLS[k]!.some((a) => norm(a) === nh)) {
        map[k] = h;
        break;
      }
    }
  }
  return map;
}

export function parseValor(v: unknown): number {
  if (typeof v === "number") return v;
  let s = String(v ?? "").replace(/[R$\s]/g, "");
  if (!s) return NaN;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  // só número de verdade; parseFloat("12abc") daria 12
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

export function parseSimNao(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  const s = norm(v);
  if (!s || ["nao", "n", "0", "false", "falso"].includes(s)) return false;
  if (["sim", "s", "x", "1", "true", "verdadeiro", "retido"].includes(s)) return true;
  return null;
}

/** 2,5 / 2.5 / "2,5%" e também a célula de porcentagem do Excel (0,025). */
export function parsePct(v: unknown): number | null {
  if (v === "" || v == null) return null;
  if (typeof v === "number") return v > 0 && v < 1 ? v * 100 : v;
  return parseValor(String(v).replace("%", ""));
}

const pad = (n: number | string) => String(n).padStart(2, "0");

export function parseData(v: unknown): string | "" | "invalida" {
  if (v === "" || v == null) return "";
  if (typeof v === "number") {
    if (!(v > 0 && v < 2958466)) return "invalida";
    const d = new Date(Math.round((v - 25569) * 864e5));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  const s = String(v).trim();
  let m: RegExpExecArray | null;
  let r = "invalida";
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s))) r = `${m[3]!.length === 2 ? "20" + m[3] : m[3]}-${pad(m[2]!)}-${pad(m[1]!)}`;
  else if ((m = /^(\d{1,2})\/(\d{4})$/.exec(s))) r = `${m[2]}-${pad(m[1]!)}-01`;
  else if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) r = `${m[1]}-${m[2]}-${m[3]}`;
  else if ((m = /^(\d{4})-(\d{2})$/.exec(s))) r = `${m[1]}-${m[2]}-01`;
  return diaValido(r) ? r : "invalida";
}

const centavos = (v: number) => Math.round(v * 100);

export const LIMITE_LINHAS = 500;

export function validarLinhas(objs: Record<string, unknown>[], p: Padroes, hoje: string) {
  const cabecalho = objs.length ? Object.keys(objs[0]!) : [];
  const map = mapearColunas(cabecalho);
  const faltando = OBRIGATORIAS.filter((k) => !map[k]);
  const rows: Linha[] = [];

  objs.forEach((o, idx) => {
    const g = (k: string) => (map[k] ? o[map[k]!] : "");
    if (Object.values(o).every((v) => String(v ?? "").trim() === "")) return;
    const errors: string[] = [];

    const doc = normDoc(g("doc"));
    if (!tipoDoc(doc)) errors.push("CPF ou CNPJ do tomador inválido");
    const nome = String(g("nome") ?? "").trim();
    if (!nome) errors.push("Nome do tomador vazio");
    else if (nome.length > 300) errors.push("Nome do tomador passa de 300 caracteres");
    const email = String(g("email") ?? "").trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("E-mail inválido");
    else if (email.length > 80) errors.push("E-mail passa de 80 caracteres");
    const descricao = String(g("descricao") ?? "").trim();
    if (!descricao) errors.push("Descrição do serviço vazia");
    else if (descricao.length > 2000) errors.push("Descrição passa de 2000 caracteres");

    let valor = parseValor(g("valor"));
    if (!(valor > 0)) {
      errors.push("Valor deve ser maior que zero");
      valor = 0;
    } else valor = centavos(valor) / 100;

    const cServ = soDigitos(g("cServ")) || soDigitos(p.cServPadrao);
    if (cServ.length !== 6) errors.push("Código de serviço precisa ter 6 dígitos (ex.: 01.07.01)");
    const nbs = soDigitos(g("nbs")) || soDigitos(p.cNBSPadrao);
    if (nbs && nbs.length !== 9) errors.push("Código NBS precisa ter 9 dígitos (ex.: 1.1502.10.00)");

    let issRetido = parseSimNao(g("issRet"));
    if (issRetido === null) {
      errors.push('ISS retido deve ser "Sim" ou "Não"');
      issRetido = false;
    }
    let aliqIss = parsePct(g("aliqIss"));
    if (issRetido) {
      if (aliqIss == null) aliqIss = p.aliqIss;
      if (aliqIss == null) errors.push("Informe a alíquota do ISS retido");
      else if (!(aliqIss >= ALIQ_ISS_MIN && aliqIss <= ALIQ_ISS_MAX)) errors.push("Alíquota do ISS retido deve ficar entre 1,8% e 5%");
    }
    aliqIss = issRetido && aliqIss != null && aliqIss > 0 ? centavos(aliqIss) / 100 : null;

    let vInssRet = String(g("inss") ?? "").trim() === "" ? 0 : parseValor(g("inss"));
    if (!(vInssRet >= 0)) {
      errors.push("Valor do INSS retido inválido");
      vInssRet = 0;
    }
    // em centavos para não acumular erro de ponto flutuante
    const vc = centavos(valor);
    const issC = aliqIss && vc > 0 ? Math.round((vc * centavos(aliqIss)) / 10_000) : 0;
    const inssC = centavos(vInssRet);
    const liqC = vc > 0 ? vc - issC - inssC : 0;
    if (vc > 0 && liqC <= 0) errors.push("Retenções iguais ou maiores que o valor do serviço");

    let competencia = parseData(g("competencia"));
    let vencimento = parseData(g("vencimento"));
    if (competencia === "invalida") errors.push("Competência em formato desconhecido");
    if (vencimento === "invalida") errors.push("Vencimento em formato desconhecido");
    if (!competencia || competencia === "invalida") competencia = hoje;
    if (!vencimento || vencimento === "invalida") vencimento = addDias(hoje, p.vencDias || 10);
    // regras do Anexo I que a Sefin rejeitaria: competência depois de dhEmi e tomador = prestador
    if (competencia > hoje) errors.push("Competência não pode ser posterior à data de emissão");
    if (p.cnpjEmpresa && doc === p.cnpjEmpresa) errors.push("O tomador não pode ser a própria empresa");
    if (!nbs && p.levaIbsCbs?.(competencia)) errors.push("Código NBS é obrigatório quando a nota leva IBS/CBS");

    rows.push({
      i: idx + 2,
      doc,
      nome,
      email,
      descricao,
      valor,
      cServ,
      nbs,
      issRetido,
      aliqIss,
      vInssRet: inssC / 100,
      vIssRet: issC / 100,
      vLiq: liqC / 100,
      competencia,
      vencimento,
      errors,
    });
  });
  return { rows, faltando: faltando.map((k) => NOMES_COLUNA[k]!) };
}
