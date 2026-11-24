// Faturamento mensal (configuração, prévia, "emitir agora") e e-mails das notas.
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import { empresa, envios, notas } from "../db/schema.js";
import { paraReais } from "../domain/dinheiro.js";
import { carregarEmpresa } from "../domain/empresa.js";
import { processarEnvios } from "../domain/envios.js";
import { agruparItens, faturarMes, previa, proximaEmissao, TOLERANCIA_DIAS } from "../domain/faturamento.js";
import { resumoLote } from "../domain/lotes.js";
import { emailValido } from "../domain/usuarios.js";
import { env } from "../env.js";
import { auditar } from "../lib/auditoria.js";
import { hojeBR } from "../lib/datas.js";
import { carteiro } from "../lib/email.js";
import { invalido, naoEncontrado } from "../lib/erros.js";
import { corpo, paramId } from "../lib/http.js";
import type { AppEnv } from "../tipos.js";

export const rotaFaturamento = new Hono<AppEnv>();

rotaFaturamento.get("/", async (c) => {
  const { empresaId } = c.get("user");
  const amb = env().NFSE_AMBIENTE;
  const hoje = hojeBR();
  const mes = hoje.slice(0, 7);
  const d = await db();
  const e = await carregarEmpresa(d, empresaId);
  const pv = await previa(d, empresaId, amb, mes, hoje);
  const ultimos = await d
    .select({
      id: envios.id,
      notaId: envios.notaId,
      numero: notas.nNfse,
      cliente: notas.tomadorNome,
      para: envios.para,
      status: envios.status,
      tentativas: envios.tentativas,
      ultimoErro: envios.ultimoErro,
      enviadoEm: envios.enviadoEm,
      criadoEm: envios.criadoEm,
    })
    .from(envios)
    .innerJoin(notas, eq(notas.id, envios.notaId))
    .where(and(eq(envios.empresaId, empresaId), eq(notas.ambiente, amb)))
    .orderBy(desc(envios.criadoEm))
    .limit(30);
  return c.json({
    mes,
    hoje,
    config: {
      diaEmissao: e.diaEmissao,
      enviarEmail: e.enviarEmail,
      proxima: proximaEmissao(e.diaEmissao, e.faturamentoDesde, hoje),
      toleranciaDias: TOLERANCIA_DIAS,
    },
    emailConfigurado: carteiro() != null,
    clientes: pv.map((p) => ({
      id: p.cliente.id,
      nome: p.cliente.nome,
      email: p.cliente.email,
      plano: p.cliente.planoNome,
      mensalidade: paraReais(p.mensalidade),
      extras: paraReais(p.extras),
      itens: agruparItens(p.itens).map((i) => ({ ...i, valor: paraReais(i.valor) })),
      total: paraReais(p.total),
      fatura: p.fatura && { notaId: p.fatura.notaId, loteId: p.fatura.loteId, numero: p.fatura.numero, status: p.fatura.status },
    })),
    envios: ultimos,
  });
});

rotaFaturamento.put("/config", async (c) => {
  const b = await corpo(
    c,
    z.object({
      diaEmissao: z.number().int().min(1, "Dia do mês entre 1 e 31.").max(31, "Dia do mês entre 1 e 31.").nullable(),
      enviarEmail: z.boolean(),
    }),
  );
  const { empresaId } = c.get("user");
  const hoje = hojeBR();
  const d = await db();
  const r = await d.transaction(async (tx) => {
    const atual = await carregarEmpresa(tx, empresaId);
    const mudouDia = atual.diaEmissao !== b.diaEmissao;
    await tx
      .update(empresa)
      .set({ diaEmissao: b.diaEmissao, enviarEmail: b.enviarEmail, ...(mudouDia && { faturamentoDesde: hoje }), atualizadoEm: new Date() })
      .where(eq(empresa.id, empresaId));
    await auditar(tx, c, "configurar_faturamento", "empresa", empresaId, b);
    return proximaEmissao(b.diaEmissao, mudouDia ? hoje : atual.faturamentoDesde, hoje);
  });
  return c.json({ ...b, proxima: r });
});

/** Fatura agora quem ainda não foi faturado no mês, sem esperar o dia configurado. */
rotaFaturamento.post("/emitir", async (c) => {
  const u = c.get("user");
  const d = await db();
  const r = await faturarMes(d, {
    empresaId: u.empresaId,
    ambiente: env().NFSE_AMBIENTE,
    hoje: hojeBR(),
    usuarioId: u.id,
    automatica: false,
    auditar: (tx, loteId, dados) => auditar(tx, c, "faturar_mes", "lote", loteId, dados),
  });
  return c.json({ ...r, lote: r.loteId ? await resumoLote(d, u.empresaId, r.loteId) : null }, r.loteId ? 201 : 200);
});

/** Manda de novo o e-mail de uma nota, para o mesmo endereço ou outro. */
rotaFaturamento.post("/envios/:id/reenviar", async (c) => {
  const id = paramId(c, "Envio");
  const b = await corpo(c, z.object({ para: z.string().trim().max(254).optional() }));
  if (b.para && !emailValido(b.para.toLowerCase())) throw invalido("Informe um e-mail válido.");
  const { empresaId } = c.get("user");
  const d = await db();
  await d.transaction(async (tx) => {
    const [e] = await tx
      .select()
      .from(envios)
      .where(and(eq(envios.id, id), eq(envios.empresaId, empresaId)))
      .for("update");
    if (!e) throw naoEncontrado("Envio");
    const [n] = await tx.select({ status: notas.status }).from(notas).where(eq(notas.id, e.notaId));
    if (n?.status !== "autorizada") throw invalido("Só nota autorizada pode ser enviada.");
    // registro novo = chave de idempotência nova no provedor
    await tx.delete(envios).where(eq(envios.id, e.id));
    await tx.insert(envios).values({ empresaId, notaId: e.notaId, para: b.para?.toLowerCase() || e.para });
    await auditar(tx, c, "reenviar_email", "nota", e.notaId, { de: e.para, para: b.para || e.para, statusAnterior: e.status });
  });
  return c.json(await processarEnvios(d, { empresaId }, { orcamentoMs: 8_000, max: 3 }));
});

/** Tenta agora os e-mails que estão esperando, sem aguardar o cron. */
rotaFaturamento.post("/envios/processar", async (c) => {
  const { empresaId } = c.get("user");
  const d = await db();
  await d.update(envios).set({ proximaTentativaEm: new Date() }).where(and(eq(envios.empresaId, empresaId), eq(envios.status, "pendente")));
  return c.json(await processarEnvios(d, { empresaId }, { orcamentoMs: 15_000 }));
});
