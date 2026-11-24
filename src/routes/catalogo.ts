// Planos (mensalidade do cliente) e serviços avulsos (marcados pelo funcionário na visita).
// Remover só desativa: clientes e visitas antigas continuam apontando para o registro.
import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import { clientes, planos, servicos } from "../db/schema.js";
import { paraCentavos, paraReais } from "../domain/dinheiro.js";
import { auditar } from "../lib/auditoria.js";
import { invalido, naoEncontrado } from "../lib/erros.js";
import { corpo, paramId } from "../lib/http.js";
import type { AppEnv } from "../tipos.js";

const nome = (o: string) => z.string().trim().min(1, `Informe o nome do ${o}.`).max(120);
const valor = z.number({ message: "Informe um valor maior que zero." }).positive("Informe um valor maior que zero.").max(1e8);

// ---------- planos ----------

export const rotaPlanos = new Hono<AppEnv>();

const planoParaApi = (p: typeof planos.$inferSelect) => ({ id: p.id, nome: p.nome, descricao: p.descricao, valor: paraReais(p.valor) });
const Plano = z.object({ nome: nome("plano"), descricao: z.string().trim().max(1000).default(""), valor });

rotaPlanos.get("/", async (c) => {
  const d = await db();
  const lista = await d
    .select()
    .from(planos)
    .where(and(eq(planos.empresaId, c.get("user").empresaId), eq(planos.ativo, true)))
    .orderBy(asc(planos.nome));
  return c.json(lista.map(planoParaApi));
});

rotaPlanos.post("/", async (c) => {
  const b = await corpo(c, Plano);
  const d = await db();
  const p = await d.transaction(async (tx) => {
    const [p] = await tx
      .insert(planos)
      .values({ ...b, valor: paraCentavos(b.valor), empresaId: c.get("user").empresaId })
      .returning();
    await auditar(tx, c, "criar_plano", "plano", p!.id, b);
    return p!;
  });
  return c.json(planoParaApi(p), 201);
});

rotaPlanos.put("/:id", async (c) => {
  const id = paramId(c, "Plano");
  const b = await corpo(c, Plano);
  const d = await db();
  const p = await d.transaction(async (tx) => {
    const [p] = await tx
      .update(planos)
      .set({ ...b, valor: paraCentavos(b.valor) })
      .where(and(eq(planos.id, id), eq(planos.empresaId, c.get("user").empresaId), eq(planos.ativo, true)))
      .returning();
    if (!p) throw naoEncontrado("Plano");
    await auditar(tx, c, "editar_plano", "plano", id, b);
    return p;
  });
  return c.json(planoParaApi(p));
});

rotaPlanos.delete("/:id", async (c) => {
  const id = paramId(c, "Plano");
  const { empresaId } = c.get("user");
  const d = await db();
  await d.transaction(async (tx) => {
    const [emUso] = await tx
      .select({ nome: clientes.nome })
      .from(clientes)
      .where(and(eq(clientes.planoId, id), eq(clientes.ativo, true)))
      .limit(1);
    if (emUso) throw invalido(`Este plano ainda está no cadastro de ${emUso.nome}. Troque o plano dos clientes antes de remover.`);
    const r = await tx
      .update(planos)
      .set({ ativo: false })
      .where(and(eq(planos.id, id), eq(planos.empresaId, empresaId), eq(planos.ativo, true)))
      .returning({ nome: planos.nome });
    if (!r.length) throw naoEncontrado("Plano");
    await auditar(tx, c, "remover_plano", "plano", id, { nome: r[0]!.nome });
  });
  return c.json({ ok: true });
});

// ---------- serviços avulsos ----------

export const rotaServicos = new Hono<AppEnv>();

export const servicoParaApi = (s: typeof servicos.$inferSelect) => ({ id: s.id, nome: s.nome, valor: paraReais(s.valor) });
const Servico = z.object({ nome: nome("serviço"), valor });

rotaServicos.get("/", async (c) => {
  const d = await db();
  const lista = await d
    .select()
    .from(servicos)
    .where(and(eq(servicos.empresaId, c.get("user").empresaId), eq(servicos.ativo, true)))
    .orderBy(asc(servicos.nome));
  return c.json(lista.map(servicoParaApi));
});

rotaServicos.post("/", async (c) => {
  const b = await corpo(c, Servico);
  const d = await db();
  const s = await d.transaction(async (tx) => {
    const [s] = await tx
      .insert(servicos)
      .values({ ...b, valor: paraCentavos(b.valor), empresaId: c.get("user").empresaId })
      .returning();
    await auditar(tx, c, "criar_servico", "servico", s!.id, b);
    return s!;
  });
  return c.json(servicoParaApi(s), 201);
});

rotaServicos.put("/:id", async (c) => {
  const id = paramId(c, "Serviço");
  const b = await corpo(c, Servico);
  const d = await db();
  const s = await d.transaction(async (tx) => {
    const [s] = await tx
      .update(servicos)
      .set({ ...b, valor: paraCentavos(b.valor) })
      .where(and(eq(servicos.id, id), eq(servicos.empresaId, c.get("user").empresaId), eq(servicos.ativo, true)))
      .returning();
    if (!s) throw naoEncontrado("Serviço");
    await auditar(tx, c, "editar_servico", "servico", id, b);
    return s;
  });
  return c.json(servicoParaApi(s));
});

rotaServicos.delete("/:id", async (c) => {
  const id = paramId(c, "Serviço");
  const d = await db();
  await d.transaction(async (tx) => {
    const r = await tx
      .update(servicos)
      .set({ ativo: false })
      .where(and(eq(servicos.id, id), eq(servicos.empresaId, c.get("user").empresaId), eq(servicos.ativo, true)))
      .returning({ nome: servicos.nome });
    if (!r.length) throw naoEncontrado("Serviço");
    await auditar(tx, c, "remover_servico", "servico", id, { nome: r[0]!.nome });
  });
  return c.json({ ok: true });
});
