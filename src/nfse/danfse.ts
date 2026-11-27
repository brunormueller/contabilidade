// DANFSe (Documento Auxiliar da NFS-e) em PDF, no modelo do Anexo I da NT 008 v1.02. A API do
// governo que gerava este PDF foi suspensa em 03/08/2026: cada emissor monta o seu. Só entra o
// que está no XML da NFS-e (item 2.1); o que falta sai como "-".
import { DOMParser } from "@xmldom/xmldom";
import { degrees, PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "pdf-lib";
import qrcode from "qrcode-generator";
import { fmtDoc } from "../domain/documentos.js";
import { MUNICIPIOS_SC } from "../domain/municipiosSC.js";
import { LOGO_NFSE_PNG } from "./logoNfse.js";

// ---------- leitura do XML ----------

type El = { localName?: string | null; nodeType: number; textContent: string | null; childNodes: ArrayLike<unknown>; getAttribute?: (n: string) => string | null };

/** Primeiro elemento no caminho "a/b/c", comparando só o nome local (ignora namespace). */
function no(raiz: El | null, caminho: string): El | null {
  let atual = raiz;
  for (const nome of caminho.split("/")) {
    if (!atual) return null;
    atual = (Array.from(atual.childNodes) as El[]).find((f) => f.nodeType === 1 && f.localName === nome) ?? null;
  }
  return atual;
}

const dataBR = (s: string) => (/^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10).split("-").reverse().join("/") : "");
// o horário já vem com o fuso de quem emitiu: mostra como está
const dataHora = (s: string) => (s ? `${dataBR(s)} ${s.slice(11, 19)}` : "");
const numero = (s: string) => Number(s).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const moeda = (s: string) => (s ? `R$ ${numero(s)}` : "");
const pct = (s: string) => (s ? `${numero(s)} %` : "");
const cep = (s: string) => (s.length === 8 ? `${s.slice(0, 2)}.${s.slice(2, 5)}-${s.slice(5)}` : s);
const ibge = (s: string) => (s.length === 7 ? `${s.slice(0, 2)}.${s.slice(2)}` : s);
const cTrib = (s: string) => (s.length === 6 ? `${s.slice(0, 2)}.${s.slice(2, 4)}.${s.slice(4)}` : s);
const nbs = (s: string) => (s.length === 9 ? `${s[0]}.${s.slice(1, 5)}.${s.slice(5, 7)}.${s.slice(7)}` : s);
const cidadeUf = (cMun: string) => (MUNICIPIOS_SC[Number(cMun)] ? `${MUNICIPIOS_SC[Number(cMun)]} / SC` : "");
const junta = (...p: string[]) => p.filter(Boolean).join(", ");

const EMITENTE: Record<string, string> = { "1": "Prestador", "2": "Tomador", "3": "Intermediário" };
const SITUACAO: Record<string, string> = { "100": "NFS-e Gerada", "101": "NFS-e de Substituição Gerada", "102": "NFS-e de Decisão Judicial", "103": "NFS-e Avulsa" };
const FINALIDADE: Record<string, string> = { "0": "NFS-e regular" };
const SIMPLES: Record<string, string> = {
  "1": "Não Optante",
  "2": "Optante - Microempreendedor Individual (MEI)",
  "3": "Optante - Microempresa ou Empresa de Pequeno Porte (ME/EPP)",
};
const REGIME_SN: Record<string, string> = {
  "1": "Regime de apuração dos tributos federais e municipal pelo Simples Nacional",
  "2": "Tributos federais pelo SN e ISSQN por fora, conforme a legislação municipal",
  "3": "Tributos federais e municipal por fora do Simples Nacional",
};
const TRIB_ISSQN: Record<string, string> = { "1": "Operação Tributável", "2": "Imunidade", "3": "Exportação de serviço", "4": "Não Incidência" };
const RET_ISSQN: Record<string, string> = { "1": "Não Retido", "2": "Retido pelo Tomador", "3": "Retido pelo Intermediário" };

