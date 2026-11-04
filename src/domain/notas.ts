import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import type { DB, Tx } from "../db/client.js";
import { notaDocumentos, notas, receber } from "../db/schema.js";
import { env, type Ambiente } from "../env.js";
import { fimDoMes } from "../lib/datas.js";
import { HttpError, naoEncontrado } from "../lib/erros.js";
import { log } from "../lib/log.js";
import { assinar } from "../nfse/assinatura.js";
import { EVENTO_CANCELAMENTO, montarCancelamento, type MotivoCancelamento } from "../nfse/evento.js";
import { abrirContexto } from "../nfse/fila.js";
import { validarXsd } from "../nfse/xsd.js";

type Nota = typeof notas.$inferSelect;
type TipoDoc = (typeof notaDocumentos.$inferInsert)["tipo"];

/** O que aparece em "Notas emitidas": o que já virou NFS-e. */
export const EMITIDAS = ["autorizada", "cancelamento_pendente", "cancelada"] as const;
export const FILTROS = { todas: EMITIDAS, autorizada: ["autorizada", "cancelamento_pendente"], cancelada: ["cancelada"] } as const;

export async function notasDoMes(d: DB, empresaId: string, ambiente: Ambiente, ym: string, filtro: keyof typeof FILTROS) {
  return d
    .select()
    .from(notas)
    .where(
      and(
        eq(notas.empresaId, empresaId),
        eq(notas.ambiente, ambiente),
        inArray(notas.status, [...FILTROS[filtro]]),
        gte(notas.competencia, `${ym}-01`),
        lte(notas.competencia, fimDoMes(ym)),
      ),
    )
    .orderBy(desc(notas.dhProc), desc(notas.nDps));
}

export async function carregarNota(d: DB, empresaId: string, id: string) {
  const [n] = await d.select().from(notas).where(and(eq(notas.id, id), eq(notas.empresaId, empresaId)));
  if (!n) throw naoEncontrado("Nota");
  return n;
}

/** Último documento de cada tipo pedido, do mais novo para o mais velho. */
async function ultimoDoc(d: DB, notaId: string, tipo: TipoDoc) {
  const [x] = await d
    .select({ conteudo: notaDocumentos.conteudo })
    .from(notaDocumentos)
    .where(and(eq(notaDocumentos.notaId, notaId), eq(notaDocumentos.tipo, tipo)))
    .orderBy(desc(notaDocumentos.criadoEm))
    .limit(1);
  return x?.conteudo ?? null;
}

