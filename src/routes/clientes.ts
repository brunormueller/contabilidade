import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db, type DB, type Tx } from "../db/client.js";
import { clientes, planos, rotaParadas } from "../db/schema.js";
import { paraReais } from "../domain/dinheiro.js";
import { normDoc, tipoDoc } from "../domain/documentos.js";
import { carregarEmpresa } from "../domain/empresa.js";
import { emailValido } from "../domain/usuarios.js";
import { auditar } from "../lib/auditoria.js";
import { invalido, naoEncontrado } from "../lib/erros.js";
import { corpo, paramId } from "../lib/http.js";
import type { AppEnv } from "../tipos.js";

export const rotaClientes = new Hono<AppEnv>();

// limites iguais aos da planilha: o cadastro vira tomador da nota sem surpresa
const Cliente = z.object({
  nome: z.string().trim().min(1, "Informe o nome do cliente.").max(300, "Nome passa de 300 caracteres."),
  doc: z.string().max(30),
  email: z.string().trim().max(80, "E-mail passa de 80 caracteres.").default(""),
  telefone: z.string().trim().max(20, "Telefone passa de 20 caracteres.").default(""),
  endereco: z.string().trim().max(300, "Endereço passa de 300 caracteres.").default(""),
  planoId: z.uuid({ message: "Plano inválido." }).nullable().default(null),
});

const campos = {
  id: clientes.id,
  nome: clientes.nome,
  doc: clientes.doc,
  email: clientes.email,
  telefone: clientes.telefone,
  endereco: clientes.endereco,
  planoId: clientes.planoId,
  planoNome: planos.nome,
  planoValor: planos.valor,
};

async function listar(d: DB | Tx, empresaId: string, id?: string) {
  const lista = await d
    .select(campos)
    .from(clientes)
    .leftJoin(planos, eq(planos.id, clientes.planoId))
    .where(and(eq(clientes.empresaId, empresaId), eq(clientes.ativo, true), id ? eq(clientes.id, id) : undefined))
    .orderBy(asc(clientes.nome));
  return lista.map((l) => ({ ...l, planoValor: l.planoValor == null ? null : paraReais(l.planoValor) }));
}

async function validar(tx: Tx, empresaId: string, b: z.infer<typeof Cliente>) {
  const doc = normDoc(b.doc);
  if (!tipoDoc(doc)) throw invalido("CPF ou CNPJ inválido.");
  if (doc === (await carregarEmpresa(tx, empresaId)).cnpj) throw invalido("O cliente não pode ser a própria empresa.");
  if (b.email && !emailValido(b.email)) throw invalido("Informe um e-mail válido.");
  if (b.planoId) {
    const [p] = await tx
      .select({ id: planos.id })
      .from(planos)
      .where(and(eq(planos.id, b.planoId), eq(planos.empresaId, empresaId), eq(planos.ativo, true)));
    if (!p) throw invalido("Plano inválido ou removido.");
  }
  return { ...b, doc, email: b.email.toLowerCase() };
}

rotaClientes.get("/", async (c) => c.json(await listar(await db(), c.get("user").empresaId)));

rotaClientes.post("/", async (c) => {
  const b = await corpo(c, Cliente);
  const { empresaId } = c.get("user");
  const d = await db();
  const r = await d.transaction(async (tx) => {
    const v = await validar(tx, empresaId, b);
    const [n] = await tx
      .insert(clientes)
      .values({ ...v, empresaId })
      .returning({ id: clientes.id });
    await auditar(tx, c, "criar_cliente", "cliente", n!.id, v);
    return (await listar(tx, empresaId, n!.id))[0]!;
  });
  return c.json(r, 201);
});

rotaClientes.put("/:id", async (c) => {
  const id = paramId(c, "Cliente");
  const b = await corpo(c, Cliente);
  const { empresaId } = c.get("user");
  const d = await db();
  const r = await d.transaction(async (tx) => {
    const v = await validar(tx, empresaId, b);
    const up = await tx
      .update(clientes)
      .set({ ...v, atualizadoEm: new Date() })
      .where(and(eq(clientes.id, id), eq(clientes.empresaId, empresaId), eq(clientes.ativo, true)))
      .returning({ id: clientes.id });
    if (!up.length) throw naoEncontrado("Cliente");
    await auditar(tx, c, "editar_cliente", "cliente", id, v);
    return (await listar(tx, empresaId, id))[0]!;
  });
  return c.json(r);
});

// Desativa e tira das rotas. Visitas já feitas ficam no histórico.
rotaClientes.delete("/:id", async (c) => {
  const id = paramId(c, "Cliente");
  const d = await db();
  await d.transaction(async (tx) => {
    const r = await tx
      .update(clientes)
      .set({ ativo: false, atualizadoEm: new Date() })
      .where(and(eq(clientes.id, id), eq(clientes.empresaId, c.get("user").empresaId), eq(clientes.ativo, true)))
      .returning({ nome: clientes.nome, doc: clientes.doc });
    if (!r.length) throw naoEncontrado("Cliente");
    await tx.delete(rotaParadas).where(eq(rotaParadas.clienteId, id));
    await auditar(tx, c, "remover_cliente", "cliente", id, r[0]);
  });
  return c.json({ ok: true });
});
