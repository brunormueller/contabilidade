import { describe, expect, it } from "vitest";
import { ConfigIncompleta, dhBrasilia, idDps, montarDps, type EmpresaDps, type NotaDps } from "../src/nfse/dps.js";
import { validarXsd } from "../src/nfse/xsd.js";

// Códigos de IBS/CBS fictícios, só com o formato do XSD. Os reais vêm do contador.
const IBS = { cst: "000", cClassTrib: "000001", cIndOp: "000000", indDest: "0" as const };

const empresa: EmpresaDps = { cnpj: "11222333000181", im: "12345", ibge: "4208906", cLocPrestacao: "", pTotTribSN: 600, ibsCbs: IBS };
const nota: NotaDps = {
  serie: "900", nDps: 42, competencia: "2026-11-03", tomadorDoc: "11444777000161", tomadorNome: "Metalúrgica Itapocu Ltda",
  tomadorEmail: "financeiro@itapocu.com.br", descricao: "Manutenção mensal", cTribNac: "010701", cNbs: "115021000",
  valor: 1200_50, issRetido: false, aliqIss: null, vInssRet: 0,
};
const dhEmi = new Date("2026-11-03T13:45:10.123Z");

async function valida(xml: string, amb: "producao" | "producao_restrita") {
  const r = await validarXsd(xml, amb);
  if (!r.valido) throw new Error(r.erros.join("\n"));
  return r;
}

describe("Id e datas", () => {
  it("Id da DPS tem 45 posições no padrão TSIdDPS", () => {
    const id = idDps("4208906", "11222333000181", "900", 42);
    expect(id).toBe("DPS420890621122233300018100900000000000000042");
    expect(id).toHaveLength(45);
    expect(id).toMatch(/^DPS[0-9]{7}(1[0-9]{14}|2[0-9A-Z]{14})[0-9]{20}$/);
    expect(idDps("4208906", "12ABC34501DE35", "1", 1)).toMatch(/^DPS[0-9]{7}2[0-9A-Z]{14}[0-9]{20}$/);
  });

  it("dhEmi no horário de Brasília, sem milissegundos", () => {
    expect(dhBrasilia(dhEmi)).toBe("2026-11-03T10:45:10-03:00");
  });
});

