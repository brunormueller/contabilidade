import { eq, sql } from "drizzle-orm";
import { hashSenha, senhaFraca } from "../auth/senha.js";
import type { DB, Tx } from "../db/client.js";
import { usuarios } from "../db/schema.js";
import { invalido } from "../lib/erros.js";

export type Perfil = "empresa" | "contador";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const normEmail = (e: unknown) => String(e ?? "").trim().toLowerCase();
export const emailValido = (e: string) => e.length <= 254 && EMAIL.test(e);

export async function criarUsuario(
  d: DB | Tx,
  u: { empresaId: string; nome: string; email: string; perfil: Perfil; senha: string },
) {
  const nome = u.nome.trim();
  const email = normEmail(u.email);
  if (!nome) throw invalido("Informe o nome.");
  if (nome.length > 120) throw invalido("Nome muito longo.");
  if (!emailValido(email)) throw invalido("Informe um e-mail válido.");
  const fraca = senhaFraca(u.senha);
  if (fraca) throw invalido(fraca);

  const [existe] = await d
    .select({ id: usuarios.id, ativo: usuarios.ativo })
    .from(usuarios)
    .where(sql`lower(${usuarios.email}) = ${email}`);
  if (existe?.ativo) throw invalido("Já existe um usuário com esse e-mail.");

  const dados = { nome, email, perfil: u.perfil, senhaHash: await hashSenha(u.senha) };
  const campos = { id: usuarios.id, nome: usuarios.nome, email: usuarios.email, perfil: usuarios.perfil };
  // acesso removido antes: reativa o mesmo registro para manter o histórico da auditoria
  const [r] = existe
    ? await d.update(usuarios).set({ ...dados, ativo: true, foto: null }).where(eq(usuarios.id, existe.id)).returning(campos)
    : await d.insert(usuarios).values({ empresaId: u.empresaId, ...dados }).returning(campos);
  return r!;
}
