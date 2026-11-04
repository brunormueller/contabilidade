import { and, asc, eq, isNotNull, isNull, lt, type SQL } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import { pagar } from "../db/schema.js";
import { paraCentavos, paraReais } from "../domain/dinheiro.js";
import { auditar } from "../lib/auditoria.js";
import { addMeses, diaValido, hojeBR } from "../lib/datas.js";
import { invalido, naoEncontrado } from "../lib/erros.js";
import { corpo } from "../lib/http.js";
import type { AppEnv } from "../tipos.js";

export const CATEGORIAS = ["Aluguel", "Fornecedores", "Impostos", "Folha de pagamento", "Serviços e assinaturas", "Outros"] as const;

export const rotaPagar = new Hono<AppEnv>();

export const pagarParaApi = (t: typeof pagar.$inferSelect) => ({
  id: t.id,
  descricao: t.descricao,
  fornecedor: t.fornecedor,
  categoria: t.categoria,
  valor: paraReais(t.valor),
  venc: t.venc,
  recorrente: t.recorrente,
  pagoEm: t.pagoEm,
});

rotaPagar.get("/", async (c) => {
  const filtro = c.req.query("filtro") ?? "abertos";
  const hoje = hojeBR();
  const extra: Record<string, SQL | undefined> = {
    abertos: isNull(pagar.pagoEm),
    vencido: and(isNull(pagar.pagoEm), lt(pagar.venc, hoje)),
    pago: isNotNull(pagar.pagoEm),
    todos: undefined,
  };
  if (!(filtro in extra)) throw invalido("Filtro inválido.");
  const d = await db();
  const lista = await d
    .select()
    .from(pagar)
    .where(and(eq(pagar.empresaId, c.get("user").empresaId), extra[filtro]))
    .orderBy(asc(pagar.venc));
  return c.json(lista.map(pagarParaApi));
});

const Nova = z.object({
  descricao: z.string().trim().min(1, "Informe a descrição da conta.").max(200),
  fornecedor: z.string().trim().max(150).default(""),
  categoria: z.enum(CATEGORIAS, { message: "Categoria inválida." }),
  valor: z.number({ message: "Informe um valor maior que zero." }).positive("Informe um valor maior que zero.").max(1e10),
  venc: z.string().refine(diaValido, "Informe o vencimento."),
  recorrente: z.boolean().default(false),
});

rotaPagar.post("/", async (c) => {
  const b = await corpo(c, Nova);
  const d = await db();
  const t = await d.transaction(async (tx) => {
    const [t] = await tx
      .insert(pagar)
      .values({ ...b, valor: paraCentavos(b.valor), empresaId: c.get("user").empresaId })
      .returning();
    await auditar(tx, c, "criar_pagar", "pagar", t!.id, b);
    return t!;
  });
  return c.json(pagarParaApi(t), 201);
});

async function buscar(c: Context<AppEnv>) {
  const d = await db();
  const [t] = await d
    .select()
    .from(pagar)
    .where(and(eq(pagar.id, c.req.param("id")!), eq(pagar.empresaId, c.get("user").empresaId)));
  if (!t) throw naoEncontrado("Conta");
  return { d, t };
}

rotaPagar.post("/:id/pago", async (c) => {
  const { d, t } = await buscar(c);
  const hoje = hojeBR();
  const r = await d.transaction(async (tx) => {
    await tx.update(pagar).set({ pagoEm: hoje }).where(eq(pagar.id, t.id));
    let proxima: string | null = null;
    if (t.recorrente) {
      // origem_id é único: pagar, desfazer e pagar de novo não cria a próxima duas vezes
      const venc = addMeses(t.venc, 1);
      const ins = await tx
        .insert(pagar)
        .values({ empresaId: t.empresaId, descricao: t.descricao, fornecedor: t.fornecedor, categoria: t.categoria, valor: t.valor, venc, recorrente: true, origemId: t.id })
        .onConflictDoNothing()
        .returning({ venc: pagar.venc });
      proxima = ins[0]?.venc ?? null;
    }
    await auditar(tx, c, "marcar_pago", "pagar", t.id, { data: hoje, proxima });
    return { proxima };
  });
  return c.json({ ...pagarParaApi({ ...t, pagoEm: hoje }), ...r });
});

rotaPagar.delete("/:id/pago", async (c) => {
  const { d, t } = await buscar(c);
  await d.transaction(async (tx) => {
    await tx.update(pagar).set({ pagoEm: null }).where(eq(pagar.id, t.id));
    await auditar(tx, c, "desfazer_pago", "pagar", t.id);
  });
  return c.json(pagarParaApi({ ...t, pagoEm: null }));
});

rotaPagar.delete("/:id", async (c) => {
  const { d, t } = await buscar(c);
  await d.transaction(async (tx) => {
    await tx.delete(pagar).where(eq(pagar.id, t.id));
    await auditar(tx, c, "excluir_pagar", "pagar", t.id, pagarParaApi(t));
  });
  return c.json({ ok: true });
});
