import { createHash } from "node:crypto";
import forge from "node-forge";
import { invalido } from "../lib/erros.js";

// Lê o .pfx com node-forge, que entende os PFX antigos (3DES/RC2) que muitos A1 ICP-Brasil
// ainda usam e que o OpenSSL 3 do Node recusa. Por isso o mTLS usa a chave e o certificado
// em PEM extraídos daqui, e não o PFX direto.

export type Pfx = {
  chavePem: string;
  certPem: string;
  cadeiaPem: string[];
  titular: string;
  cnpj: string;
  emissor: string;
  serial: string;
  fingerprint: string;
  validoDe: Date;
  validoAte: Date;
};

const campo = (c: forge.pki.Certificate, onde: "subject" | "issuer", nome: string) =>
  String(c[onde].getField(nome)?.value ?? "");

export function lerPfx(bytes: Uint8Array, senha: string): Pfx {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(Buffer.from(bytes).toString("binary")));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, senha);
  } catch (e) {
    const msg = String((e as Error)?.message ?? "");
    if (/password|MAC/i.test(msg)) throw invalido("Senha incorreta para este certificado.");
    throw invalido("Não consegui ler este arquivo. Confira se é o .pfx ou .p12 do e-CNPJ A1.");
  }

  const bags = (tipo: string) => p12.getBags({ bagType: tipo })[tipo] ?? [];
  const chave = [...bags(forge.pki.oids.pkcs8ShroudedKeyBag!), ...bags(forge.pki.oids.keyBag!)].map((b) => b.key).find(Boolean) as
    | forge.pki.rsa.PrivateKey
    | undefined;
  if (!chave || !("n" in chave)) throw invalido("O arquivo não tem uma chave privada RSA.");

  const certs = bags(forge.pki.oids.certBag!)
    .map((b) => b.cert)
    .filter((c): c is forge.pki.Certificate => Boolean(c));
  // o certificado da empresa é o que casa com a chave privada; o resto é a cadeia da AC
  const meu = certs.find((c) => (c.publicKey as forge.pki.rsa.PublicKey).n?.equals(chave.n));
  if (!meu) throw invalido("O arquivo não tem o certificado correspondente à chave privada.");

  const cn = campo(meu, "subject", "CN");
  const m = /^(.*):([0-9A-Z]{14})$/.exec(cn);
  if (!m) throw invalido("Não encontrei o CNPJ no certificado. Use o e-CNPJ A1 da empresa.");

  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(meu)).getBytes();
  return {
    chavePem: forge.pki.privateKeyToPem(chave),
    certPem: forge.pki.certificateToPem(meu),
    cadeiaPem: certs.filter((c) => c !== meu).map((c) => forge.pki.certificateToPem(c)),
    titular: m[1]!.trim(),
    cnpj: m[2]!,
    emissor: campo(meu, "issuer", "CN"),
    serial: meu.serialNumber,
    fingerprint: createHash("sha256").update(Buffer.from(der, "binary")).digest("hex"),
    validoDe: meu.validity.notBefore,
    validoAte: meu.validity.notAfter,
  };
}
