// Fila de emissão. Cada chamada processa notas uma a uma até acabar o orçamento de tempo, e a
// próxima chamada (tela do lote ou cron) continua de onde parou. Garantias:
// - uma nota só é enviada por quem tem o lease dela (FOR UPDATE SKIP LOCKED + leaseAte);
// - toda nota que já foi tentada consulta GET /dps/{id} antes de reenviar, então timeout ou
//   queda no meio do envio nunca vira nota em dobro;
// - autorização, documentos, conta a receber e e-mail para o tomador entram na mesma transação.
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, lt, lte, or } from "drizzle-orm";
import { abrirCertificado } from "../cert/certificado.js";
import type { DB, Tx } from "../db/client.js";
import { empresa, envios, notaDocumentos, notas, receber } from "../db/schema.js";
import { carregarEmpresa } from "../domain/empresa.js";
import { empresaDps, notaDps } from "../domain/lotes.js";
import { env, type Ambiente } from "../env.js";
import { log } from "../lib/log.js";
import { assinar } from "./assinatura.js";
import { ConfigIncompleta, montarDps } from "./dps.js";
import { DPS_JA_EXISTE, sefinPara, type Bruto, type NfseGerada, type Sefin } from "./sefin.js";
import { validarXsd } from "./xsd.js";

// O lease passa do tempo máximo da função (60 s): quando ele vence, quem o tinha já morreu.
export const LEASE_MS = 120_000;
// Depois disso não pega nota nova; sobra tempo para terminar a atual dentro dos 60 s.
// O cliente da Sefin precisa de timeout curto (15 s por chamada) para caber aqui.
export const ORCAMENTO_MS = 35_000;
// Resultado incerto: espera 1, 2, 4… até 60 min. Depois de tantas tentativas, para e espera
// o usuário mandar reprocessar.
export const MAX_TENTATIVAS = 8;
const espera = (tentativa: number) => Math.min(60, 2 ** (tentativa - 1)) * 60_000;

type Nota = typeof notas.$inferSelect;
type Doc = { tipo: (typeof notaDocumentos.$inferInsert)["tipo"]; conteudo: string; http?: number };
type Erro = { origem: "local" | "xsd" | "sefin"; mensagem: string; erros?: unknown };

type Contexto = { sefin: Sefin; cert: { chavePem: string; certPem: string }; empresa: Awaited<ReturnType<typeof carregarEmpresa>> };

export type Filtro = { ambiente: Ambiente; loteId?: string; empresaId?: string };

export async function processarFila(d: DB, f: Filtro, o: { orcamentoMs?: number; max?: number } = {}) {
  const inicio = Date.now();
  const orcamento = o.orcamentoMs ?? ORCAMENTO_MS;
  const contextos = new Map<string, Promise<Contexto>>();
  const resultado: Record<string, number> = {};
  let n = 0;
  while (Date.now() - inicio < orcamento && n < (o.max ?? Infinity)) {
    const pega = await pegarProxima(d, f);
    if (!pega) break;
    n++;
    const ctx = contextos.get(pega.nota.empresaId) ?? abrirContexto(d, pega.nota.empresaId, f.ambiente);
    contextos.set(pega.nota.empresaId, ctx);
    const status = await processarNota(d, ctx, pega.nota, pega.lease, pega.jaTentada);
    resultado[status] = (resultado[status] ?? 0) + 1;
  }
  return { processadas: n, resultado };
}

export async function abrirContexto(d: DB, empresaId: string, ambiente: Ambiente): Promise<Contexto> {
  const empresa = await carregarEmpresa(d, empresaId);
  const pfx = await abrirCertificado(d, empresaId);
  return { empresa, cert: pfx, sefin: sefinPara(pfx, ambiente) };
}

