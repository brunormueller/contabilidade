// Faturamento mensal: uma nota por cliente com a mensalidade do plano mais os serviços avulsos
// ainda não cobrados. Vira um lote comum, então a fila, o reprocessamento e a tela do lote
// servem igual. A tabela "faturas" garante uma mensalidade por cliente por mês; o item da
// visita aponta para a nota que o cobrou.
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNotNull, isNull, lte, ne, or } from "drizzle-orm";
import type { DB, Tx } from "../db/client.js";
import { auditoria, clientes, empresa, faturas, notas, planos, visitaItens, visitas } from "../db/schema.js";
import type { Ambiente } from "../env.js";
import { addDias, addMeses, fimDoMes } from "../lib/datas.js";
import { HttpError } from "../lib/erros.js";
import { log } from "../lib/log.js";
import { paraReais } from "./dinheiro.js";
import { carregarEmpresa } from "./empresa.js";
import { criarLote, hashLinhas, padroesDaEmpresa } from "./lotes.js";
import { validarLinhas } from "./planilha.js";

/** Se o servidor ficar fora do ar no dia, a emissão automática ainda acontece nos dias seguintes. */
export const TOLERANCIA_DIAS = 5;

/** Data da emissão no mês: dia 31 em fevereiro vira o último dia. */
export function dataEmissao(mes: string, dia: number) {
  const ultimo = Number(fimDoMes(mes).slice(8));
  return `${mes}-${String(Math.min(dia, ultimo)).padStart(2, "0")}`;
}

/** Próxima data em que a emissão automática roda, ou null se está desligada. */
export function proximaEmissao(dia: number | null, desde: string | null, hoje: string) {
  if (dia == null) return null;
  let mes = hoje.slice(0, 7);
  for (let i = 0; i < 3; i++) {
    const data = dataEmissao(mes, dia);
    if (data >= hoje && (!desde || data >= desde)) return data;
    mes = addMeses(`${mes}-01`, 1).slice(0, 7);
  }
  return null;
}

const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
export const nomeMes = (mes: string) => `${MESES[Number(mes.slice(5)) - 1]} de ${mes.slice(0, 4)}`;
const brl = (centavos: number) => paraReais(centavos).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

type Item = { clienteId: string; visitaId: string; servicoId: string; nome: string; valor: number; data: string };

/** Situação do mês, cliente a cliente: o que já foi faturado e o que entraria agora. */
export async function previa(d: DB | Tx, empresaId: string, ambiente: Ambiente, mes: string, hoje: string) {
  const cs = await d
    .select({
      id: clientes.id,
      nome: clientes.nome,
      doc: clientes.doc,
      email: clientes.email,
      planoNome: planos.nome,
      planoDescricao: planos.descricao,
      planoValor: planos.valor,
    })
    .from(clientes)
    .leftJoin(planos, eq(planos.id, clientes.planoId))
    .where(and(eq(clientes.empresaId, empresaId), eq(clientes.ativo, true)))
    .orderBy(asc(clientes.nome));

  // serviço cobrado em nota de outro ambiente (teste) continua livre neste
  const itens: Item[] = await d
    .select({
      clienteId: visitas.clienteId,
      visitaId: visitaItens.visitaId,
      servicoId: visitaItens.servicoId,
      nome: visitaItens.nome,
      valor: visitaItens.valor,
      data: visitas.data,
    })
    .from(visitaItens)
    .innerJoin(visitas, eq(visitas.id, visitaItens.visitaId))
    .leftJoin(notas, eq(notas.id, visitaItens.notaId))
    .where(and(eq(visitas.empresaId, empresaId), lte(visitas.data, hoje), or(isNull(visitaItens.notaId), ne(notas.ambiente, ambiente))))
    .orderBy(asc(visitas.data));

  const fat = await d
    .select({ clienteId: faturas.clienteId, notaId: faturas.notaId, status: notas.status, numero: notas.nNfse, loteId: notas.loteId })
    .from(faturas)
    .innerJoin(notas, eq(notas.id, faturas.notaId))
    .where(and(eq(faturas.empresaId, empresaId), eq(faturas.ambiente, ambiente), eq(faturas.mes, mes)));

  return cs.map((c) => {
    const its = itens.filter((i) => i.clienteId === c.id);
    const fatura = fat.find((f) => f.clienteId === c.id) ?? null;
    const mensalidade = fatura ? 0 : (c.planoValor ?? 0);
    const extras = its.reduce((s, i) => s + i.valor, 0);
    return { cliente: c, itens: its, fatura, mensalidade, extras, total: mensalidade + extras };
  });
}

type Previa = Awaited<ReturnType<typeof previa>>[number];

/** Serviços iguais juntos: "Troca de filtro (2x)". */
export function agruparItens(its: { nome: string; valor: number }[]) {
  const g = new Map<string, { nome: string; qtd: number; valor: number }>();
  for (const i of its) {
    const x = g.get(i.nome) ?? { nome: i.nome, qtd: 0, valor: 0 };
    x.qtd++;
    x.valor += i.valor;
    g.set(i.nome, x);
  }
  return [...g.values()];
}

function descricao(p: Previa, mes: string) {
  const partes: string[] = [];
  if (p.mensalidade) partes.push(`${p.cliente.planoDescricao || `Mensalidade do plano ${p.cliente.planoNome}`}, ${nomeMes(mes)}: ${brl(p.mensalidade)}.`);
  if (p.itens.length)
    partes.push(`Serviços avulsos: ${agruparItens(p.itens).map((i) => `${i.nome}${i.qtd > 1 ? ` (${i.qtd}x)` : ""} ${brl(i.valor)}`).join("; ")}.`);
  const s = partes.join("\n");
  return s.length > 2000 ? `${s.slice(0, 1997)}...` : s;
}

