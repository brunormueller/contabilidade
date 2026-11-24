// Tela do funcionário: a rota de hoje e o registro de cada visita.
import { and, asc, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import { servicos } from "../db/schema.js";
import { concluirVisita, garantirVisitas, listarVisitas, naoRealizada, registrarChegada } from "../domain/campo.js";
import { auditar } from "../lib/auditoria.js";
import { hojeBR } from "../lib/datas.js";
import { corpo, paramId } from "../lib/http.js";
import type { AppEnv } from "../tipos.js";
import { servicoParaApi } from "./catalogo.js";

export const rotaCampo = new Hono<AppEnv>();

// GPS é a prova da visita, mas celular sem sinal não pode travar o atendimento: sem ele, grava null.
const Gps = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    precisao: z.number().min(0).max(100_000).nullable().default(null),
  })
  .transform((g) => ({ ...g, precisao: g.precisao == null ? null : Math.round(g.precisao) }))
  .nullable()
  .default(null);

rotaCampo.get("/hoje", async (c) => {
  const u = c.get("user");
  const hoje = hojeBR();
  const d = await db();
  await garantirVisitas(d, u.empresaId, hoje);
  const cat = await d
    .select()
    .from(servicos)
    .where(and(eq(servicos.empresaId, u.empresaId), eq(servicos.ativo, true)))
    .orderBy(asc(servicos.nome));
  return c.json({ data: hoje, visitas: await listarVisitas(d, u.empresaId, hoje, u.id), servicos: cat.map(servicoParaApi) });
});

const acao = (c: Context<AppEnv>, gps: z.infer<typeof Gps>) => {
  const u = c.get("user");
  return { empresaId: u.empresaId, funcionarioId: u.id, id: paramId(c, "Visita"), hoje: hojeBR(), gps };
};

rotaCampo.post("/visitas/:id/chegada", async (c) => {
  const b = await corpo(c, z.object({ gps: Gps }));
  const a = acao(c, b.gps);
  const d = await db();
  const v = await d.transaction(async (tx) => {
    const v = await registrarChegada(tx, a);
    await auditar(tx, c, "chegada_visita", "visita", v.id, { gps: b.gps });
    return v;
  });
  return c.json({ id: v.id, status: v.status, chegadaEm: v.chegadaEm });
});

rotaCampo.post("/visitas/:id/concluir", async (c) => {
  const b = await corpo(
    c,
    z.object({
      gps: Gps,
      servicos: z.array(z.uuid({ message: "Serviço inválido." })).max(100).default([]),
      obs: z.string().trim().max(500, "Observação passa de 500 caracteres.").default(""),
    }),
  );
  const a = acao(c, b.gps);
  const d = await db();
  const r = await d.transaction(async (tx) => {
    const r = await concluirVisita(tx, { ...a, servicos: b.servicos, obs: b.obs });
    await auditar(tx, c, "concluir_visita", "visita", r.visita.id, { gps: b.gps, servicos: r.itens.map((s) => s.nome), obs: b.obs });
    return r;
  });
  return c.json({ id: r.visita.id, status: r.visita.status, fimEm: r.visita.fimEm });
});

rotaCampo.post("/visitas/:id/nao-realizada", async (c) => {
  const b = await corpo(
    c,
    z.object({
      gps: Gps,
      motivo: z.string().trim().min(1, "Conte por que a visita não foi feita.").max(300, "Motivo passa de 300 caracteres."),
    }),
  );
  const a = acao(c, b.gps);
  const d = await db();
  const v = await d.transaction(async (tx) => {
    const v = await naoRealizada(tx, { ...a, motivo: b.motivo });
    await auditar(tx, c, "visita_nao_realizada", "visita", v.id, { gps: b.gps, motivo: b.motivo });
    return v;
  });
  return c.json({ id: v.id, status: v.status });
});
