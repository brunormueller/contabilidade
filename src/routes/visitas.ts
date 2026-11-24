// Acompanhamento das visitas pela empresa.
import { Hono } from "hono";
import { db } from "../db/client.js";
import { garantirVisitas, listarVisitas, reabrirVisita } from "../domain/campo.js";
import { auditar } from "../lib/auditoria.js";
import { diaValido, hojeBR } from "../lib/datas.js";
import { invalido } from "../lib/erros.js";
import { paramId } from "../lib/http.js";
import type { AppEnv } from "../tipos.js";

export const rotaVisitas = new Hono<AppEnv>();

rotaVisitas.get("/", async (c) => {
  const hoje = hojeBR();
  const data = c.req.query("data") || hoje;
  if (!diaValido(data)) throw invalido("Data inválida.");
  const { empresaId } = c.get("user");
  const d = await db();
  // só hoje acompanha a rota; dias passados mostram o que aconteceu, futuros ainda não existem
  if (data === hoje) await garantirVisitas(d, empresaId, data);
  return c.json({ data, hoje, visitas: await listarVisitas(d, empresaId, data) });
});

rotaVisitas.post("/:id/reabrir", async (c) => {
  const id = paramId(c, "Visita");
  const d = await db();
  await d.transaction(async (tx) => {
    const r = await reabrirVisita(tx, { empresaId: c.get("user").empresaId, id, hoje: hojeBR() });
    if (r.antes.status !== "pendente")
      await auditar(tx, c, "reabrir_visita", "visita", id, {
        status: r.antes.status,
        chegadaEm: r.antes.chegadaEm,
        fimEm: r.antes.fimEm,
        obs: r.antes.obs,
        motivo: r.antes.motivo,
        servicos: r.itens.map((i) => i.nome),
      });
  });
  return c.json({ ok: true });
});
