import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../env.js";
import { HttpError } from "../lib/erros.js";

// AES-256-GCM com IV aleatório de 12 bytes. O AAD amarra o texto cifrado à empresa e ao
// campo ("pfx" ou "senha"): trocar um blob de lugar no banco faz a decifragem falhar.

export type Cifrado = { cifrado: Buffer; iv: Buffer; tag: Buffer; keyVersion: number };

function chave(): { k: Buffer; versao: number } {
  const { CERT_ENC_KEY, CERT_ENC_KEY_VERSION } = env();
  const k = Buffer.from(CERT_ENC_KEY ?? "", "base64");
  if (k.byteLength !== 32) throw new HttpError(500, "Servidor sem CERT_ENC_KEY válida (32 bytes em base64).");
  return { k, versao: CERT_ENC_KEY_VERSION };
}

export function cifrar(dado: Uint8Array, aad: string): Cifrado {
  const { k, versao } = chave();
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  c.setAAD(Buffer.from(aad));
  const cifrado = Buffer.concat([c.update(dado), c.final()]);
  return { cifrado, iv, tag: c.getAuthTag(), keyVersion: versao };
}

export function decifrar(x: { cifrado: Uint8Array; iv: Uint8Array; tag: Uint8Array; keyVersion: number }, aad: string): Buffer {
  const { k, versao } = chave();
  if (x.keyVersion !== versao) throw new HttpError(409, "A chave de criptografia do servidor mudou. Envie o certificado de novo.");
  const d = createDecipheriv("aes-256-gcm", k, x.iv);
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(x.tag);
  return Buffer.concat([d.update(x.cifrado), d.final()]);
}

export const aadPfx = (empresaId: string) => `cert:${empresaId}:pfx`;
export const aadSenha = (empresaId: string) => `cert:${empresaId}:senha`;