describe("DPS contra o XSD oficial", () => {
  it("produção restrita (NT 009): tomador CNPJ, sem retenção, com IBS/CBS", async () => {
    const { xml } = montarDps({ empresa, nota, ambiente: "producao_restrita", dhEmi });
    await valida(xml, "producao_restrita");
    expect(xml).toContain("<tpAmb>2</tpAmb>");
    expect(xml).toContain("<finNFSe>0</finNFSe>");
    expect(xml).toContain("<tpRetISSQN>1</tpRetISSQN>");
    expect(xml).not.toContain("<pAliq>"); // E0625
    expect(xml).not.toContain("indTotTrib"); // E0712
    expect(xml).toContain("<pTotTribSN>6.00</pTotTribSN>");
    expect(xml).toMatch(/<prest><CNPJ>11222333000181<\/CNPJ><IM>12345<\/IM><regTrib>/); // E0121/E0128: sem nome nem endereço
    expect(xml).toContain("<cNBS>115021000</cNBS><xDescServ>");
  });

  it("produção restrita: tomador CPF, ISS e INSS retidos", async () => {
    const { xml } = montarDps({
      empresa, ambiente: "producao_restrita", dhEmi,
      nota: { ...nota, tomadorDoc: "52998224725", tomadorEmail: "", issRetido: true, aliqIss: 250, vInssRet: 132_00 },
    });
    await valida(xml, "producao_restrita");
    expect(xml).toContain("<CPF>52998224725</CPF>");
    expect(xml).toContain("<tpRetISSQN>2</tpRetISSQN><pAliq>2.50</pAliq>");
    expect(xml).toContain("<tribFed><vRetCP>132.00</vRetCP></tribFed>");
    expect(xml).not.toContain("<email>");
  });

  it("produção (layout atual): sem finNFSe, descrição antes da NBS, IBS/CBS opcional", async () => {
    const sem = montarDps({ empresa: { ...empresa, ibsCbs: null }, nota, ambiente: "producao", dhEmi }).xml;
    await valida(sem, "producao");
    expect(sem).toContain("<tpAmb>1</tpAmb>");
    expect(sem).not.toContain("finNFSe");
    expect(sem).toContain("<xDescServ>Manutenção mensal</xDescServ><cNBS>");
    expect(sem).not.toContain("IBSCBS");
    const com = montarDps({ empresa, nota, ambiente: "producao", dhEmi }).xml;
    await valida(com, "producao");
    expect(com).toContain("<IBSCBS><finNFSe>0</finNFSe>");
    expect(com).toContain("<trib><gIBSCBS><CST>000</CST>");
  });

  it("produção exige cIndOp no grupo IBS/CBS", () => {
    const e = { ...empresa, ibsCbs: { ...IBS, cIndOp: undefined } };
    expect(() => montarDps({ empresa: e, nota, ambiente: "producao", dhEmi })).toThrow(/cIndOp/);
  });

  it("os leiautes são diferentes: DPS da restrita não passa no XSD de produção", async () => {
    const { xml } = montarDps({ empresa, nota, ambiente: "producao_restrita", dhEmi });
    expect((await validarXsd(xml, "producao")).valido).toBe(false);
  });

  it("escapa texto e remove caractere de controle", async () => {
    const { xml } = montarDps({ empresa, ambiente: "producao_restrita", dhEmi, nota: { ...nota, descricao: 'Peças & "serviço" <urgente>\u0007', tomadorNome: "A&B Ltda" } });
    await valida(xml, "producao_restrita");
    expect(xml).toContain("Peças &amp; &quot;serviço&quot; &lt;urgente&gt;</xDescServ>");
    expect(xml).toContain("<xNome>A&amp;B Ltda</xNome>");
  });

  it("município de prestação configurável", async () => {
    const { xml } = montarDps({ empresa: { ...empresa, cLocPrestacao: "4209102" }, nota, ambiente: "producao_restrita", dhEmi });
    await valida(xml, "producao_restrita");
    expect(xml).toContain("<cLocPrestacao>4209102</cLocPrestacao>");
    expect(xml).toContain("<cLocEmi>4208906</cLocEmi>");
  });

  it("XSD pega erro de leiaute com mensagem legível", async () => {
    const { xml } = montarDps({ empresa, nota, ambiente: "producao_restrita", dhEmi });
    const r = await validarXsd(xml.replace("<cTribNac>010701</cTribNac>", "<cTribNac>0107</cTribNac>"), "producao_restrita");
    expect(r.valido).toBe(false);
    expect(r.erros.join(" ")).toMatch(/cTribNac/);
  });
});

describe("configuração incompleta trava a emissão", () => {
  it("sem pTotTribSN", () => {
    expect(() => montarDps({ empresa: { ...empresa, pTotTribSN: null }, nota, ambiente: "producao", dhEmi })).toThrow(ConfigIncompleta);
  });

  it("sem IBS/CBS na restrita a partir de 01/10/2026 (E0855); antes disso, passa", async () => {
    const e = { ...empresa, ibsCbs: null };
    expect(() => montarDps({ empresa: e, nota, ambiente: "producao_restrita", dhEmi })).toThrow(/E0855/);
    const antes = montarDps({ empresa: e, nota: { ...nota, competencia: "2026-09-30" }, ambiente: "producao_restrita", dhEmi });
    await valida(antes.xml, "producao_restrita");
  });

  it("com IBS/CBS e sem NBS", () => {
    expect(() => montarDps({ empresa, nota: { ...nota, cNbs: "" }, ambiente: "producao", dhEmi })).toThrow(/NBS/);
  });
});
