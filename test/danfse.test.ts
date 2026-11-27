import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { dadosDanfse, gerarDanfse, urlConsulta } from "../src/nfse/danfse.js";

const CHAVE = "42065042211222333000181000000000000126110000000019";

// Mesma estrutura do XML que a Sefin devolve, com dados fictícios.
const xml = (o: { tpAmb?: string; retencao?: string; descricao?: string } = {}) => `<?xml version="1.0" encoding="utf-8"?>
<NFSe versao="1.01" xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFSe Id="NFS${CHAVE}">
<xLocEmi>Guaramirim</xLocEmi><xLocPrestacao>Guaramirim</xLocPrestacao><nNFSe>1</nNFSe><cLocIncid>4206504</cLocIncid><xLocIncid>Guaramirim</xLocIncid>
<xTribNac>Limpeza, manutenção e conservação de piscinas.</xTribNac><ambGer>2</ambGer><cStat>100</cStat><dhProc>2026-11-27T20:07:44-03:00</dhProc>
<emit><CNPJ>11222333000181</CNPJ><xNome>EMPRESA TESTE</xNome><enderNac><xLgr>RUA A</xLgr><nro>1</nro><xBairro>CENTRO</xBairro><cMun>4206504</cMun><UF>SC</UF><CEP>89270000</CEP></enderNac></emit>
<valores><vLiq>300.00</vLiq></valores>
<IBSCBS><cLocalidadeIncid>4206504</cLocalidadeIncid><xLocalidadeIncid>Guaramirim</xLocalidadeIncid>
<valores><vBC>300.00</vBC><uf><pIBSUF>0.05</pIBSUF><pAliqEfetUF>0.05</pAliqEfetUF></uf><mun><pIBSMun>0.05</pIBSMun><pAliqEfetMun>0.05</pAliqEfetMun></mun><fed><pCBS>11.20</pCBS><pAliqEfetCBS>11.20</pAliqEfetCBS></fed></valores>
<totCIBS><vTotNF>300.00</vTotNF><gIBS><vIBSTot>0.30</vIBSTot><gIBSUFTot><vIBSUF>0.15</vIBSUF></gIBSUFTot><gIBSMunTot><vIBSMun>0.15</vIBSMun></gIBSMunTot></gIBS><gCBS><vCBS>33.60</vCBS></gCBS></totCIBS></IBSCBS>
<DPS versao="1.01"><infDPS Id="DPS1"><tpAmb>${o.tpAmb ?? "2"}</tpAmb><dhEmi>2026-11-27T20:07:43-03:00</dhEmi><serie>900</serie><nDPS>27</nDPS><dCompet>2026-11-01</dCompet><tpEmit>1</tpEmit><finNFSe>0</finNFSe>
<prest><CNPJ>11222333000181</CNPJ><regTrib><opSimpNac>3</opSimpNac><regApTribSN>1</regApTribSN></regTrib></prest>
<toma><CNPJ>11444777000161</CNPJ><xNome>Cliente Exemplo</xNome><end><endNac><cMun>4208906</cMun><CEP>89255300</CEP></endNac><xLgr>Rua B</xLgr><nro>10</nro><xBairro>Amizade</xBairro></end><email>c@x.com</email></toma>
<indDest>0</indDest>
<serv><locPrest><cLocPrestacao>4206504</cLocPrestacao></locPrest><cServ><cTribNac>071002</cTribNac><cNBS>118031000</cNBS><xDescServ>${o.descricao ?? "Limpeza de piscina"}</xDescServ></cServ></serv>
<valores><vServPrest><vServ>300.00</vServ></vServPrest><trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>${o.retencao ?? "1"}</tpRetISSQN></tribMun></trib></valores>
<IBSCBS><cIndOp>020201</cIndOp><imovel><cMun>4208906</cMun><gUnidImob><end><CEP>89255300</CEP><xLgr>Rua B</xLgr><nro>10</nro><xBairro>Amizade</xBairro></end></gUnidImob></imovel><valores><trib><CST>000</CST><cClassTrib>000001</cClassTrib></trib></valores></IBSCBS>
</infDPS></DPS></infNFSe></NFSe>`;

const semEspacoFixo = (s: string) => s.replace(/ /g, " ");

describe("dados do DANFSe", () => {
  it("lê do XML os campos do modelo, formatados", () => {
    const x = dadosDanfse(xml());
    expect(x).toMatchObject({
      teste: true, chave: CHAVE, numero: "1", competencia: "01/11/2026", dhNfse: "27/11/2026 20:07:44", nDps: "27",
      situacao: "NFS-e Gerada", municipioEmissor: "Guaramirim - SC", destinatarioEhTomador: true,
      prestador: { doc: "11.222.333/0001-81", municipio: "Guaramirim / SC", ibgeCep: "42.06504 / 89.270-000", endereco: "RUA A, 1, CENTRO" },
      tomador: { doc: "11.444.777/0001-61", municipio: "Jaraguá do Sul / SC", endereco: "Rua B, 10, Amizade", email: "c@x.com" },
      servico: { cTrib: "07.10.02 / -", nbs: "1.1803.10.00", local: "Guaramirim / SC / -" },
      issqn: { retencao: "Não Retido", bc: "", apurado: "" },
      ibsCbs: { cst: "000 / 000001", indicador: "020201 / 4206504 / Guaramirim / SC", aliquotas: "0,05 % / 0,05 %", cbs: "11,20 %" },
    });
    expect(semEspacoFixo(x.ibsCbs!.soma)).toBe("R$ 33,90");
    expect(semEspacoFixo(x.valores.liquido)).toBe("R$ 300,00");
    expect(x.complementares[0]).toBe("Imóvel: Rua B, 10, Amizade, CEP 89.255-300, Jaraguá do Sul / SC");
  });

  it("QR Code aponta para a consulta pública do ambiente da nota", () => {
    expect(urlConsulta(CHAVE, false)).toBe(`https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=${CHAVE}`);
    expect(urlConsulta(CHAVE, true)).toContain("producaorestrita");
    expect(dadosDanfse(xml({ tpAmb: "1" })).teste).toBe(false);
  });
});

describe("PDF", () => {
  it("sai em uma página A4, mesmo com descrição enorme e caractere fora do alfabeto da fonte", async () => {
    const bytes = await gerarDanfse(xml({ descricao: `Serviço 😀 ${"palavra ".repeat(300)}${"x".repeat(400)}`, retencao: "2" }), { cancelada: true });
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
    expect(Math.round(pdf.getPage(0).getWidth())).toBe(595);
  });

  it("XML sem a NFS-e é recusado", async () => {
    await expect(gerarDanfse("<outro/>")).rejects.toThrow(/incompleto/);
  });
});
