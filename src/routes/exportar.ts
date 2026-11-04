import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { db } from "../db/client.js";
import { notas, pagar, receber } from "../db/schema.js";
import { intParaPct, paraReais } from "../domain/dinheiro.js";
import { fmtDoc } from "../domain/documentos.js";
import { env } from "../env.js";
import { csv, dec } from "../lib/csv.js";
import { fimDoMes, fmtDataBR, MES } from "../lib/datas.js";
import { invalido } from "../lib/erros.js";
import type { AppEnv } from "../tipos.js";

export const rotaExportar = new Hono<AppEnv>();

const fmtDH = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });
const fmtServ = (s: string) => (s.length === 6 ? `${s.slice(0, 2)}.${s.slice(2, 4)}.${s.slice(4)}` : s);
const fmtNBS = (s: string) => (s.length === 9 ? `${s[0]}.${s.slice(1, 5)}.${s.slice(5, 7)}.${s.slice(7)}` : s);

function mes(c: Context<AppEnv>) {
  const ym = c.req.param("ym")!;
  if (!MES.test(ym)) throw invalido("Mês inválido. Use AAAA-MM.");
  return { ym, de: `${ym}-01`, ate: fimDoMes(ym) };
}

async function dadosDoMes(c: Context<AppEnv>) {
  const { ym, de, ate } = mes(c);
  const { empresaId } = c.get("user");
  const amb = env().NFSE_AMBIENTE;
  const d = await db();
  const ns = await d
    .select()
    .from(notas)
    .where(
      and(
        eq(notas.empresaId, empresaId),
        eq(notas.ambiente, amb),
        inArray(notas.status, ["autorizada", "cancelada"]),
        gte(notas.competencia, de),
        lte(notas.competencia, ate),
      ),
    )
    .orderBy(asc(notas.nDps));
  const rec = await d
    .select()
    .from(receber)
    .where(and(eq(receber.empresaId, empresaId), eq(receber.ambiente, amb), gte(receber.recebidoEm, de), lte(receber.recebidoEm, ate)));
  const pag = await d
    .select()
    .from(pagar)
    .where(and(eq(pagar.empresaId, empresaId), gte(pagar.pagoEm, de), lte(pagar.pagoEm, ate)));
  return { ym, ns, rec, pag };
}

function arquivo(c: Context, nome: string, conteudo: string) {
  return c.body(conteudo, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${nome}"`,
  });
}

rotaExportar.get("/:ym", async (c) => {
  const { ym, ns, rec, pag } = await dadosDoMes(c);
  const aut = ns.filter((n) => n.status === "autorizada");
  return c.json({
    mes: ym,
    notasAutorizadas: aut.length,
    notasTotal: ns.length,
    faturamento: paraReais(aut.reduce((a, n) => a + n.valor, 0)),
    recebido: paraReais(rec.reduce((a, t) => a + t.valor, 0)),
    pago: paraReais(pag.reduce((a, t) => a + t.valor, 0)),
    temMovimento: rec.length + pag.length > 0,
  });
});

rotaExportar.get("/:ym/notas.csv", async (c) => {
  const { ym, ns } = await dadosDoMes(c);
  const linhas = ns.map((n) => [
    n.nNfse ?? "",
    n.dhProc ? fmtDH.format(n.dhProc) : "",
    fmtDataBR(n.competencia),
    n.tomadorNome,
    fmtDoc(n.tomadorDoc),
    fmtServ(n.cTribNac),
    n.cNbs ? fmtNBS(n.cNbs) : "",
    n.descricao,
    dec(paraReais(n.valor)),
    n.issRetido ? "Sim" : "Não",
    n.issRetido && n.aliqIss != null ? dec(intParaPct(n.aliqIss)!) : "",
    dec(paraReais(n.vIssRet)),
    dec(paraReais(n.vInssRet)),
    dec(paraReais(n.vLiq)),
    n.status === "autorizada" ? "Autorizada" : "Cancelada",
    n.chaveAcesso ?? "",
  ]);
  const cab = ["Número", "Emissão", "Competência", "Tomador", "CPF/CNPJ", "Código serviço", "Código NBS", "Descrição", "Valor", "ISS retido", "Alíquota ISS", "Valor ISS retido", "Valor INSS retido", "Valor líquido", "Situação", "Chave de acesso"];
  return arquivo(c, `notas-${ym}.csv`, csv([cab, ...linhas]));
});

rotaExportar.get("/:ym/financeiro.csv", async (c) => {
  const { ym, rec, pag } = await dadosDoMes(c);
  const linhas = [
    ...rec.map((t) => ["Recebimento", fmtDataBR(t.recebidoEm), fmtDataBR(t.venc), t.cliente, t.descricao, "", dec(paraReais(t.valor))]),
    ...pag.map((t) => ["Pagamento", fmtDataBR(t.pagoEm), fmtDataBR(t.venc), t.fornecedor, t.descricao, t.categoria, dec(-paraReais(t.valor))]),
  ];
  const cab = ["Tipo", "Data", "Vencimento", "Cliente/Fornecedor", "Descrição", "Categoria", "Valor"];
  return arquivo(c, `financeiro-${ym}.csv`, csv([cab, ...linhas]));
});