async function pegarProxima(d: DB, f: Filtro) {
  return d.transaction(async (tx) => {
    const agora = new Date();
    const [n] = await tx
      .select()
      .from(notas)
      .where(
        and(
          eq(notas.ambiente, f.ambiente),
          f.loteId ? eq(notas.loteId, f.loteId) : undefined,
          f.empresaId ? eq(notas.empresaId, f.empresaId) : undefined,
          or(
            and(inArray(notas.status, ["fila", "verificar"]), lte(notas.proximaTentativaEm, agora)),
            and(eq(notas.status, "processando"), lt(notas.leaseAte, agora)),
          ),
        ),
      )
      .orderBy(asc(notas.proximaTentativaEm), asc(notas.nDps))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!n) return null;
    const lease = new Date(agora.getTime() + LEASE_MS);
    const [u] = await tx
      .update(notas)
      .set({ status: "processando", leaseAte: lease, tentativas: n.tentativas + 1, atualizadoEm: agora })
      .where(eq(notas.id, n.id))
      .returning();
    return { nota: u!, lease, jaTentada: n.tentativas > 0 };
  });
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const doc = (tipo: Doc["tipo"], b: Bruto): Doc[] => (b.corpo ? [{ tipo, conteudo: b.corpo, http: b.http }] : []);

async function processarNota(d: DB, ctxP: Promise<Contexto>, n: Nota, lease: Date, jaTentada: boolean): Promise<string> {
  const fechar = (status: Nota["status"], set: Partial<Nota>, docs: Doc[] = [], nfse?: NfseGerada) =>
    concluir(d, n, lease, status, set, docs, nfse);
  const incerto = (motivo: string, docs: Doc[], imediato = false) =>
    n.tentativas >= MAX_TENTATIVAS
      ? fechar("verificar", { proximaTentativaEm: null, ultimoErro: erro("sefin", `Sem resposta conclusiva da Sefin depois de ${n.tentativas} tentativas (${motivo}). Use Reprocessar.`) }, docs)
      : fechar("verificar", { proximaTentativaEm: new Date(Date.now() + (imediato ? 0 : espera(n.tentativas))), ultimoErro: erro("sefin", motivo) }, docs);

  let ctx: Contexto;
  try {
    ctx = await ctxP;
  } catch (e) {
    // sem certificado não dá nem para consultar; se já foi tentada, não dá para dizer que falhou
    if (jaTentada) return fechar("verificar", { proximaTentativaEm: null, ultimoErro: erro("local", mensagemDe(e)) });
    return fechar("rejeitada", { ultimoErro: erro("local", mensagemDe(e)) });
  }
  let enviou = false;
  try {
    // já tentada: pode ter virado NFS-e sem a resposta chegar aqui
    if (jaTentada) {
      const r = await ctx.sefin.consultarDps(n.idDps);
      const docs = doc("consulta", r);
      if (r.tipo === "incerto") return incerto(r.motivo, docs);
      if (r.tipo === "existe") return buscarNfse(ctx, r.chaveAcesso, docs, fechar, incerto);
    }

    const dhEmi = new Date();
    let xml: string;
    try {
      xml = montarDps({ empresa: empresaDps(ctx.empresa), nota: notaDps(n), ambiente: n.ambiente, dhEmi }).xml;
    } catch (e) {
      if (e instanceof ConfigIncompleta) return fechar("rejeitada", { ultimoErro: erro("local", e.message) });
      throw e;
    }
    const assinado = assinar(xml, "infDPS", ctx.cert, env().NFSE_ASSINATURA);
    const xsd = await validarXsd(assinado, n.ambiente);
    if (!xsd.valido) return fechar("rejeitada", { ultimoErro: erro("xsd", "A DPS não passou no XSD oficial.", xsd.erros) });

    // o XML enviado fica gravado antes do envio, mesmo que a função caia logo depois
    await gravarDocs(d, n, [{ tipo: "dps", conteudo: assinado }]);
    await d.update(notas).set({ dhEmi }).where(and(eq(notas.id, n.id), eq(notas.leaseAte, lease)));
    enviou = true;
    const r = await ctx.sefin.emitir(assinado);
    const docs = doc("resposta", r);
    if (r.tipo === "autorizada") return fechar("autorizada", {}, docs, r.nfse);
    if (r.tipo === "incerto") return incerto(r.motivo, docs);
    // consulta já na próxima volta, mas conta tentativa: Sefin inconsistente não vira laço
    if (r.erros.some((x) => x.codigo === DPS_JA_EXISTE)) return incerto(`${DPS_JA_EXISTE}: a Sefin diz que esta DPS já virou NFS-e; consultando.`, docs, true);
    return fechar("rejeitada", { ultimoErro: erro("sefin", r.erros.map((x) => `${x.codigo}: ${x.mensagem}`).join("; "), r.erros) }, docs);
  } catch (e) {
    log.error("falha ao processar nota", { notaId: n.id, idDps: n.idDps, erro: e });
    // depois de enviar, nunca concluir que falhou: pode ter gerado a NFS-e
    if (enviou || jaTentada) return incerto(mensagemDe(e), []);
    return fechar("rejeitada", { ultimoErro: erro("local", mensagemDe(e)) });
  }
}

