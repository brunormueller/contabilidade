import { and, eq } from "drizzle-orm";
import type { DB, Tx } from "../db/client.js";
import { certificados } from "../db/schema.js";
import { HttpError, invalido } from "../lib/erros.js";
import { aadPfx, aadSenha, cifrar, decifrar } from "./cripto.js";
import { lerPfx, type Pfx } from "./pfx.js";

/** Valida o PFX e grava cifrado como o certificado ativo. Devolve só os metadados. */
export async function guardarCertificado(tx: Tx, a: { empresaId: string; cnpjEmpresa: string; pfx: Uint8Array; senha: string; usuarioId: string }) {
  const info = lerPfx(a.pfx, a.senha);
  if (info.cnpj !== a.cnpjEmpresa)
    throw invalido(`Este certificado é do CNPJ ${info.cnpj}, diferente do cadastrado (${a.cnpjEmpresa}).`);
  const agora = new Date();
  if (info.validoAte < agora) throw invalido("Este certificado está vencido.");
  if (info.validoDe > agora) throw invalido("Este certificado ainda não começou a valer.");

  const pfx = cifrar(a.pfx, aadPfx(a.empresaId));
  const senha = cifrar(Buffer.from(a.senha, "utf8"), aadSenha(a.empresaId));
  await tx
    .update(certificados)
    .set({ ativo: false })
    .where(and(eq(certificados.empresaId, a.empresaId), eq(certificados.ativo, true)));
  const [c] = await tx
    .insert(certificados)
    .values({
      empresaId: a.empresaId,
      pfxCifrado: pfx.cifrado,
      pfxIv: pfx.iv,
      pfxTag: pfx.tag,
      senhaCifrada: senha.cifrado,
      senhaIv: senha.iv,
      senhaTag: senha.tag,
      keyVersion: pfx.keyVersion,
      titular: info.titular,
      cnpj: info.cnpj,
      emissor: info.emissor,
      serial: info.serial,
      fingerprint: info.fingerprint,
      validoDe: info.validoDe,
      validoAte: info.validoAte,
      enviadoPor: a.usuarioId,
    })
    .returning({ id: certificados.id });
  return {
    id: c!.id,
    titular: info.titular,
    cnpj: info.cnpj,
    emissor: info.emissor,
    serial: info.serial,
    validoDe: info.validoDe,
    validoAte: info.validoAte,
    verificadoEm: agora,
  };
}

/** Abre o certificado ativo para assinar e conectar. Fica só em memória, nunca sai do servidor. */
export async function abrirCertificado(d: DB | Tx, empresaId: string): Promise<Pfx> {
  const [c] = await d
    .select()
    .from(certificados)
    .where(and(eq(certificados.empresaId, empresaId), eq(certificados.ativo, true)));
  if (!c) throw new HttpError(409, "Nenhum certificado A1 cadastrado. Envie o certificado em Empresa e certificado.");
  if (c.validoAte < new Date()) throw new HttpError(409, "O certificado A1 está vencido. Envie o certificado renovado.");
  const pfx = decifrar({ cifrado: c.pfxCifrado, iv: c.pfxIv, tag: c.pfxTag, keyVersion: c.keyVersion }, aadPfx(empresaId));
  const senha = decifrar({ cifrado: c.senhaCifrada, iv: c.senhaIv, tag: c.senhaTag, keyVersion: c.keyVersion }, aadSenha(empresaId));
  return lerPfx(pfx, senha.toString("utf8"));
}
