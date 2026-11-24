// Rotas: qual funcionário atende quais clientes, em que ordem e em que dias da semana.
import { and, asc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db, type Tx } from "../db/client.js";
import { clientes, rotaParadas, rotas, usuarios } from "../db/schema.js";
import { auditar } from "../lib/auditoria.js";
import { invalido, naoEncontrado } from "../lib/erros.js";
import { corpo, paramId } from "../lib/http.js";
import type { AppEnv } from "../tipos.js";

export const rotaRotas = new Hono<AppEnv>();

const Rota = z.object({
  nome: z.string().trim().min(1, "Informe o nome da rota.").max(80, "Nome passa de 80 caracteres."),
  funcionarioId: z.uuid({ message: "Escolha o funcionário." }),
  dias: z
    .array(z.number().int().min(0).max(6), { message: "Dias da semana inválidos." })
    .min(1, "Escolha pelo menos um dia da semana.")
    .max(7),
  clientes: z.array(z.uuid({ message: "Cliente inválido." })).max(500, "Rota com clientes demais."),
});

rotaRotas.get("/", async (c) => {
  const { empresaId } = c.get("user");
  const d = await db();
  const lista = await d
    .select({
      id: rotas.id,
      nome: rotas.nome,
      dias: rotas.dias,
      funcionarioId: rotas.funcionarioId,
      funcionarioNome: usuarios.nome,
      funcionarioAtivo: usuarios.ativo,
    })
    .from(rotas)
    .innerJoin(usuarios, eq(usuarios.id, rotas.funcionarioId))
    .where(and(eq(rotas.empresaId, empresaId), eq(rotas.ativo, true)))
    .orderBy(asc(rotas.nome));
  const paradas = lista.length
    ? await d
        .select({ rotaId: rotaParadas.rotaId, id: clientes.id, nome: clientes.nome, endereco: clientes.endereco })
        .from(rotaParadas)
        .innerJoin(clientes, eq(clientes.id, rotaParadas.clienteId))
        .where(inArray(rotaParadas.rotaId, lista.map((r) => r.id)))
        .orderBy(asc(rotaParadas.ordem))
    : [];
  const funcionarios = await d
    .select({ id: usuarios.id, nome: usuarios.nome })
    .from(usuarios)
    .where(and(eq(usuarios.empresaId, empresaId), eq(usuarios.ativo, true), eq(usuarios.perfil, "funcionario")))
    .orderBy(asc(usuarios.nome));
  return c.json({
    rotas: lista.map((r) => ({
      ...r,
      dias: [...r.dias].sort(),
      clientes: paradas.filter((p) => p.rotaId === r.id).map(({ rotaId: _r, ...p }) => p),
    })),
    funcionarios,
  });
});

async function validar(tx: Tx, empresaId: string, b: z.infer<typeof Rota>) {
  const [f] = await tx
    .select({ id: usuarios.id })
    .from(usuarios)
    .where(and(eq(usuarios.id, b.funcionarioId), eq(usuarios.empresaId, empresaId), eq(usuarios.ativo, true), eq(usuarios.perfil, "funcionario")));
  if (!f) throw invalido("Funcionário inválido ou sem acesso.");
  if (new Set(b.clientes).size !== b.clientes.length) throw invalido("Um cliente aparece duas vezes na rota.");
  if (b.clientes.length) {
    const ok = await tx
      .select({ id: clientes.id })
      .from(clientes)
      .where(and(inArray(clientes.id, b.clientes), eq(clientes.empresaId, empresaId), eq(clientes.ativo, true)));
    if (ok.length !== b.clientes.length) throw invalido("Algum cliente da rota foi removido. Atualize a tela.");
  }
  return { nome: b.nome, funcionarioId: b.funcionarioId, dias: [...new Set(b.dias)].sort() };
}

async function gravarParadas(tx: Tx, rotaId: string, ids: string[]) {
  await tx.delete(rotaParadas).where(eq(rotaParadas.rotaId, rotaId));
  if (ids.length) await tx.insert(rotaParadas).values(ids.map((clienteId, i) => ({ rotaId, clienteId, ordem: i + 1 })));
}

rotaRotas.post("/", async (c) => {
  const b = await corpo(c, Rota);
  const { empresaId } = c.get("user");
  const d = await db();
  const id = await d.transaction(async (tx) => {
    const v = await validar(tx, empresaId, b);
    const [r] = await tx
      .insert(rotas)
      .values({ ...v, empresaId })
      .returning({ id: rotas.id });
    await gravarParadas(tx, r!.id, b.clientes);
    await auditar(tx, c, "criar_rota", "rota", r!.id, { ...v, clientes: b.clientes });
    return r!.id;
  });
  return c.json({ id }, 201);
});

rotaRotas.put("/:id", async (c) => {
  const id = paramId(c, "Rota");
  const b = await corpo(c, Rota);
  const { empresaId } = c.get("user");
  const d = await db();
  await d.transaction(async (tx) => {
    const v = await validar(tx, empresaId, b);
    const up = await tx
      .update(rotas)
      .set(v)
      .where(and(eq(rotas.id, id), eq(rotas.empresaId, empresaId), eq(rotas.ativo, true)))
      .returning({ id: rotas.id });
    if (!up.length) throw naoEncontrado("Rota");
    await gravarParadas(tx, id, b.clientes);
    await auditar(tx, c, "editar_rota", "rota", id, { ...v, clientes: b.clientes });
  });
  return c.json({ id });
});

// Desativa: as visitas já registradas continuam apontando para ela.
rotaRotas.delete("/:id", async (c) => {
  const id = paramId(c, "Rota");
  const d = await db();
  await d.transaction(async (tx) => {
    const r = await tx
      .update(rotas)
      .set({ ativo: false })
      .where(and(eq(rotas.id, id), eq(rotas.empresaId, c.get("user").empresaId), eq(rotas.ativo, true)))
      .returning({ nome: rotas.nome });
    if (!r.length) throw naoEncontrado("Rota");
    await auditar(tx, c, "remover_rota", "rota", id, { nome: r[0]!.nome });
  });
  return c.json({ ok: true });
});
