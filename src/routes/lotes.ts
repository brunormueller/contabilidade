import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import { carregarEmpresa } from "../domain/empresa.js";
import { processarEnvios } from "../domain/envios.js";
import { criarLote, hashLinhas, listarLotes, notasDoLote, padroesDaEmpresa, reprocessarLote, resumoLote } from "../domain/lotes.js";
import { LIMITE_LINHAS, validarLinhas } from "../domain/planilha.js";
import { env } from "../env.js";
import { processarFila } from "../nfse/fila.js";
import { auditar } from "../lib/auditoria.js";
import { hojeBR } from "../lib/datas.js";
import { invalido } from "../lib/erros.js";
import { corpo } from "../lib/http.js";
import type { AppEnv } from "../tipos.js";

export const rotaLotes = new Hono<AppEnv>();

const linhas = z
  .array(z.record(z.string(), z.union([z.string().max(5000), z.number(), z.boolean(), z.null()])))
  .max(LIMITE_LINHAS, `A planilha pode ter até ${LIMITE_LINHAS} linhas por lote.`);

/** Confere as linhas sem gravar nada: é a tela "Conferir lote". */
rotaLotes.post("/validar", async (c) => {
  const b = await corpo(c, z.object({ linhas }));
  const e = await carregarEmpresa(await db(), c.get("user").empresaId);
  return c.json(validarLinhas(b.linhas, padroesDaEmpresa(e), hojeBR()));
});

const NovoLote = z.object({
  // gerada pelo navegador ao carregar a planilha (crypto.randomUUID)
  chave: z.string().regex(/^[A-Za-z0-9-]{8,100}$/, "Chave de envio inválida."),
  arquivo: z.string().max(200).default(""),
  linhas,
});

/** Cria o lote com as linhas sem erro. As que têm erro voltam em "ignoradas", como no protótipo. */
rotaLotes.post("/", async (c) => {
  const b = await corpo(c, NovoLote);
  const u = c.get("user");
  const d = await db();
  const hoje = hojeBR();
  const e = await carregarEmpresa(d, u.empresaId);
  const v = validarLinhas(b.linhas, padroesDaEmpresa(e), hoje);
  if (v.faltando.length) throw invalido(`Faltam colunas na planilha: ${v.faltando.join(", ")}.`, { faltando: v.faltando });
  const boas = v.rows.filter((r) => !r.errors.length);
  const r = await criarLote(
    d,
    { empresaId: u.empresaId, usuarioId: u.id, ambiente: env().NFSE_AMBIENTE, arquivo: b.arquivo, chave: b.chave, hash: hashLinhas(b.linhas), linhas: boas, hoje },
    (tx, loteId) => auditar(tx, c, "criar_lote", "lote", loteId, { qtd: boas.length, arquivo: b.arquivo }),
  );
  const ignoradas = v.rows.filter((x) => x.errors.length).map((x) => ({ linha: x.i, erros: x.errors }));
  return c.json({ lote: await resumoLote(d, u.empresaId, r.lote.id), ignoradas }, r.criado ? 201 : 200);
});

rotaLotes.get("/", async (c) => {
  return c.json(await listarLotes(await db(), c.get("user").empresaId, env().NFSE_AMBIENTE));
});

rotaLotes.get("/:id", async (c) => {
  const d = await db();
  const resumo = await resumoLote(d, c.get("user").empresaId, c.req.param("id"));
  return c.json({ ...resumo, notas: await notasDoLote(d, resumo.id) });
});

/**
 * Processa um pedaço da fila do lote e devolve o progresso. A tela chama de novo enquanto
 * houver pendentes; cada chamada cabe no limite de tempo da função.
 */
rotaLotes.post("/:id/processar", async (c) => {
  const d = await db();
  const u = c.get("user");
  const antes = await resumoLote(d, u.empresaId, c.req.param("id"));
  // ?max=N devolve o progresso mais cedo, para a tela atualizar nota a nota
  const max = Math.min(50, Math.max(1, Number(c.req.query("max")) || 50));
  const rodada = await processarFila(d, { ambiente: env().NFSE_AMBIENTE, empresaId: u.empresaId, loteId: antes.id }, { max });
  const depois = await resumoLote(d, u.empresaId, antes.id);
  // lote terminado: aproveita a chamada para mandar os e-mails das notas
  if (!depois.pendentes) await processarEnvios(d, { empresaId: u.empresaId }, { orcamentoMs: 8_000 });
  return c.json({ ...depois, rodada });
});

rotaLotes.post("/:id/reprocessar", async (c) => {
  const d = await db();
  const u = c.get("user");
  const lote = await resumoLote(d, u.empresaId, c.req.param("id"));
  const n = await d.transaction(async (tx) => {
    const n = await reprocessarLote(tx, u.empresaId, lote.id);
    await auditar(tx, c, "reprocessar_lote", "lote", lote.id, { notas: n });
    return n;
  });
  return c.json({ ...(await resumoLote(d, u.empresaId, lote.id)), reprocessadas: n });
});
