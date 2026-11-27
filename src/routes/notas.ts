import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import { notaParaApi } from "../domain/lotes.js";
import { arquivosXml, cancelarNota, carregarNota, documentosDaNota, FILTROS, notasDoMes } from "../domain/notas.js";
import { env } from "../env.js";
import { auditar } from "../lib/auditoria.js";
import { MES } from "../lib/datas.js";
import { invalido, naoEncontrado } from "../lib/erros.js";
import { corpo, paramId } from "../lib/http.js";
import { gerarDanfse } from "../nfse/danfse.js";
import { MOTIVOS_CANCELAMENTO } from "../nfse/evento.js";
import type { AppEnv } from "../tipos.js";

export const rotaNotas = new Hono<AppEnv>();

function filtros(mes: string | undefined, status: string | undefined) {
  if (!mes || !MES.test(mes)) throw invalido("Mês inválido. Use AAAA-MM.");
  const s = status ?? "todas";
  if (!(s in FILTROS)) throw invalido("Situação inválida.");
  return { mes, status: s as keyof typeof FILTROS };
}

rotaNotas.get("/", async (c) => {
  const f = filtros(c.req.query("mes"), c.req.query("status"));
  const lista = await notasDoMes(await db(), c.get("user").empresaId, env().NFSE_AMBIENTE, f.mes, f.status);
  return c.json(lista.map(notaParaApi));
});

/** XMLs de todas as notas do filtro, para o navegador montar o .zip. */
rotaNotas.get("/xmls", async (c) => {
  const f = filtros(c.req.query("mes"), c.req.query("status"));
  const d = await db();
  const lista = await notasDoMes(d, c.get("user").empresaId, env().NFSE_AMBIENTE, f.mes, f.status);
  return c.json((await Promise.all(lista.map((n) => arquivosXml(d, n)))).flat());
});

rotaNotas.get("/:id", async (c) => {
  const d = await db();
  const n = await carregarNota(d, c.get("user").empresaId, c.req.param("id"));
  return c.json({ ...notaParaApi(n), documentos: await documentosDaNota(d, n.id) });
});

rotaNotas.get("/:id/xmls", async (c) => {
  const d = await db();
  return c.json(await arquivosXml(d, await carregarNota(d, c.get("user").empresaId, c.req.param("id"))));
});

/** DANFSe em PDF, montado a partir do XML autorizado. */
rotaNotas.get("/:id/danfse", async (c) => {
  const d = await db();
  const n = await carregarNota(d, c.get("user").empresaId, paramId(c, "Nota"));
  // o primeiro arquivo é a NFS-e; o segundo, quando existe, é o evento de cancelamento
  const nfse = (await arquivosXml(d, n)).find((a) => !a.nome.includes("cancelamento"));
  if (!nfse) throw naoEncontrado("XML da NFS-e");
  const pdf = await gerarDanfse(nfse.xml, { cancelada: n.status === "cancelada" });
  return c.body(new Uint8Array(pdf), 200, { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="DANFSe-${n.nNfse ?? n.nDps}.pdf"` });
});

const Cancelar = z.object({
  cMotivo: z.enum(Object.keys(MOTIVOS_CANCELAMENTO) as [keyof typeof MOTIVOS_CANCELAMENTO], { message: "Escolha o motivo do cancelamento." }).optional(),
  // TSMotivo: 15 a 255 caracteres
  xMotivo: z.string().trim().min(15, "Descreva o motivo com pelo menos 15 caracteres.").max(255, "O motivo pode ter até 255 caracteres.").optional(),
});

/** Sem corpo, só verifica um cancelamento que ficou pendente. */
rotaNotas.post("/:id/cancelar", async (c) => {
  const b = await corpo(c, Cancelar);
  const d = await db();
  const id = c.req.param("id");
  const r = await cancelarNota(d, { empresaId: c.get("user").empresaId, notaId: id, ambiente: env().NFSE_AMBIENTE, cMotivo: b.cMotivo, xMotivo: b.xMotivo });
  await auditar(d, c, "cancelar_nota", "nota", id, { ...b, resultado: r.status });
  return c.json({ ...r, nota: notaParaApi(await carregarNota(d, c.get("user").empresaId, id)) }, r.status === "cancelada" ? 200 : 202);
});
