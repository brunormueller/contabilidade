import { and, eq, gt, ne, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { conferirSenha, gastarTempo, hashSenha, senhaFraca } from "../auth/senha.js";
import { abrirSessao, fecharSessao } from "../auth/sessao.js";
import { db } from "../db/client.js";
import { sessoes, tentativasLogin, usuarios } from "../db/schema.js";
import { normEmail } from "../domain/usuarios.js";
import { env } from "../env.js";
import { auditar } from "../lib/auditoria.js";
import { HttpError, invalido } from "../lib/erros.js";
import { corpo, ipDe } from "../lib/http.js";
import type { AppEnv } from "../tipos.js";

const JANELA_MS = 15 * 60e3;
const MAX_POR_EMAIL = 5;
const MAX_POR_IP = 20;

export const auth = new Hono<AppEnv>();

auth.post("/login", async (c) => {
  const b = await corpo(c, z.object({ email: z.string().max(254), senha: z.string().max(256) }));
  const email = normEmail(b.email);
  const ip = ipDe(c);
  const d = await db();

  const desde = new Date(Date.now() - JANELA_MS);
  const [falhas] = await d
    .select({
      porEmail: sql<number>`count(*) filter (where ${tentativasLogin.email} = ${email})`,
      porIp: sql<number>`count(*) filter (where ${tentativasLogin.ip} = ${ip})`,
    })
    .from(tentativasLogin)
    .where(and(gt(tentativasLogin.criadoEm, desde), or(eq(tentativasLogin.email, email), ip ? eq(tentativasLogin.ip, ip) : sql`false`)));
  if (Number(falhas?.porEmail) >= MAX_POR_EMAIL || Number(falhas?.porIp) >= MAX_POR_IP)
    throw new HttpError(429, "Muitas tentativas. Aguarde 15 minutos e tente de novo.");

  const [u] = await d
    .select()
    .from(usuarios)
    .where(and(sql`lower(${usuarios.email}) = ${email}`, eq(usuarios.ativo, true)));
  const ok = u ? await conferirSenha(b.senha, u.senhaHash) : (await gastarTempo(b.senha), false);
  if (!u || !ok) {
    await d.insert(tentativasLogin).values({ email, ip });
    throw new HttpError(401, "E-mail ou senha incorretos.");
  }

  await d.delete(tentativasLogin).where(eq(tentativasLogin.email, email));
  await d.update(usuarios).set({ ultimoLogin: new Date() }).where(eq(usuarios.id, u.id));
  await abrirSessao(d, c, u.id, ip);
  return c.json({ usuario: { id: u.id, nome: u.nome, email: u.email, perfil: u.perfil, temFoto: u.foto != null } });
});

auth.post("/logout", async (c) => {
  await fecharSessao(await db(), c);
  return c.json({ ok: true });
});

auth.get("/me", (c) => {
  const { sessaoId: _s, ...u } = c.get("user");
  return c.json({ usuario: u, ambiente: env().NFSE_AMBIENTE });
});

auth.put("/senha", async (c) => {
  const b = await corpo(c, z.object({ atual: z.string().max(256), nova: z.string().max(256) }));
  const fraca = senhaFraca(b.nova);
  if (fraca) throw invalido(fraca);
  const me = c.get("user");
  const d = await db();
  const [u] = await d.select().from(usuarios).where(eq(usuarios.id, me.id));
  if (!u || !(await conferirSenha(b.atual, u.senhaHash))) throw invalido("Senha atual incorreta.");
  await d.update(usuarios).set({ senhaHash: await hashSenha(b.nova) }).where(eq(usuarios.id, me.id));
  // derruba as outras sessões da pessoa; a atual continua
  await d.delete(sessoes).where(and(eq(sessoes.usuarioId, me.id), ne(sessoes.id, me.sessaoId)));
  await auditar(d, c, "trocar_senha", "usuario", me.id);
  return c.json({ ok: true });
});
