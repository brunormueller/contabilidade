import { describe, expect, it } from "vitest";
import { cnpjComDV, fmtDoc, normDoc, tipoDoc, validCNPJ, validCPF } from "../src/domain/documentos.js";

describe("CPF e CNPJ", () => {
  it("valida CNPJ numérico com e sem pontuação", () => {
    expect(validCNPJ("11.222.333/0001-81")).toBe(true);
    expect(validCNPJ("11222333000181")).toBe(true);
    expect(validCNPJ("11222333000180")).toBe(false);
    expect(validCNPJ("00000000000000")).toBe(false);
  });

  it("valida CNPJ alfanumérico (exemplo oficial da Receita: 12.ABC.345/01DE-35)", () => {
    expect(validCNPJ("12.ABC.345/01DE-35")).toBe(true);
    expect(validCNPJ("12abc34501de35")).toBe(true);
    expect(validCNPJ("12ABC34501DE36")).toBe(false);
    expect(cnpjComDV("12ABC34501DE")).toBe("12ABC34501DE35");
  });

  it("valida CPF", () => {
    expect(validCPF("529.982.247-25")).toBe(true);
    expect(validCPF("52998224724")).toBe(false);
    expect(validCPF("11111111111")).toBe(false);
  });

  it("identifica o tipo e formata", () => {
    expect(tipoDoc("529.982.247-25")).toBe("CPF");
    expect(tipoDoc("12ABC34501DE35")).toBe("CNPJ");
    expect(tipoDoc("123")).toBeNull();
    expect(fmtDoc("12abc34501de35")).toBe("12.ABC.345/01DE-35");
    expect(normDoc(" 12.abc.345/01de-35 ")).toBe("12ABC34501DE35");
  });
});