async function buscarNfse(
  ctx: Contexto,
  chave: string,
  docs: Doc[],
  fechar: (s: Nota["status"], set: Partial<Nota>, docs?: Doc[], nfse?: NfseGerada) => Promise<string>,
  incerto: (motivo: string, docs: Doc[]) => Promise<string>,
) {
  const r = await ctx.sefin.consultarNfse(chave);
  const todos = [...docs, ...doc("consulta", r)];
  return r.tipo === "ok" ? fechar("autorizada", {}, todos, r.nfse) : incerto(r.motivo, todos);
}

/** Grava o resultado só se o lease ainda for nosso; documentos e conta a receber vão junto. */
async function concluir(d: DB, n: Nota, lease: Date, status: Nota["status"], set: Partial<Nota>, docs: Doc[], nfse?: NfseGerada) {
  const ok = await d.transaction(async (tx) => {
    const agora = new Date();
    const extra: Partial<Nota> = nfse
      ? { chaveAcesso: nfse.chaveAcesso, nNfse: nfse.nNfse, dhProc: nfse.dhProc, ultimoErro: null, proximaTentativaEm: null }
      : {};
    const [u] = await tx
      .update(notas)
      .set({ ...set, ...extra, status, leaseAte: null, atualizadoEm: agora })
      .where(and(eq(notas.id, n.id), eq(notas.status, "processando"), eq(notas.leaseAte, lease)))
      .returning({ id: notas.id });
    if (!u) return false;
    await gravarDocs(tx, n, nfse ? [...docs, { tipo: "nfse", conteudo: nfse.xml }] : docs);
    if (nfse)
      await tx
        .insert(receber)
        .values({ empresaId: n.empresaId, ambiente: n.ambiente, notaId: n.id, descricao: `NFS-e nº ${nfse.nNfse}`, cliente: n.tomadorNome, valor: n.vLiq, venc: n.vencimento })
        .onConflictDoNothing({ target: receber.notaId });
    if (nfse && n.tomadorEmail) {
      const [e] = await tx.select({ enviar: empresa.enviarEmail }).from(empresa).where(eq(empresa.id, n.empresaId));
      if (e?.enviar) await tx.insert(envios).values({ empresaId: n.empresaId, notaId: n.id, para: n.tomadorEmail }).onConflictDoNothing({ target: envios.notaId });
    }
    return true;
  });
  if (!ok) log.warn("lease perdido; resultado descartado", { notaId: n.id, status });
  else log.info("nota processada", { notaId: n.id, idDps: n.idDps, status, tentativa: n.tentativas });
  return status;
}

async function gravarDocs(d: DB | Tx, n: Nota, docs: Doc[]) {
  if (!docs.length) return;
  await d.insert(notaDocumentos).values(docs.map((x) => ({ notaId: n.id, tipo: x.tipo, tentativa: n.tentativas, httpStatus: x.http ?? null, conteudo: x.conteudo, sha256: sha(x.conteudo) })));
}

const erro = (origem: Erro["origem"], mensagem: string, erros?: unknown): Erro => (erros === undefined ? { origem, mensagem } : { origem, mensagem, erros });
const mensagemDe = (e: unknown) => (e instanceof Error ? e.message : String(e));