/** XML da NFS-e e, se cancelada, o do evento de cancelamento, com nome de arquivo. */
export async function arquivosXml(d: DB, n: Nota) {
  const nome = `NFSe-${n.nNfse ?? n.nDps}`;
  const out: { nome: string; xml: string }[] = [];
  const nfse = await ultimoDoc(d, n.id, "nfse");
  if (nfse) out.push({ nome: `${nome}.xml`, xml: nfse });
  if (n.status === "cancelada") {
    const ev = await ultimoDoc(d, n.id, "evento_resposta");
    if (ev) out.push({ nome: `${nome}-cancelamento.xml`, xml: ev });
  }
  return out;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
async function gravar(d: DB | Tx, n: Nota, tipo: TipoDoc, conteudo: string | undefined, http?: number) {
  if (!conteudo) return;
  await d.insert(notaDocumentos).values({ notaId: n.id, tipo, tentativa: n.tentativas, httpStatus: http ?? null, conteudo, sha256: sha(conteudo) });
}

/**
 * Cancela pela API de eventos (síncrona). Resposta incerta deixa a nota em
 * "cancelamento_pendente"; chamar de novo consulta o evento antes de pedir outra vez.
 */
export async function cancelarNota(d: DB, a: { empresaId: string; notaId: string; ambiente: Ambiente; cMotivo?: MotivoCancelamento; xMotivo?: string }) {
  let n = await carregarNota(d, a.empresaId, a.notaId);
  if (n.status !== "autorizada" && n.status !== "cancelamento_pendente") throw new HttpError(409, "Só nota autorizada pode ser cancelada.");
  if (n.status === "autorizada" && (!a.cMotivo || !a.xMotivo)) throw new HttpError(400, "Informe o motivo do cancelamento.");

  let ctx;
  try {
    ctx = await abrirContexto(d, a.empresaId, a.ambiente);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(503, e instanceof Error ? e.message : "Sefin indisponível.");
  }

  if (n.status === "autorizada") {
    // a troca de status é a trava: dois cliques não mandam dois pedidos
    const [u] = await d
      .update(notas)
      .set({ status: "cancelamento_pendente", cMotivoCanc: Number(a.cMotivo), xMotivoCanc: a.xMotivo, ultimoErro: null, atualizadoEm: new Date() })
      .where(and(eq(notas.id, n.id), eq(notas.status, "autorizada")))
      .returning();
    if (!u) throw new HttpError(409, "Esta nota já está sendo cancelada.");
    n = u;
  } else {
    const r = await ctx.sefin.consultarEvento(n.chaveAcesso!, EVENTO_CANCELAMENTO);
    await gravar(d, n, "consulta", r.corpo, r.http);
    if (r.tipo === "existe") return concluirCancelamento(d, n, r.xmlEvento);
    if (r.tipo === "incerto") return { status: n.status, mensagem: "A Sefin não respondeu. Tente verificar de novo em alguns minutos." };
  }

  const { xml } = montarCancelamento({
    chaveAcesso: n.chaveAcesso!,
    cnpj: ctx.empresa.cnpj,
    ambiente: n.ambiente,
    dhEvento: new Date(),
    cMotivo: String(n.cMotivoCanc) as MotivoCancelamento,
    xMotivo: n.xMotivoCanc!,
  });
  const assinado = assinar(xml, "infPedReg", ctx.cert, env().NFSE_ASSINATURA);
  const xsd = await validarXsd(assinado, n.ambiente, "pedRegEvento_v1.01.xsd");
  if (!xsd.valido) {
    await voltarParaAutorizada(d, n, { origem: "xsd", mensagem: "O pedido de cancelamento não passou no XSD oficial.", erros: xsd.erros });
    throw new HttpError(500, "O pedido de cancelamento não passou no XSD oficial.", { erros: xsd.erros });
  }
  await gravar(d, n, "evento_envio", assinado);

  let r;
  try {
    r = await ctx.sefin.registrarEvento(n.chaveAcesso!, assinado);
  } catch (e) {
    log.error("falha ao registrar cancelamento", { notaId: n.id, erro: e });
    return { status: "cancelamento_pendente" as const, mensagem: "Não deu para confirmar com a Sefin. Verifique de novo em alguns minutos." };
  }
  await gravar(d, n, "evento_resposta", r.tipo === "registrado" ? undefined : r.corpo, r.http);
  if (r.tipo === "registrado") return concluirCancelamento(d, n, r.xmlEvento);
  if (r.tipo === "incerto") return { status: "cancelamento_pendente" as const, mensagem: "A Sefin não respondeu. Verifique de novo em alguns minutos." };
  const msg = r.erros.map((x) => `${x.codigo}: ${x.mensagem}`).join("; ");
  await voltarParaAutorizada(d, n, { origem: "sefin", mensagem: `Cancelamento recusado: ${msg}`, erros: r.erros });
  throw new HttpError(409, `A Sefin recusou o cancelamento. ${msg}`, { erros: r.erros });
}

async function voltarParaAutorizada(d: DB, n: Nota, erro: object) {
  await d
    .update(notas)
    .set({ status: "autorizada", cMotivoCanc: null, xMotivoCanc: null, ultimoErro: erro, atualizadoEm: new Date() })
    .where(and(eq(notas.id, n.id), eq(notas.status, "cancelamento_pendente")));
}

/** Nota cancelada e título a receber em aberto removido (o já recebido fica no financeiro). */
async function concluirCancelamento(d: DB, n: Nota, xmlEvento: string) {
  await d.transaction(async (tx) => {
    const agora = new Date();
    await tx.update(notas).set({ status: "cancelada", dhCanc: agora, atualizadoEm: agora }).where(eq(notas.id, n.id));
    await gravar(tx, n, "evento_resposta", xmlEvento);
    await tx.delete(receber).where(and(eq(receber.notaId, n.id), isNull(receber.recebidoEm)));
  });
  return { status: "cancelada" as const, mensagem: `NFS-e nº ${n.nNfse} cancelada.` };
}

export async function documentosDaNota(d: DB, notaId: string) {
  return d
    .select({ tipo: notaDocumentos.tipo, tentativa: notaDocumentos.tentativa, httpStatus: notaDocumentos.httpStatus, criadoEm: notaDocumentos.criadoEm })
    .from(notaDocumentos)
    .where(eq(notaDocumentos.notaId, notaId))
    .orderBy(asc(notaDocumentos.criadoEm));
}
