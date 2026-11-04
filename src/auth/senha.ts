import { randomBytes } from "node:crypto";
import { argon2id, argon2Verify } from "hash-wasm";

// argon2id com os parâmetros mínimos recomendados pela OWASP: m = 19 MiB, t = 2, p = 1.
// hash-wasm é WebAssembly puro, sem binário nativo para quebrar no build da Vercel.
const PARAMS = { parallelism: 1, iterations: 2, memorySize: 19_456, hashLength: 32 } as const;

export const SENHA_MIN = 8;
export const SENHA_MAX = 256;

export function hashSenha(senha: string): Promise<string> {
  return argon2id({ ...PARAMS, password: senha.normalize("NFC"), salt: randomBytes(16), outputType: "encoded" });
}

export async function conferirSenha(senha: string, hash: string): Promise<boolean> {
  try {
    return await argon2Verify({ password: senha.normalize("NFC"), hash });
  } catch {
    return false;
  }
}

// Hash descartável para gastar o mesmo tempo quando o e-mail não existe.
let fantasma: Promise<string> | null = null;
export async function gastarTempo(senha: string) {
  fantasma ??= hashSenha(randomBytes(12).toString("hex"));
  await conferirSenha(senha, await fantasma);
}

export function senhaFraca(senha: string): string | null {
  if (senha.length < SENHA_MIN) return `A senha precisa ter pelo menos ${SENHA_MIN} caracteres.`;
  if (senha.length > SENHA_MAX) return `A senha pode ter no máximo ${SENHA_MAX} caracteres.`;
  return null;
}