export function dadosDanfse(xml: string) {
  const doc = new DOMParser().parseFromString(xml, "text/xml") as unknown as { documentElement: El };
  const inf = no(doc.documentElement, "infNFSe");
  const dps = no(inf, "DPS/infDPS");
  if (!inf || !dps) throw new Error("XML da NFS-e incompleto.");
  const v = (raiz: El | null, caminho: string) => no(raiz, caminho)?.textContent?.trim() ?? "";
  const n = (c: string) => v(inf, c);
  const d = (c: string) => v(dps, c);

  const pessoa = (raiz: El | null, endereco: string, nac: string, nome: string) => {
    const e = no(raiz, endereco);
    const cMun = v(e, `${nac}cMun`);
    const doc_ = v(raiz, "CNPJ") || v(raiz, "CPF") || v(raiz, "NIF");
    return {
      doc: doc_ ? fmtDoc(doc_) : "",
      im: v(raiz, "IM"),
      fone: v(raiz, "fone"),
      nome: v(raiz, nome),
      municipio: cidadeUf(cMun) || (v(e, "UF") ? v(e, "UF") : ""),
      ibgeCep: [ibge(cMun), cep(v(e, `${nac}CEP`))].filter(Boolean).join(" / "),
      endereco: junta(v(e, "xLgr"), v(e, "nro"), v(e, "xCpl"), v(e, "xBairro")),
      email: v(raiz, "email"),
    };
  };
  const emit = no(inf, "emit");
  const prest = pessoa(emit, "enderNac", "", "xNome");
  const ufEmit = v(emit, "enderNac/UF") || "SC";
  const comUf = (cidade: string) => (cidade ? `${cidade} / ${ufEmit}` : "");

  const ibs = no(inf, "IBSCBS");
  const cstTrib = no(dps, "IBSCBS/valores/trib/gIBSCBS") ?? no(dps, "IBSCBS/valores/trib");
  const endImovel = no(dps, "IBSCBS/imovel/gUnidImob/end");
  const retido = d("valores/trib/tribMun/tpRetISSQN") === "2" || d("valores/trib/tribMun/tpRetISSQN") === "3";
  const totalRet = n("valores/vTotalRet");
  const chave = (inf.getAttribute?.("Id") ?? "").replace(/^NFS/, "");

  return {
    teste: d("tpAmb") !== "1",
    chave,
    municipioEmissor: n("xLocEmi") ? `${n("xLocEmi")} - ${ufEmit}` : "",
    ambGer: n("ambGer"),
    tpAmb: d("tpAmb"),
    numero: n("nNFSe"),
    competencia: dataBR(d("dCompet")),
    dhNfse: dataHora(n("dhProc")),
    nDps: d("nDPS"),
    serie: d("serie"),
    dhDps: dataHora(d("dhEmi")),
    emitente: EMITENTE[d("tpEmit")] ?? "",
    situacao: SITUACAO[n("cStat")] ?? n("cStat"),
    finalidade: FINALIDADE[d("finNFSe") || v(dps, "IBSCBS/finNFSe") || "0"] ?? "",
    prestador: {
      ...prest,
      fone: prest.fone || d("prest/fone"),
      im: prest.im || d("prest/IM"),
      email: prest.email || d("prest/email"),
      simples: SIMPLES[d("prest/regTrib/opSimpNac")] ?? "",
      regime: REGIME_SN[d("prest/regTrib/regApTribSN")] ?? "",
    },
    tomador: no(dps, "toma") ? pessoa(no(dps, "toma"), "end", "endNac/", "xNome") : null,
    destinatarioEhTomador: d("indDest") !== "1" && v(dps, "IBSCBS/indDest") !== "1",
    servico: {
      cTrib: `${cTrib(d("serv/cServ/cTribNac"))} / ${d("serv/cServ/cTribMun") || "-"}`,
      nbs: nbs(d("serv/cServ/cNBS")),
      local: n("xLocPrestacao") ? `${comUf(n("xLocPrestacao"))} / -` : "",
      xTrib: n("xTribMun") || n("xTribNac"),
      descricao: d("serv/cServ/xDescServ"),
    },
    issqn: {
      tipo: TRIB_ISSQN[d("valores/trib/tribMun/tribISSQN")] ?? "",
      incidencia: n("xLocIncid") ? `${comUf(n("xLocIncid"))} / -` : "",
      bc: moeda(n("valores/vBC")),
      aliquota: pct(n("valores/pAliqAplic") || d("valores/trib/tribMun/pAliq")),
      retencao: RET_ISSQN[d("valores/trib/tribMun/tpRetISSQN")] ?? "",
      apurado: moeda(n("valores/vISSQN")),
    },
    federal: {
      irrf: moeda(d("valores/trib/tribFed/vRetIRRF")),
      inss: moeda(d("valores/trib/tribFed/vRetCP")),
      csll: moeda(d("valores/trib/tribFed/vRetCSLL")),
      pis: moeda(d("valores/trib/tribFed/piscofins/vPis")),
      cofins: moeda(d("valores/trib/tribFed/piscofins/vCofins")),
      comPisCofins: d("dCompet") < "2027-01-01",
    },
    ibsCbs: ibs
      ? {
          cst: [v(cstTrib, "CST"), v(cstTrib, "cClassTrib")].filter(Boolean).join(" / "),
          indicador: [d("IBSCBS/cIndOp"), v(ibs, "cLocalidadeIncid"), v(ibs, "xLocalidadeIncid"), ufEmit].filter(Boolean).join(" / "),
          exclusoes: moeda(v(ibs, "valores/vCalcReeRepRes") || "0"),
          base: moeda(v(ibs, "valores/vBC")),
          reducoes: [v(ibs, "valores/uf/pRedAliqUF"), v(ibs, "valores/mun/pRedAliqMun"), v(ibs, "valores/fed/pRedAliqCBS")].map((x) => pct(x) || "-").join(" / "),
          aliquotas: `${pct(v(ibs, "valores/uf/pIBSUF"))} / ${pct(v(ibs, "valores/mun/pIBSMun"))}`,
          efetivaMun: pct(v(ibs, "valores/mun/pAliqEfetMun")),
          valorMun: moeda(v(ibs, "totCIBS/gIBS/gIBSMunTot/vIBSMun")),
          efetivaUf: pct(v(ibs, "valores/uf/pAliqEfetUF")),
          valorUf: moeda(v(ibs, "totCIBS/gIBS/gIBSUFTot/vIBSUF")),
          totalIbs: moeda(v(ibs, "totCIBS/gIBS/vIBSTot")),
          cbs: pct(v(ibs, "valores/fed/pCBS")),
          cbsEfetiva: pct(v(ibs, "valores/fed/pAliqEfetCBS")),
          totalCbs: moeda(v(ibs, "totCIBS/gCBS/vCBS")),
          soma: moeda(String(Number(v(ibs, "totCIBS/gIBS/vIBSTot") || 0) + Number(v(ibs, "totCIBS/gCBS/vCBS") || 0))),
          totalNota: moeda(v(ibs, "totCIBS/vTotNF")),
        }
      : null,
    valores: {
      servico: moeda(d("valores/vServPrest/vServ")),
      descIncond: moeda(d("valores/vDescCondIncond/vDescIncond")),
      descCond: moeda(d("valores/vDescCondIncond/vDescCond")),
      retencoes: totalRet && Number(totalRet) > 0 ? moeda(totalRet) : retido ? moeda(n("valores/vISSQN")) : "",
      liquido: moeda(n("valores/vLiq")),
    },
    complementares: [
      endImovel &&
        `Imóvel: ${junta(v(endImovel, "xLgr"), v(endImovel, "nro"), v(endImovel, "xCpl"), v(endImovel, "xBairro"))}, CEP ${cep(v(endImovel, "CEP"))}${
          cidadeUf(d("IBSCBS/imovel/cMun")) ? `, ${cidadeUf(d("IBSCBS/imovel/cMun"))}` : ""
        }`,
      d("serv/infoCompl/xInfComp"),
      n("xOutInf"),
      "Totais aproximados dos Tributos cfe. Lei n° 12.741/2012: Federais: -; Estaduais: -; Municipais: -;",
    ].filter((x): x is string => !!x),
  };
}

