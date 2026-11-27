import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, inArray, sum } from "drizzle-orm";
import type { DB, Tx } from "../db/client.js";
import { empresa, lotes, notas, notaStatusEnum } from "../db/schema.js";
import { env, type Ambiente } from "../env.js";
import { HttpError, invalido, naoEncontrado } from "../lib/erros.js";
import { ConfigIncompleta, idDps, montarDps, type EmpresaDps, type NotaDps } from "../nfse/dps.js";
import { pendenciasFiscais } from "../nfse/pendencias.js";
import { intParaPct, paraCentavos, paraReais, pctParaInt } from "./dinheiro.js";
import { carregarEmpresa, reservarDps, resumoCertificado } from "./empresa.js";
import { exigeEnderecoImovel, exigeIbsCbs } from "../nfse/ambiente.js";
import type { Linha, Padroes } from "./planilha.js";

type Empresa = typeof empresa.$inferSelect;
type Nota = typeof notas.$inferSelect;
type Status = (typeof notaStatusEnum.enumValues)[number];

/** Padrões da empresa para validar linhas de nota (planilha ou faturamento). */
export const padroesDaEmpresa = (e: Empresa): Padroes => ({
  cServPadrao: e.cTribNacPadrao,
  cNBSPadrao: e.cNbsPadrao,
  aliqIss: intParaPct(e.aliqIssPadrao),
  vencDias: e.vencDias,
  cnpjEmpresa: e.cnpj,
  levaIbsCbs: (comp) => e.ibsCbs != null || exigeIbsCbs(env().NFSE_AMBIENTE, comp),
  exigeEndereco: exigeEnderecoImovel(env().NFSE_AMBIENTE, e.ibsCbs?.cIndOp),
});

export const empresaDps = (e: Empresa): EmpresaDps => ({
  cnpj: e.cnpj,
  im: e.im,
  ibge: e.ibge,
  cLocPrestacao: e.cLocPrestacao,
  pTotTribSN: e.pTotTribSn,
  ibsCbs: e.ibsCbs ?? null,
});

export const notaDps = (n: Pick<Nota, keyof NotaDps>): NotaDps => ({
  serie: n.serie,
  nDps: n.nDps,
  competencia: n.competencia,
  tomadorDoc: n.tomadorDoc,
  tomadorNome: n.tomadorNome,
  tomadorEmail: n.tomadorEmail,
  tomadorEnd: n.tomadorEnd,
  descricao: n.descricao,
  cTribNac: n.cTribNac,
  cNbs: n.cNbs,
  valor: n.valor,
  issRetido: n.issRetido,
  aliqIss: n.aliqIss,
  vInssRet: n.vInssRet,
});

const linhaParaNota = (l: Linha) => ({
  linha: l.i,
  tomadorDoc: l.doc,
  tomadorNome: l.nome,
  tomadorEmail: l.email,
  tomadorEnd: l.tomadorEnd,
  descricao: l.descricao,
  cTribNac: l.cServ,
  cNbs: l.nbs,
  valor: paraCentavos(l.valor),
  issRetido: l.issRetido,
  aliqIss: l.aliqIss == null ? null : pctParaInt(l.aliqIss),
  vIssRet: paraCentavos(l.vIssRet),
  vInssRet: paraCentavos(l.vInssRet),
  vLiq: paraCentavos(l.vLiq),
  competencia: l.competencia,
  vencimento: l.vencimento,
});

export const hashLinhas = (linhas: unknown) => createHash("sha256").update(JSON.stringify(linhas)).digest("hex");

/**
 * Cria o lote com uma nota "fila" por linha válida. Os números de DPS saem da sequência na
 * mesma transação: se algo falhar, nenhum número é gasto. A mesma chave devolve o lote já
 * criado, para clique duplo e reenvio não gerarem notas em dobro.
 */
export async function criarLote(
  d: DB,
  a: { empresaId: string; usuarioId: string | null; ambiente: Ambiente; arquivo: string; chave: string; hash: string; linhas: Linha[]; hoje: string },
  depois?: (tx: Tx, loteId: string) => Promise<void>,
) {
  const existente = await loteDaChave(d, a.empresaId, a.chave);
  if (existente) return conferirMesmoConteudo(existente, a.hash);
  if (!a.linhas.length) throw invalido("Nenhuma linha válida para emitir.");

  const e = await carregarEmpresa(d, a.empresaId);
  const pend = pendenciasFiscais(e, a.ambiente, a.hoje, (await resumoCertificado(d, a.empresaId)) != null);
  if (pend.length) throw new HttpError(409, "Complete a configuração antes de emitir.", { pendencias: pend });
  // monta cada DPS de prova (sem número de verdade) para achar configuração faltando agora,
  // e não nota por nota depois de reservar os números
  for (const l of a.linhas) {
    try {
      montarDps({ empresa: empresaDps(e), nota: notaDps({ ...linhaParaNota(l), serie: e.serieDps, nDps: 1 }), ambiente: a.ambiente, dhEmi: new Date() });
    } catch (err) {
      if (err instanceof ConfigIncompleta) throw new HttpError(409, `Linha ${l.i}: ${err.message}`);
      throw err;
    }
  }

  try {
    return await d.transaction(async (tx) => {
      const primeiro = await reservarDps(tx, a.empresaId, a.ambiente, e.serieDps, a.linhas.length);
      const valorTotal = a.linhas.reduce((s, l) => s + paraCentavos(l.valor), 0);
      const [lote] = await tx
        .insert(lotes)
        .values({ empresaId: a.empresaId, ambiente: a.ambiente, arquivo: a.arquivo, chaveIdem: a.chave, hashLinhas: a.hash, criadoPor: a.usuarioId, qtd: a.linhas.length, valorTotal })
        .returning();
      const agora = new Date();
      await tx.insert(notas).values(
        a.linhas.map((l, k) => ({
          ...linhaParaNota(l),
          empresaId: a.empresaId,
          loteId: lote!.id,
          ambiente: a.ambiente,
          serie: e.serieDps,
          nDps: primeiro + k,
          idDps: idDps(e.ibge, e.cnpj, e.serieDps, primeiro + k),
          proximaTentativaEm: agora,
        })),
      );
      await depois?.(tx, lote!.id);
      return { lote: lote!, criado: true };
    });
  } catch (err) {
    // dois envios simultâneos com a mesma chave: o segundo esbarra no índice único
    const outro = await loteDaChave(d, a.empresaId, a.chave);
    if (outro) return conferirMesmoConteudo(outro, a.hash);
    throw err;
  }
}

