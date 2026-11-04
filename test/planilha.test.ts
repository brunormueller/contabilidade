import { describe, expect, it } from "vitest";
import { mapearColunas, parseData, parsePct, parseSimNao, parseValor, validarLinhas, type Padroes } from "../src/domain/planilha.js";
import { cenarioBase } from "./helpers.js";
import { comoContador, comoEmpresa } from "./cliente.js";

const HOJE = "2026-11-03";
const P: Padroes = { cServPadrao: "010701", cNBSPadrao: "115021000", aliqIss: 2, vencDias: 10 };
const ok = {
  tomador_documento: "11.444.777/0001-61",
  tomador_nome: "Metalúrgica Itapocu Ltda",
  tomador_email: "financeiro@itapocu.com.br",
  descricao: "Serviço de manutenção mensal de sistemas",
  valor: "1.200,50",
  codigo_servico: "01.07.01",
  codigo_nbs: "1.1502.10.00",
  iss_retido: "Não",
  aliquota_iss: "",
  valor_inss_retido: "",
  competencia: "",
  vencimento: "",
};
const validar = (linhas: Record<string, unknown>[], p = P) => validarLinhas(linhas, p, HOJE);
const erros = (o: Record<string, unknown>) => validar([{ ...ok, ...o }]).rows[0]!.errors;

describe("conversões", () => {
  it("valor em formato brasileiro, americano e número", () => {
    expect(parseValor("1.200,50")).toBe(1200.5);
    expect(parseValor("R$ 850,00")).toBe(850);
    expect(parseValor("1200.5")).toBe(1200.5);
    expect(parseValor(99.9)).toBe(99.9);
    expect(parseValor("12abc")).toBeNaN();
    expect(parseValor("")).toBeNaN();
  });

  it("sim/não, porcentagem e datas", () => {
    expect([parseSimNao("Sim"), parseSimNao("não"), parseSimNao(""), parseSimNao("talvez")]).toEqual([true, false, false, null]);
    expect([parsePct("2,5%"), parsePct(0.025), parsePct(3), parsePct("")]).toEqual([2.5, 2.5, 3, null]);
    expect(parseData("01/11/2026")).toBe("2026-11-01");
    expect(parseData("1/11/26")).toBe("2026-11-01");
    expect(parseData("11/2026")).toBe("2026-11-01");
    expect(parseData("2026-11")).toBe("2026-11-01");
    expect(parseData(46327)).toBe("2026-11-01"); // serial do Excel (46023 = 01/01/2026)
    expect(parseData("31/02/2026")).toBe("invalida");
    expect(parseData("amanhã")).toBe("invalida");
  });

  it("reconhece nomes parecidos de coluna, sem acento e sem caixa", () => {
    expect(mapearColunas(["CNPJ", "Cliente", "Descrição do serviço", "Valor do Serviço", "Retenção de ISS"])).toEqual({
      doc: "CNPJ", nome: "Cliente", descricao: "Descrição do serviço", valor: "Valor do Serviço", issRet: "Retenção de ISS",
    });
  });
});