/** Endereço da consulta pública que vai no QR Code (NT 008, 2.4.3). */
export const urlConsulta = (chave: string, teste: boolean) =>
  `https://www.${teste ? "producaorestrita." : ""}nfse.gov.br/ConsultaPublica/?tpc=1&chave=${chave}`;

// ---------- desenho ----------

const A4 = { w: 595.28, h: 841.89 };
const M = 5; // margem entre 0,15 e 0,20 cm
const CINZA = rgb(0.95, 0.95, 0.95);
const PRETO = rgb(0, 0, 0);
const LARG = A4.w - 2 * M;
const COL = (LARG - 6) / 4;
const cx = (i: number) => M + 3 + i * COL;

/** As fontes padrão do PDF só têm o alfabeto latino: o que não existir vira "?". */
function limpar(s: string, f: PDFFont) {
  const ok = new Set(f.getCharacterSet());
  return Array.from(s.replace(/\s+/g, " "), (c) => (ok.has(c.codePointAt(0)!) ? c : "?")).join("");
}

function quebrar(s: string, f: PDFFont, tam: number, largura: number) {
  const linhas: string[] = [];
  for (const paragrafo of s.split(/\r?\n/)) {
    let atual = "";
    for (const palavra of limpar(paragrafo, f).split(" ")) {
      let resto = palavra;
      const junto = atual ? `${atual} ${resto}` : resto;
      if (f.widthOfTextAtSize(junto, tam) <= largura) {
        atual = junto;
        continue;
      }
      if (atual) linhas.push(atual);
      // palavra maior que a linha: corta
      while (f.widthOfTextAtSize(resto, tam) > largura) {
        let k = resto.length - 1;
        while (k > 1 && f.widthOfTextAtSize(resto.slice(0, k), tam) > largura) k--;
        linhas.push(resto.slice(0, k));
        resto = resto.slice(k);
      }
      atual = resto;
    }
    linhas.push(atual);
  }
  return linhas;
}