const violouUnico = (e: unknown): boolean => {
  const x = e as { code?: string; cause?: unknown };
  return x?.code === "23505" || (x?.cause != null && violouUnico(x.cause));
};

/**
 * Emite as notas do mês para quem ainda não foi faturado. Cliente com cadastro que a nota
 * recusaria (documento, e-mail...) fica de fora e volta em "ignorados".
 */
export async function faturarMes(
  d: DB,
  a: {
    empresaId: string;
    ambiente: Ambiente;
    hoje: string;
    usuarioId: string | null;
    automatica: boolean;
    auditar?: (tx: Tx, loteId: string, dados: Record<string, unknown>) => Promise<void>;
  },
) {
  const mes = a.hoje.slice(0, 7);
  const e = await carregarEmpresa(d, a.empresaId);
  const pv = (await previa(d, a.empresaId, a.ambiente, mes, a.hoje)).filter((p) => !p.fatura && p.total > 0);
  if (!pv.length) return { loteId: null, qtd: 0, ignorados: [] as { cliente: string; erros: string[] }[] };

  const objs = pv.map((p) => ({
    tomador_documento: p.cliente.doc,
    tomador_nome: p.cliente.nome,
    tomador_email: p.cliente.email,
    descricao: descricao(p, mes),
    valor: paraReais(p.total),
  }));
  const v = validarLinhas(objs, padroesDaEmpresa(e), a.hoje);
  const ignorados = v.rows.flatMap((r, k) => (r.errors.length ? [{ cliente: pv[k]!.cliente.nome, erros: r.errors }] : []));
  const boas = v.rows.flatMap((r, k) => (r.errors.length ? [] : [{ r, p: pv[k]! }]));
  if (!boas.length) return { loteId: null, qtd: 0, ignorados };

  // a linha da nota casa a nota com o cliente dentro da transação
  const linhas = boas.map((x, k) => ({ ...x.r, i: k + 1 }));
  const porLinha = new Map(linhas.map((l, k) => [l.i, boas[k]!.p]));
  try {
    const r = await criarLote(
      d,
      {
        empresaId: a.empresaId,
        usuarioId: a.usuarioId,
        ambiente: a.ambiente,
        arquivo: `Faturamento de ${nomeMes(mes)}`,
        chave: `fat-${mes}-${randomUUID()}`,
        hash: hashLinhas(linhas),
        linhas,
        hoje: a.hoje,
      },
      async (tx, loteId) => {
        const ns = await tx.select({ id: notas.id, linha: notas.linha }).from(notas).where(eq(notas.loteId, loteId));
        for (const n of ns) {
          const p = porLinha.get(n.linha!)!;
          // índice único (ambiente, cliente, mês): faturamento simultâneo desfaz a transação inteira
          await tx
            .insert(faturas)
            .values({ empresaId: a.empresaId, ambiente: a.ambiente, clienteId: p.cliente.id, mes, notaId: n.id, mensalidade: p.mensalidade, extras: p.extras, automatica: a.automatica });
          for (const it of p.itens)
            await tx
              .update(visitaItens)
              .set({ notaId: n.id })
              .where(and(eq(visitaItens.visitaId, it.visitaId), eq(visitaItens.servicoId, it.servicoId)));
        }
        const dados = { mes, notas: ns.length, automatica: a.automatica, ignorados: ignorados.length };
        if (a.auditar) await a.auditar(tx, loteId, dados);
        else await tx.insert(auditoria).values({ empresaId: a.empresaId, usuarioId: a.usuarioId, acao: "faturar_mes", entidade: "lote", entidadeId: loteId, dados });
      },
    );
    return { loteId: r.lote.id, qtd: linhas.length, ignorados };
  } catch (err) {
    if (violouUnico(err)) throw new HttpError(409, "Outro faturamento deste mês acabou de ser criado. Atualize a tela.");
    throw err;
  }
}

/** Chamado pelo cron todo dia: fatura as empresas cujo dia de emissão chegou. */
export async function faturarDoDia(d: DB, ambiente: Ambiente, hoje: string) {
  const mes = hoje.slice(0, 7);
  const es = await d
    .select({ id: empresa.id, dia: empresa.diaEmissao, desde: empresa.faturamentoDesde })
    .from(empresa)
    .where(isNotNull(empresa.diaEmissao));
  const out: { empresaId: string; qtd?: number; ignorados?: number; erro?: string }[] = [];
  for (const e of es) {
    const data = dataEmissao(mes, e.dia!);
    if (hoje < data || hoje > addDias(data, TOLERANCIA_DIAS) || (e.desde && data < e.desde)) continue;
    try {
      const r = await faturarMes(d, { empresaId: e.id, ambiente, hoje, usuarioId: null, automatica: true });
      out.push({ empresaId: e.id, qtd: r.qtd, ignorados: r.ignorados.length });
      if (r.ignorados.length) log.warn("faturamento: clientes ignorados", { empresaId: e.id, ignorados: r.ignorados });
    } catch (err) {
      log.error("faturamento automático falhou", { empresaId: e.id, erro: err });
      out.push({ empresaId: e.id, erro: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