describe("validarLinhas", () => {
  it("linha boa passa, com padrões da empresa e datas padrão", () => {
    const { rows, faltando } = validar([{ ...ok, codigo_servico: "", codigo_nbs: "" }]);
    expect(faltando).toEqual([]);
    expect(rows[0]).toMatchObject({ i: 2, doc: "11444777000161", valor: 1200.5, cServ: "010701", nbs: "115021000", vLiq: 1200.5, competencia: HOJE, vencimento: "2026-11-13", errors: [] });
  });

  it("aponta colunas obrigatórias que faltam e ignora linha vazia", () => {
    const r = validar([{ cliente: "A", total: "1" }, { cliente: "", total: "" }]);
    expect(r.faltando).toEqual(["CPF/CNPJ do tomador", "descrição"]);
    expect(r.rows).toHaveLength(1);
  });

  it("ISS retido usa a alíquota da linha ou a padrão e calcula o líquido em centavos", () => {
    const [a, b] = validar([
      { ...ok, valor: "1025,00", iss_retido: "Sim", aliquota_iss: "2,5" },
      { ...ok, valor: "1200,00", iss_retido: "Sim", valor_inss_retido: "132,00" },
    ]).rows;
    expect(a).toMatchObject({ aliqIss: 2.5, vIssRet: 25.63, vLiq: 999.37, errors: [] });
    expect(b).toMatchObject({ aliqIss: 2, vIssRet: 24, vInssRet: 132, vLiq: 1044, errors: [] });
  });

  it.each([
    [{ tomador_documento: "12.345.678/0001-00" }, "CPF ou CNPJ do tomador inválido"],
    [{ tomador_nome: " " }, "Nome do tomador vazio"],
    [{ tomador_email: "sem-arroba" }, "E-mail inválido"],
    [{ descricao: "" }, "Descrição do serviço vazia"],
    [{ valor: "0" }, "Valor deve ser maior que zero"],
    [{ codigo_servico: "0107" }, "Código de serviço precisa ter 6 dígitos (ex.: 01.07.01)"],
    [{ codigo_nbs: "1150" }, "Código NBS precisa ter 9 dígitos (ex.: 1.1502.10.00)"],
    [{ iss_retido: "talvez" }, 'ISS retido deve ser "Sim" ou "Não"'],
    [{ iss_retido: "Sim", aliquota_iss: "6" }, "Alíquota do ISS retido deve ficar entre 1,8% e 5%"],
    [{ iss_retido: "Sim", aliquota_iss: "1,5" }, "Alíquota do ISS retido deve ficar entre 1,8% e 5%"],
    [{ valor_inss_retido: "-1" }, "Valor do INSS retido inválido"],
    [{ valor: "100", valor_inss_retido: "100" }, "Retenções iguais ou maiores que o valor do serviço"],
    [{ competencia: "ontem" }, "Competência em formato desconhecido"],
    [{ vencimento: "32/12/2026" }, "Vencimento em formato desconhecido"],
    [{ descricao: "x".repeat(2001) }, "Descrição passa de 2000 caracteres"],
  ])("%o => %s", (o, msg) => {
    expect(erros(o)).toContain(msg);
  });

  it("ISS retido sem alíquota em lugar nenhum é erro", () => {
    const r = validar([{ ...ok, iss_retido: "Sim" }], { ...P, aliqIss: null }).rows[0]!;
    expect(r.errors).toContain("Informe a alíquota do ISS retido");
  });

  it("regras do Anexo I: competência futura, tomador = empresa, NBS com IBS/CBS", () => {
    const p = { ...P, cnpjEmpresa: "11444777000161", levaIbsCbs: (c: string) => c >= "2026-10-01" };
    const [r] = validar([{ ...ok, competencia: "04/11/2026", codigo_nbs: "" }], { ...p, cNBSPadrao: "" }).rows;
    expect(r!.errors).toEqual(
      expect.arrayContaining(["Competência não pode ser posterior à data de emissão", "O tomador não pode ser a própria empresa", "Código NBS é obrigatório quando a nota leva IBS/CBS"]),
    );
    expect(validar([{ ...ok, competencia: "01/09/2026", codigo_nbs: "" }], { ...P, cNBSPadrao: "", levaIbsCbs: p.levaIbsCbs }).rows[0]!.errors).toEqual([]);
  });

  it("aceita tomador CPF e CNPJ alfanumérico", () => {
    expect(erros({ tomador_documento: "529.982.247-25" })).toEqual([]);
    expect(erros({ tomador_documento: "12.ABC.345/01DE-35" })).toEqual([]);
  });
});

describe("POST /api/lotes/validar", () => {
  it("usa os padrões cadastrados da empresa; contador não pode", async () => {
    await cenarioBase();
    const e = await comoEmpresa();
    await e.put("/api/empresa", { razao: "X", cnpj: "11222333000181", cServPadrao: "17.19.01", cNBSPadrao: "", aliqIss: 3, vencDias: 5, serie: "900", proxDPS: 1 });
    const r = await e.post("/api/lotes/validar", { linhas: [{ ...ok, codigo_servico: "", iss_retido: "Sim" }] });
    expect(r.status).toBe(200);
    const b = (await r.json()) as { rows: { cServ: string; aliqIss: number; errors: string[] }[] };
    expect(b.rows[0]).toMatchObject({ cServ: "171901", aliqIss: 3, errors: [] });
    expect((await (await comoContador()).post("/api/lotes/validar", { linhas: [ok] })).status).toBe(403);
  });

  it("recusa mais de 500 linhas", async () => {
    await cenarioBase();
    const r = await (await comoEmpresa()).post("/api/lotes/validar", { linhas: Array(501).fill(ok) });
    expect(r.status).toBe(400);
  });
});