export async function gerarDanfse(xml: string, o: { cancelada?: boolean } = {}) {
  const x = dadosDanfse(xml);
  const pdf = await PDFDocument.create();
  pdf.setTitle(`DANFSe ${x.numero} - ${x.chave}`);
  const page: PDFPage = pdf.addPage([A4.w, A4.h]);
  const normal = await pdf.embedFont(StandardFonts.Helvetica);
  const negrito = await pdf.embedFont(StandardFonts.HelveticaBold);

  // coordenadas medidas a partir do topo da página
  const texto = (px: number, topo: number, s: string, t: { tam?: number; f?: PDFFont; larg?: number; cor?: ReturnType<typeof rgb> } = {}) => {
    const { tam = 7, f = normal, larg = A4.w - M - px - 2, cor = PRETO } = t;
    let txt = limpar(s, f);
    if (f.widthOfTextAtSize(txt, tam) > larg) {
      while (txt && f.widthOfTextAtSize(`${txt}...`, tam) > larg) txt = txt.slice(0, -1);
      txt = `${txt}...`;
    }
    page.drawText(txt, { x: px, y: A4.h - topo - tam, size: tam, font: f, color: cor });
  };
  const centro = (topo: number, s: string, tam: number, f: PDFFont, cor = PRETO) =>
    texto((A4.w - f.widthOfTextAtSize(s, tam)) / 2, topo, s, { tam, f, cor });
  const fundo = (px: number, topo: number, w: number, h: number) => page.drawRectangle({ x: px, y: A4.h - topo - h, width: w, height: h, color: CINZA });
  const linha = (topo: number) => page.drawLine({ start: { x: M, y: A4.h - topo }, end: { x: A4.w - M, y: A4.h - topo }, thickness: 0.5, color: PRETO });
  const campo = (col: number, topo: number, rotulo: string, valor: string, span = 1, tamRotulo = 6) => {
    const larg = COL * span - 4;
    texto(cx(col), topo, rotulo, { tam: tamRotulo, f: negrito, larg });
    texto(cx(col), topo + tamRotulo + 1.5, valor || "-", { larg });
  };
  const titulo = (topo: number, s: string, altura = 17) => {
    fundo(M, topo, COL, altura);
    texto(cx(0), topo + 2, s, { f: negrito, larg: COL - 2 });
  };

  // cabeçalho
  let y = M;
  fundo(M, y, LARG, 36);
  const logo = await pdf.embedPng(Buffer.from(LOGO_NFSE_PNG, "base64"));
  page.drawImage(logo, { x: cx(0), y: A4.h - y - 31, width: 128, height: (128 * logo.height) / logo.width });
  centro(y + 3, "DANFSe v2.0", 9, negrito);
  centro(y + 13, "Documento Auxiliar da NFS-e", 9, negrito);
  if (x.teste) centro(y + 23, "NFS-e SEM VALIDADE JURÍDICA", 9, negrito, rgb(1, 0, 0));
  texto(cx(3), y + 5, `Município: ${x.municipioEmissor || "-"}`, { tam: 8, larg: COL });
  texto(cx(3), y + 16, `Ambiente Gerador: ${x.ambGer}`, { tam: 6 });
  texto(cx(3), y + 23, `Tipo de Ambiente: ${x.tpAmb}`, { tam: 6 });
  y += 36;
  linha(y);

  // identificação e QR Code
  texto(cx(0), y + 3, "CHAVE DE ACESSO DA NFS-e", { f: negrito });
  texto(cx(0), y + 11.5, x.chave);
  campo(0, y + 23, "NÚMERO DA NFS-e", x.numero, 1, 7);
  campo(1, y + 23, "COMPETÊNCIA DA NFS-e", x.competencia, 1, 7);
  campo(2, y + 23, "DATA E HORA DA EMISSÃO DA NFS-e", x.dhNfse, 1, 7);
  campo(0, y + 43, "NÚMERO DA DPS", x.nDps, 1, 7);
  campo(1, y + 43, "SÉRIE DA DPS", x.serie, 1, 7);
  campo(2, y + 43, "DATA E HORA DA EMISSÃO DA DPS", x.dhDps, 1, 7);
  fundo(M, y + 61, COL, 19);
  campo(0, y + 63, "EMITENTE DA NFS-e", x.emitente, 1, 7);
  campo(1, y + 63, "SITUAÇÃO DA NFS-e", x.situacao, 1, 7);
  campo(2, y + 63, "FINALIDADE", x.finalidade, 1, 7);

  const qr = qrcode(0, "M");
  qr.addData(urlConsulta(x.chave, x.teste));
  qr.make();
  const modulos = qr.getModuleCount();
  const lado = 52; // mínimo da norma: 1,52 cm (43 pt)
  const passo = lado / modulos;
  const qx = cx(3) + 40;
  const qy = y + 5;
  for (let r = 0; r < modulos; r++)
    for (let c = 0; c < modulos; c++)
      if (qr.isDark(r, c)) page.drawRectangle({ x: qx + c * passo, y: A4.h - qy - (r + 1) * passo, width: passo + 0.05, height: passo + 0.05, color: PRETO });
  ["A autenticidade desta NFS-e pode ser verificada", "pela leitura deste código QR ou pela consulta da", "chave de acesso no portal nacional da NFS-e"].forEach((s, i) =>
    texto(cx(3), y + 60 + i * 7, s, { tam: 6, larg: COL }),
  );
  y += 82;
  linha(y);

  const bloco = (p: NonNullable<ReturnType<typeof dadosDanfse>["tomador"]>, nome: string, comIm = true) => {
    titulo(y, nome);
    campo(1, y + 2, "CNPJ / CPF / NIF", p.doc);
    if (comIm) campo(2, y + 2, "Indicador Municipal (Inscrição)", p.im);
    campo(3, y + 2, "Telefone", p.fone);
    campo(0, y + 20, "Nome / Nome Empresarial", p.nome, 2);
    campo(2, y + 20, "Município / Sigla UF", p.municipio);
    campo(3, y + 20, "Código IBGE / CEP", p.ibgeCep);
    campo(0, y + 38, "Endereço", p.endereco, 2);
    campo(2, y + 38, "E-mail", p.email, 2);
    y += 56;
  };
  const aviso = (s: string) => {
    centro(y + 1.5, s, 7, normal);
    y += 11;
    linha(y);
  };

  bloco(x.prestador, "PRESTADOR / FORNECEDOR");
  campo(0, y, "Simples Nacional na Data de Competência", x.prestador.simples);
  campo(1, y, "Regime de Apuração Tributária pelo SN", x.prestador.regime, 3);
  y += 18;
  linha(y);
  if (x.tomador) {
    bloco(x.tomador, "TOMADOR / ADQUIRENTE");
    linha(y);
  } else aviso("TOMADOR/ADQUIRENTE DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e");
  aviso(x.destinatarioEhTomador ? "O DESTINATÁRIO É O PRÓPRIO TOMADOR/ADQUIRENTE DA OPERAÇÃO" : "DESTINATÁRIO DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e");
  aviso("INTERMEDIÁRIO DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e");

  // serviço
  const s = x.servico;
  titulo(y, "SERVIÇO PRESTADO");
  campo(1, y + 2, "Código de Tributação Nacional/Municipal", s.cTrib);
  campo(2, y + 2, "Código da NBS", s.nbs);
  campo(3, y + 2, "Local da Prestação / Sigla UF / País", s.local);
  y += 20;
  texto(cx(0), y, s.xTrib, { larg: LARG - 8 });
  y += 11;
  texto(cx(0), y, "Descrição do Serviço", { tam: 6, f: negrito });
  y += 8;
  // a descrição ocupa o que precisar, até 12 linhas: o documento tem uma página só
  const desc = quebrar(s.descricao, normal, 7, LARG - 8);
  const visiveis = desc.slice(0, 12);
  if (desc.length > visiveis.length) visiveis[11] = `${visiveis[11]!.slice(0, -3)}...`;
  for (const l of visiveis) {
    texto(cx(0), y, l);
    y += 8.5;
  }
  y += 3;
  linha(y);

  const q = x.issqn;
  titulo(y, "TRIBUTAÇÃO MUNICIPAL (ISSQN)");
  campo(1, y + 2, "Tipo de Tributação do ISSQN", q.tipo);
  campo(2, y + 2, "Município / Sigla UF / País de Incidência do ISSQN", q.incidencia, 2);
  campo(0, y + 20, "BC ISSQN", q.bc);
  campo(1, y + 20, "Alíquota Aplicada", q.aliquota);
  campo(2, y + 20, "Retenção do ISSQN", q.retencao);
  campo(3, y + 20, "ISSQN Apurado", q.apurado);
  y += 38;
  linha(y);

  const f = x.federal;
  titulo(y, "TRIBUTAÇÃO FEDERAL (EXCETO CBS)");
  campo(1, y + 2, "IRRF", f.irrf);
  campo(2, y + 2, "Contribuição Previdenciária - Retida", f.inss);
  campo(3, y + 2, "Contribuições Sociais - Retidas", f.csll);
  y += 20;
  if (f.comPisCofins) {
    campo(0, y, "PIS - Débito Apuração Própria", f.pis);
    campo(1, y, "COFINS - Débito Apuração Própria", f.cofins);
    campo(2, y, "Descrição Contrib. Sociais - Retidas", "");
    y += 18;
  }
  linha(y);

  const i = x.ibsCbs;
  if (i) {
    titulo(y, "TRIBUTAÇÃO IBS/CBS");
    campo(1, y + 2, "CST / cClassTrib", i.cst);
    campo(2, y + 2, "Indicador de Operação / Código IBGE Incidência / Município / UF", i.indicador, 2);
    campo(0, y + 20, "Exclusões e Reduções da Base de Cálculo", i.exclusoes);
    campo(1, y + 20, "Base de Cálculo Após Exclusões e Reduções", i.base);
    campo(2, y + 20, "Red. Alíquota IBS / Red. Alíquota CBS", i.reducoes);
    campo(3, y + 20, "Alíquota - IBS UF / IBS Mun", i.aliquotas);
    campo(0, y + 38, "Alíq. Efetiva Municipal - IBS", i.efetivaMun);
    campo(1, y + 38, "Valor Apurado Municipal - IBS", i.valorMun);
    campo(2, y + 38, "Alíq. Efetiva Estadual - IBS", i.efetivaUf);
    campo(3, y + 38, "Valor Apurado Estadual - IBS", i.valorUf);
    campo(0, y + 56, "Valor Total Apurado - IBS", i.totalIbs);
    campo(1, y + 56, "Alíquota - CBS", i.cbs);
    campo(2, y + 56, "Alíquota Efetiva - CBS", i.cbsEfetiva);
    campo(3, y + 56, "Valor Total Apurado - CBS", i.totalCbs);
    y += 74;
    linha(y);
  }

  const val = x.valores;
  titulo(y, "VALOR TOTAL DA NFS-e");
  campo(1, y + 2, "VALOR DA OPERAÇÃO / SERVIÇO", val.servico);
  campo(2, y + 2, "Desconto Incondicionado", val.descIncond);
  campo(3, y + 2, "Desconto Condicionado", val.descCond);
  campo(0, y + 20, "Total das Retenções (ISSQN / Federais)", val.retencoes);
  campo(1, y + 20, "VALOR LÍQUIDO DA NFS-e", val.liquido);
  campo(2, y + 20, "Total do IBS/CBS", i?.soma ?? "");
  fundo(cx(3) - 2, y + 18, COL + 2, 19);
  campo(3, y + 20, "VALOR LÍQUIDO DA NFS-e + IBS/CBS", i?.totalNota ?? "");
  y += 38;
  linha(y);

  // informações complementares: o que sobrar até o canhoto
  const canhoto = A4.h - M - 26;
  texto(cx(0), y + 3, "INFORMAÇÕES COMPLEMENTARES", { f: negrito });
  y += 15;
  for (const l of x.complementares.flatMap((c) => quebrar(c, normal, 7, LARG - 8))) {
    if (y > canhoto - 12) break;
    texto(cx(0), y, l);
    y += 9;
  }

  linha(canhoto);
  [1, 2].forEach((c) => page.drawLine({ start: { x: M + c * (LARG / 4), y: A4.h - canhoto }, end: { x: M + c * (LARG / 4), y: M }, thickness: 0.5, color: PRETO }));
  texto(cx(0), canhoto + 3, "DATA CIENTIFICAÇÃO:", { tam: 6, f: negrito });
  texto(M + LARG / 4 + 3, canhoto + 3, "IDENTIFICAÇÃO E ASSINATURA", { tam: 6, f: negrito });
  texto(M + LARG / 2 + 3, canhoto + 3, "N° NFS-e / CHAVE NFS-e", { tam: 6, f: negrito });
  texto(M + LARG / 2 + 3, canhoto + 13, `${x.numero} / ${x.chave}`, { larg: LARG / 2 - 6 });

  page.drawRectangle({ x: M, y: M, width: LARG, height: A4.h - 2 * M, borderColor: PRETO, borderWidth: 1 });
  if (o.cancelada)
    page.drawText("CANCELADA", { x: 110, y: 270, size: 80, font: normal, color: rgb(0.65, 0.65, 0.65), rotate: degrees(45), opacity: 0.6 });

  return pdf.save();
}
