import { createHash, verify } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { lerPfx } from "../src/cert/pfx.js";
import { assinar, conferirAssinatura } from "../src/nfse/assinatura.js";
import { montarDps, NS, type EmpresaDps, type NotaDps } from "../src/nfse/dps.js";
import { validarXsd } from "../src/nfse/xsd.js";
import { gerarPfx, type CertTeste } from "./certTeste.js";

const IBS = { cst: "000", cClassTrib: "000001", cIndOp: "000000", indDest: "0" as const };
const empresa: EmpresaDps = { cnpj: "11222333000181", im: "", ibge: "4208906", cLocPrestacao: "", pTotTribSN: 600, ibsCbs: IBS };
const nota: NotaDps = {
  serie: "900", nDps: 7, competencia: "2026-11-03", tomadorDoc: "11444777000161", tomadorNome: "Metalúrgica Itapocu Ltda",
  tomadorEmail: "", descricao: "Manutenção mensal", cTribNac: "010701", cNbs: "115021000",
  valor: 1200_50, issRetido: false, aliqIss: null, vInssRet: 0,
};
const dhEmi = new Date("2026-11-03T13:45:10Z");

let teste: CertTeste;
let cert: { chavePem: string; certPem: string };
beforeAll(() => {
  teste = gerarPfx({ cnpj: empresa.cnpj });
  // o caminho real: a chave e o certificado saem do PFX, como no envio
  cert = lerPfx(teste.pfx, teste.senha);
});

const dps = (amb: "producao" | "producao_restrita" = "producao_restrita") => montarDps({ empresa, nota, ambiente: amb, dhEmi });
const entre = (xml: string, a: string, b: string) => xml.slice(xml.indexOf(a) + a.length, xml.indexOf(b));
const b64 = (pem: string) => pem.replace(/-----[^-]+-----|\s/g, "");

describe("assinatura da DPS", () => {
  it("Signature sem prefixo, irmã depois do infDPS, referenciando o Id", () => {
    const { id, xml } = dps();
    const s = assinar(xml, "infDPS", cert, "sha256");
    expect(s).toMatch(/<\/infDPS><Signature xmlns="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#"><SignedInfo>/);
    expect(s.endsWith("</Signature></DPS>")).toBe(true);
    expect(s).toContain(`<Reference URI="#${id}">`);
    expect(s).toContain('<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/><Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>');
    expect(s).not.toMatch(/<ds:|xmlns:ds/); // E1228
    // KeyInfo só com o certificado do titular, sem a cadeia
    expect(entre(s, "<X509Data>", "</X509Data>")).toBe(`<X509Certificate>${b64(cert.certPem)}</X509Certificate>`);
  });

  it.each(["producao_restrita", "producao"] as const)("DPS assinada passa no XSD de %s", async (amb) => {
    const s = assinar(dps(amb).xml, "infDPS", cert, "sha256");
    const r = await validarXsd(s, amb);
    expect(r.erros).toEqual([]);
  });

  it.each(["sha256", "sha1"] as const)("%s: confere com o certificado da empresa", (alg) => {
    const s = assinar(dps().xml, "infDPS", cert, alg);
    expect(s).toContain(alg === "sha1" ? "xmldsig#rsa-sha1" : "xmldsig-more#rsa-sha256");
    expect(conferirAssinatura(s, "infDPS", cert.certPem)).toBe(true);
  });

  it("conferência independente do xml-crypto: resumo e assinatura com node:crypto", () => {
    const { id, xml } = dps();
    const s = assinar(xml, "infDPS", cert, "sha256");
    // C14N inclusiva do infDPS: herda o xmlns do DPS. Nosso XML não tem elemento vazio,
    // comentário nem aspas no texto, então a forma canônica é o próprio texto com o xmlns.
    expect(xml).not.toMatch(/\/>|&quot;|<!--/);
    const infDps = `<infDPS xmlns="${NS}" Id="${id}">` + entre(xml, `<infDPS Id="${id}">`, "</infDPS>") + "</infDPS>";
    const resumo = createHash("sha256").update(infDps).digest("base64");
    expect(entre(s, "<DigestValue>", "</DigestValue>")).toBe(resumo);

    const signedInfo = ("<SignedInfo>" + entre(s, "<SignedInfo>", "</SignedInfo>") + "</SignedInfo>")
      .replace("<SignedInfo>", '<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">')
      .replace(/<(\w+)([^<>]*)\/>/g, "<$1$2></$1>");
    const valor = Buffer.from(entre(s, "<SignatureValue>", "</SignatureValue>"), "base64");
    expect(verify("sha256", Buffer.from(signedInfo), cert.certPem, valor)).toBe(true);
  });

  it("qualquer alteração depois de assinar quebra a assinatura", () => {
    const s = assinar(dps().xml, "infDPS", cert, "sha256");
    expect(conferirAssinatura(s.replace("<vServ>1200.50</vServ>", "<vServ>12.50</vServ>"), "infDPS", cert.certPem)).toBe(false);
    expect(conferirAssinatura(s.replace("<nDPS>7</nDPS>", "<nDPS>8</nDPS>"), "infDPS", cert.certPem)).toBe(false);
    const valor = entre(s, "<SignatureValue>", "</SignatureValue>");
    const trocado = (valor[0] === "A" ? "B" : "A") + valor.slice(1);
    expect(conferirAssinatura(s.replace(valor, trocado), "infDPS", cert.certPem)).toBe(false);
  });

  it("não confere com outro certificado, nem com XML sem assinatura ou com duas", () => {
    const s = assinar(dps().xml, "infDPS", cert, "sha256");
    const outro = gerarPfx({ cnpj: empresa.cnpj });
    expect(conferirAssinatura(s, "infDPS", outro.certPem)).toBe(false);
    expect(conferirAssinatura(dps().xml, "infDPS", cert.certPem)).toBe(false);
    const sig = s.slice(s.indexOf("<Signature"), s.indexOf("</DPS>"));
    expect(conferirAssinatura(s.replace("</DPS>", sig + "</DPS>"), "infDPS", cert.certPem)).toBe(false);
  });
});