async function loteDaChave(d: DB, empresaId: string, chave: string) {
  const [l] = await d.select().from(lotes).where(and(eq(lotes.empresaId, empresaId), eq(lotes.chaveIdem, chave)));
  return l;
}

function conferirMesmoConteudo(l: typeof lotes.$inferSelect, hash: string) {
  if (l.hashLinhas !== hash) throw new HttpError(409, "Esta chave de envio já foi usada para outra planilha. Carregue o arquivo de novo.");
  return { lote: l, criado: false };
}

export const notaParaApi = (n: Nota) => ({
  id: n.id,
  linha: n.linha,
  serie: n.serie,
  nDPS: n.nDps,
  idDps: n.idDps,
  status: n.status,
  tentativas: n.tentativas,
  proximaTentativaEm: n.proximaTentativaEm,
  tomador: { doc: n.tomadorDoc, nome: n.tomadorNome, email: n.tomadorEmail },
  descricao: n.descricao,
  cServ: n.cTribNac,
  nbs: n.cNbs,
  valor: paraReais(n.valor),
  issRetido: n.issRetido,
  aliqIss: n.aliqIss == null ? null : n.aliqIss / 100,
  vIssRet: paraReais(n.vIssRet),
  vInssRet: paraReais(n.vInssRet),
  vLiq: paraReais(n.vLiq),
  competencia: n.competencia,
  vencimento: n.vencimento,
  dhEmi: n.dhEmi,
  chaveAcesso: n.chaveAcesso,
  numero: n.nNfse,
  dhProc: n.dhProc,
  erro: n.ultimoErro,
  cancelamento: n.cMotivoCanc == null ? null : { cMotivo: String(n.cMotivoCanc), xMotivo: n.xMotivoCanc, dhCanc: n.dhCanc },
});

const PENDENTES: Status[] = ["fila", "processando", "verificar"];

export async function resumoLote(d: DB | Tx, empresaId: string, loteId: string) {
  const [l] = await d.select().from(lotes).where(and(eq(lotes.id, loteId), eq(lotes.empresaId, empresaId)));
  if (!l) throw naoEncontrado("Lote");
  const grupos = await d
    .select({ status: notas.status, n: count(), total: sum(notas.valor).mapWith(Number) })
    .from(notas)
    .where(eq(notas.loteId, loteId))
    .groupBy(notas.status);
  const contagem = Object.fromEntries(grupos.map((g) => [g.status, g.n])) as Partial<Record<Status, number>>;
  return {
    id: l.id,
    arquivo: l.arquivo,
    ambiente: l.ambiente,
    criadoEm: l.criadoEm,
    qtd: l.qtd,
    valorTotal: paraReais(l.valorTotal),
    contagem,
    pendentes: PENDENTES.reduce((s, k) => s + (contagem[k] ?? 0), 0),
  };
}

export async function listarLotes(d: DB, empresaId: string, ambiente: Ambiente) {
  const ls = await d
    .select({ id: lotes.id })
    .from(lotes)
    .where(and(eq(lotes.empresaId, empresaId), eq(lotes.ambiente, ambiente)))
    .orderBy(desc(lotes.criadoEm))
    .limit(50);
  return Promise.all(ls.map((l) => resumoLote(d, empresaId, l.id)));
}

export async function notasDoLote(d: DB, loteId: string) {
  return (await d.select().from(notas).where(eq(notas.loteId, loteId)).orderBy(asc(notas.nDps))).map(notaParaApi);
}

/** Volta para a fila as rejeitadas e as que pararam em "verificar" depois de muitas tentativas. */
export async function reprocessarLote(d: DB | Tx, empresaId: string, loteId: string) {
  const ids = await d
    .select({ id: notas.id, status: notas.status, prox: notas.proximaTentativaEm })
    .from(notas)
    .where(and(eq(notas.loteId, loteId), eq(notas.empresaId, empresaId), inArray(notas.status, ["rejeitada", "verificar"])));
  const alvo = ids.filter((n) => n.status === "rejeitada" || n.prox == null).map((n) => n.id);
  if (!alvo.length) return 0;
  // "verificar" continua "verificar": a fila consulta a Sefin antes de reenviar
  const agora = new Date();
  await d.update(notas).set({ proximaTentativaEm: agora, atualizadoEm: agora }).where(inArray(notas.id, alvo));
  await d.update(notas).set({ status: "fila" }).where(and(inArray(notas.id, alvo), eq(notas.status, "rejeitada")));
  return alvo.length;
}
