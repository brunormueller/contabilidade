import { and, asc, desc, eq, gte, isNull, lte, sql, sum } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client.js";
import { lotes, notas, pagar, receber } from "../db/schema.js";
import { paraReais } from "../domain/dinheiro.js";
import { env } from "../env.js";
import { addDias, fimDoMes, hojeBR } from "../lib/datas.js";
import type { AppEnv } from "../tipos.js";
import { pagarParaApi } from "./pagar.js";
import { receberParaApi } from "./receber.js";

export const rotaPainel = new Hono<AppEnv>();

rotaPainel.get("/", async (c) => {
  const { empresaId } = c.get("user");
  const amb = env().NFSE_AMBIENTE;
  const hoje = hojeBR();
  const ym = hoje.slice(0, 7);
  const em7 = addDias(hoje, 7);
  const d = await db();

  const [mes] = await d
    .select({ qtd: sql<number>`count(*)::int`, total: sum(notas.valor) })
    .from(notas)
    .where(
      and(
        eq(notas.empresaId, empresaId),
        eq(notas.ambiente, amb),
        eq(notas.status, "autorizada"),
        gte(notas.competencia, `${ym}-01`),
        lte(notas.competencia, fimDoMes(ym)),
      ),
    );
  const [temNotas] = await d
    .select({ n: sql<number>`count(*)::int` })
    .from(notas)
    .where(and(eq(notas.empresaId, empresaId), eq(notas.ambiente, amb)));

  const abertos = await d
    .select()
    .from(receber)
    .where(and(eq(receber.empresaId, empresaId), eq(receber.ambiente, amb), isNull(receber.recebidoEm)))
    .orderBy(asc(receber.venc));
  const vencidos = abertos.filter((t) => t.venc < hoje);

  const pagarSemana = await d
    .select()
    .from(pagar)
    .where(and(eq(pagar.empresaId, empresaId), isNull(pagar.pagoEm), lte(pagar.venc, em7)))
    .orderBy(asc(pagar.venc));

  const [ult] = await d
    .select({ data: lotes.criadoEm, qtd: lotes.qtd })
    .from(lotes)
    .where(and(eq(lotes.empresaId, empresaId), eq(lotes.ambiente, amb)))
    .orderBy(desc(lotes.criadoEm))
    .limit(1);

  const soma = (l: { valor: number }[]) => paraReais(l.reduce((a, t) => a + t.valor, 0));
  return c.json({
    mes: ym,
    ate: em7,
    faturado: paraReais(Number(mes?.total ?? 0)),
    notasMes: mes?.qtd ?? 0,
    temNotas: (temNotas?.n ?? 0) > 0,
    aReceberAberto: soma(abertos),
    vencidosQtd: vencidos.length,
    vencidos: vencidos.slice(0, 8).map(receberParaApi),
    pagarSemanaTotal: soma(pagarSemana),
    pagarSemana: pagarSemana.map(pagarParaApi),
    ultimoLote: ult ?? null,
  });
});
