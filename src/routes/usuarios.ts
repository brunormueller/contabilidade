import { and, asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { soEmpresa } from "../auth/guard.js";
import { db } from "../db/client.js";
import { sessoes, usuarios } from "../db/schema.js";
import { criarUsuario } from "../domain/usuarios.js";
import { auditar } from "../lib/auditoria.js";
import { invalido, naoEncontrado } from "../lib/erros.js";
import { corpo } from "../lib/http.js";
import type { AppEnv } from "../tipos.js";

export const rotaUsuarios = new Hono<AppEnv>();

rotaUsuarios.get("/", soEmpresa, async (c) => {
  const d = await db();
  const lista = await d
    .select({
      id: usuarios.id,
      nome: usuarios.nome,
      email: usuarios.email,
      perfil: usuarios.perfil,
      temFoto: sql<boolean>`${usuarios.foto} is not null`,
      criadoEm: usuarios.criadoEm,
      ultimoLogin: usuarios.ultimoLogin,
    })
    .from(usuarios)
    .where(and(eq(usuarios.empresaId, c.get("user").empresaId), eq(usuarios.ativo, true)))
    .orderBy(asc(usuarios.criadoEm));
  return c.json(lista.map((u) => ({ ...u, temFoto: Boolean(u.temFoto) })));
});

rotaUsuarios.post("/", async (c) => {
  const b = await corpo(
    c,
    z.object({ nome: z.string().max(120), email: z.string().max(254), perfil: z.enum(["empresa", "contador"]), senha: z.string().max(256) }),
  );
  const d = await db();
  const u = await d.transaction(async (tx) => {
    const novo = await criarUsuario(tx, { ...b, empresaId: c.get("user").empresaId });
    await auditar(tx, c, "criar_usuario", "usuario", novo.id, { email: novo.email, perfil: novo.perfil });
    return novo;
  });
  return c.json(u, 201);
});

rotaUsuarios.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const me = c.get("user");
  if (id === me.id) throw invalido("Você não pode remover o próprio acesso.");
  const d = await db();
  await d.transaction(async (tx) => {
    const r = await tx
      .update(usuarios)
      .set({ ativo: false })
      .where(and(eq(usuarios.id, id), eq(usuarios.empresaId, me.empresaId), eq(usuarios.ativo, true)))
      .returning({ email: usuarios.email });
    if (!r.length) throw naoEncontrado("Usuário");
    await tx.delete(sessoes).where(eq(sessoes.usuarioId, id));
    await auditar(tx, c, "remover_usuario", "usuario", id, { email: r[0]!.email });
  });
  return c.json({ ok: true });
});

rotaUsuarios.get("/:id/foto", async (c) => {
  const d = await db();
  const [u] = await d
    .select({ foto: usuarios.foto })
    .from(usuarios)
    .where(and(eq(usuarios.id, c.req.param("id")), eq(usuarios.empresaId, c.get("user").empresaId)));
  if (!u?.foto) throw naoEncontrado("Foto");
  c.header("Cache-Control", "private, max-age=300");
  return c.body(new Uint8Array(u.foto), 200, { "Content-Type": "image/jpeg" });
});
