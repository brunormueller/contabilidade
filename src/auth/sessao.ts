import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { DB } from "../db/client.js";
import { sessoes, usuarios } from "../db/schema.js";
import type { UsuarioSessao } from "../tipos.js";

// Cookie "__Host-sid": HttpOnly, Secure, SameSite=Lax, Path=/, sem Domain.
// No banco fica só o SHA-256 do token; vazar a tabela não entrega sessões válidas.
const NOME = "sid";
const OCIOSA_MS = 8 * 3600e3; // expira após 8 h sem uso
const MAXIMA_MS = 7 * 24 * 3600e3; // e nunca dura mais de 7 dias

const hashToken = (t: string) => createHash("sha256").update(t).digest();

export async function abrirSessao(d: DB, c: Context, usuarioId: string, ip: string | null) {
  const token = randomBytes(32).toString("base64url");
  await d.insert(sessoes).values({
    usuarioId,
    tokenHash: hashToken(token),
    expiraEm: new Date(Date.now() + OCIOSA_MS),
    ip,
    userAgent: (c.req.header("user-agent") ?? "").slice(0, 300),
  });
  setCookie(c, NOME, token, { prefix: "host", httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: MAXIMA_MS / 1000 });
}

export async function lerSessao(d: DB, c: Context): Promise<UsuarioSessao | null> {
  const token = getCookie(c, NOME, "host");
  if (!token) return null;
  const agora = new Date();
  const [r] = await d
    .select({
      sessaoId: sessoes.id,
      criadoEm: sessoes.criadoEm,
      expiraEm: sessoes.expiraEm,
      id: usuarios.id,
      empresaId: usuarios.empresaId,
      nome: usuarios.nome,
      email: usuarios.email,
      perfil: usuarios.perfil,
      temFoto: sql<boolean>`${usuarios.foto} is not null`,
    })
    .from(sessoes)
    .innerJoin(usuarios, eq(usuarios.id, sessoes.usuarioId))
    .where(and(eq(sessoes.tokenHash, hashToken(token)), gt(sessoes.expiraEm, agora), eq(usuarios.ativo, true)));
  if (!r || agora.getTime() - r.criadoEm.getTime() > MAXIMA_MS) return null;

  // renova a janela de inatividade no máximo uma vez a cada 5 min
  if (r.expiraEm.getTime() - agora.getTime() < OCIOSA_MS - 5 * 60e3) {
    await d
      .update(sessoes)
      .set({ ultimoUso: agora, expiraEm: new Date(agora.getTime() + OCIOSA_MS) })
      .where(eq(sessoes.id, r.sessaoId));
  }
  const { criadoEm: _c, expiraEm: _e, ...u } = r;
  return { ...u, temFoto: Boolean(u.temFoto) };
}

export async function fecharSessao(d: DB, c: Context) {
  const token = getCookie(c, NOME, "host");
  if (token) await d.delete(sessoes).where(eq(sessoes.tokenHash, hashToken(token)));
  deleteCookie(c, NOME, { prefix: "host", path: "/", secure: true });
}
