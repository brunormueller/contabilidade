// Gera um "e-CNPJ A1" de mentira, assinado por uma AC de teste, só em memória.
// Nada disso é ICP-Brasil e nada é gravado no repositório.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import forge from "node-forge";

const pemPar = () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    chave: forge.pki.privateKeyFromPem(privateKey) as forge.pki.rsa.PrivateKey,
    pub: forge.pki.publicKeyFromPem(publicKey),
    chavePem: privateKey,
  };
};

let ac: { cert: forge.pki.Certificate; chave: forge.pki.rsa.PrivateKey } | null = null;
function acTeste() {
  if (ac) return ac;
  const k = pemPar();
  const cert = forge.pki.createCertificate();
  cert.publicKey = k.pub;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 86400e3 * 30);
  cert.validity.notAfter = new Date(Date.now() + 86400e3 * 3650);
  const attrs = [{ name: "commonName", value: "AC TESTE NAO ICP" }, { name: "countryName", value: "BR" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: "basicConstraints", cA: true }]);
  cert.sign(k.chave, forge.md.sha256.create());
  ac = { cert, chave: k.chave };
  return ac;
}

export type CertTeste = { pfx: Buffer; senha: string; chavePem: string; certPem: string; acPem: string };

export function gerarPfx(o: { cnpj?: string; razao?: string; senha?: string; desdeDias?: number; ateDias?: number } = {}): CertTeste {
  const { cnpj = "11222333000181", razao = "EMPRESA TESTE LTDA", senha = "senha-do-pfx", desdeDias = -1, ateDias = 365 } = o;
  const a = acTeste();
  const k = pemPar();
  const cert = forge.pki.createCertificate();
  cert.publicKey = k.pub;
  cert.serialNumber = "0" + randomBytes(8).toString("hex");
  cert.validity.notBefore = new Date(Date.now() + desdeDias * 86400e3);
  cert.validity.notAfter = new Date(Date.now() + ateDias * 86400e3);
  cert.setSubject([
    { name: "commonName", value: `${razao}:${cnpj}` },
    { name: "organizationName", value: "ICP-Brasil" },
    { name: "countryName", value: "BR" },
  ]);
  cert.setIssuer(a.cert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, nonRepudiation: true, keyEncipherment: true },
    { name: "extKeyUsage", clientAuth: true, emailProtection: true },
  ]);
  cert.sign(a.chave, forge.md.sha256.create());
  // 3DES: o mesmo tipo de PFX "antigo" que muitas ACs ainda entregam
  const p12 = forge.pkcs12.toPkcs12Asn1(k.chave, [cert, a.cert], senha, { algorithm: "3des" });
  return {
    pfx: Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary"),
    senha,
    chavePem: k.chavePem,
    certPem: forge.pki.certificateToPem(cert),
    acPem: forge.pki.certificateToPem(a.cert),
  };
}
