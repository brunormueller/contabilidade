import { and, asc, eq, isNotNull, isNull, lt, type SQL } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import { receber } from "../db/schema.js";
import { paraReais } from "../domain/dinheiro.js";
import { env } from "../env.js";
import { auditar } from "../lib/auditoria.js";
import { diaValido, hojeBR } from "../lib/datas.js";
import { invalido, naoEncontrado } from "../lib/erros.js";
import { corpo } from "../lib/http.js";
import type { AppEnv } from "../tipos.js";

export const rotaReceber = new Hono<AppEnv>();

export const receberParaApi = (t: typeof receber.$inferSelect) => ({
  id: t.id,
  notaId: t.notaId,
  descricao: t.descricao,
  cliente: t.cliente,
  valor: paraReais(t.valor),
  venc: t.venc,
  recebidoEm: t.recebidoEm,
});

rotaReceber.get("/", async (c) => {
  const filtro = c.req.query("filtro") ?? "abertos";
  const hoje = hojeBR();
  const extra: Record<string, SQL | undefined> = {
    abertos: isNull(receber.recebidoEm),
    vencido: and(isNull(receber.recebidoEm), lt(receber.venc, hoje)),
    recebido: isNotNull(receber.recebidoEm),
    todos: undefined,
  };
  if (!(filtro in extra)) throw invalido("Filtro inválido.");
  const d = await db();
  const lista = await d
    .select()
    .from(receber)
    .where(and(eq(receber.empresaId, c.get("user").empresaId), eq(receber.ambiente, env().NFSE_AMBIENTE), extra[filtro]))
    .orderBy(asc(receber.venc));
  return c.json(lista.map(receberParaApi));
});

async function marcar(c: Context<AppEnv>, data: string | null) {
  const d = await db();
  const id = c.req.param("id")!;
  const r = await d.transaction(async (tx) => {
    const [t] = await tx
      .update(receber)
      .set({ recebidoEm: data })
      .where(and(eq(receber.id, id), eq(receber.empresaId, c.get("user").empresaId)))
      .returning();
    if (!t) throw naoEncontrado("Título");
    await auditar(tx, c, data ? "marcar_recebido" : "desfazer_recebido", "receber", id, { data });
    return t;
  });
  return c.json(receberParaApi(r));
}

rotaReceber.post("/:id/recebido", async (c) => {
  const b = await corpo(c, z.object({ data: z.string().optional() }));
  const data = b.data ?? hojeBR();
  if (!diaValido(data)) throw invalido("Data inválida.");
  return marcar(c, data);
});

rotaReceber.delete("/:id/recebido", (c) => marcar(c, null));
