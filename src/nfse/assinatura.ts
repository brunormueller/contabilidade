// XMLDSig da DPS (e, depois, do pedido de evento).
// Do XSD: Signature é irmã logo depois do elemento assinado (TCDPS: infDPS + ds:Signature).
// Do Anexo I: E1228 proíbe prefixo de namespace, então sai <Signature xmlns="...">.
// Sem texto oficial, só o que as implementações publicadas usam: enveloped + C14N inclusiva
// (2001), Reference ao Id do elemento e só o certificado do titular no KeyInfo.
// O manual não diz se é SHA-1 ou SHA-256: NFSE_ASSINATURA escolhe, e o primeiro envio na
// produção restrita confirma (E0714 = assinatura recusada).
import { DOMParser } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";

const C14N = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
const ENVELOPED = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";
export const DSIG = "http://www.w3.org/2000/09/xmldsig#";

export const ALGORITMOS = {
  sha1: { assinatura: "http://www.w3.org/2000/09/xmldsig#rsa-sha1", resumo: "http://www.w3.org/2000/09/xmldsig#sha1" },
  sha256: { assinatura: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256", resumo: "http://www.w3.org/2001/04/xmlenc#sha256" },
} as const;
export type Algoritmo = keyof typeof ALGORITMOS;

export type ElementoAssinado = "infDPS" | "infPedReg";
const caminho = (el: ElementoAssinado) => `//*[local-name(.)='${el}']`;

/** Assina o elemento pelo Id e devolve o XML com a Signature logo depois dele. */
export function assinar(xml: string, elemento: ElementoAssinado, cert: { chavePem: string; certPem: string }, algoritmo: Algoritmo) {
  const alg = ALGORITMOS[algoritmo];
  const sig = new SignedXml({
    privateKey: cert.chavePem,
    publicCert: cert.certPem,
    signatureAlgorithm: alg.assinatura,
    canonicalizationAlgorithm: C14N,
  });
  sig.addReference({ xpath: caminho(elemento), digestAlgorithm: alg.resumo, transforms: [ENVELOPED, C14N] });
  sig.computeSignature(xml, { location: { reference: caminho(elemento), action: "after" } });
  return sig.getSignedXml();
}

/**
 * Confere a assinatura com o certificado esperado (não com o que vem no KeyInfo) e exige que
 * ela cubra o elemento indicado. Serve para conferir o que vamos enviar e o que voltou.
 */
export function conferirAssinatura(xml: string, elemento: ElementoAssinado, certPem: string) {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const assinaturas = doc.getElementsByTagNameNS(DSIG, "Signature");
  const alvo = doc.getElementsByTagNameNS("*", elemento)[0];
  if (assinaturas.length !== 1 || !alvo) return false;
  const sig = new SignedXml({ publicCert: certPem });
  sig.loadSignature(assinaturas[0]!);
  try {
    if (!sig.checkSignature(xml)) return false;
  } catch {
    return false;
  }
  const id = alvo.getAttribute("Id");
  return !!id && sig.getSignedReferences().length === 1 && sig.getReferences().every((r) => r.uri === `#${id}`);
}
