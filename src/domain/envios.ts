// Fila de e-mails das notas autorizadas. Cada chamada envia até acabar o orçamento de tempo;
// a próxima (cron ou tela do lote) continua. O lease impede dois envios simultâneos do mesmo
// e-mail, e a chave de idempotência do provedor cobre a queda entre enviar e marcar enviado.
import { and, asc, eq, isNull, lt, lte, or } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { empresa, envios, notas } from "../db/schema.js";
import { fmtDataBR, hojeBR } from "../lib/datas.js";
import { carteiro, EnvioRecusado, type Mensagem } from "../lib/email.js";
import { log } from "../lib/log.js";
import { paraReais } from "./dinheiro.js";
import { arquivosXml } from "./notas.js";

type Envio = typeof envios.$inferSelect;
type Nota = typeof notas.$inferSelect;

const LEASE_MS = 120_000;
export const MAX_TENTATIVAS_EMAIL = 6;
// 5, 10, 20, 40, 80 min… até 6 h
const espera = (t: number) => Math.min(360, 5 * 2 ** (t - 1)) * 60_000;

export const CONSULTA_PUBLICA = {
  producao: "https://www.nfse.gov.br/consultapublica",
  producao_restrita: "https://www.producaorestrita.nfse.gov.br/consultapublica",
} as const;

export async function processarEnvios(d: DB, f: { empresaId?: string } = {}, o: { orcamentoMs?: number; max?: number } = {}) {
  const c = carteiro();
  if (!c) return { configurado: false, enviados: 0, falhas: 0 };
  const inicio = Date.now();
  const orcamento = o.orcamentoMs ?? 15_000;
  let enviados = 0;
  let falhas = 0;
  let n = 0;
  while (Date.now() - inicio < orcamento && n < (o.max ?? Infinity)) {
    const e = await pegarProximo(d, f);
    if (!e) break;
    n++;
    const meu = and(eq(envios.id, e.id), eq(envios.leaseAte, e.leaseAte!));
    try {
      await c.enviar(await montarMensagem(d, e));
      await d.update(envios).set({ status: "enviado", enviadoEm: new Date(), leaseAte: null, ultimoErro: null }).where(meu);
      enviados++;
    } catch (err) {
      falhas++;
      const definitivo = err instanceof EnvioRecusado || e.tentativas >= MAX_TENTATIVAS_EMAIL;
      const msg = err instanceof Error ? err.message : String(err);
      await d
        .update(envios)
        .set({ status: definitivo ? "erro" : "pendente", leaseAte: null, ultimoErro: msg.slice(0, 500), proximaTentativaEm: new Date(Date.now() + espera(e.tentativas)) })
        .where(meu);
      log.warn("e-mail da nota não enviado", { envioId: e.id, notaId: e.notaId, tentativa: e.tentativas, definitivo, erro: msg });
    }
  }
  return { configurado: true, enviados, falhas };
}

async function pegarProximo(d: DB, f: { empresaId?: string }) {
  return d.transaction(async (tx) => {
    const agora = new Date();
    const [e] = await tx
      .select()
      .from(envios)
      .where(
        and(
          eq(envios.status, "pendente"),
          lte(envios.proximaTentativaEm, agora),
          or(isNull(envios.leaseAte), lt(envios.leaseAte, agora)),
          f.empresaId ? eq(envios.empresaId, f.empresaId) : undefined,
        ),
      )
      .orderBy(asc(envios.proximaTentativaEm))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!e) return null;
    const [u] = await tx
      .update(envios)
      .set({ leaseAte: new Date(agora.getTime() + LEASE_MS), tentativas: e.tentativas + 1 })
      .where(eq(envios.id, e.id))
      .returning();
    return u!;
  });
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const brl = (centavos: number) => paraReais(centavos).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export async function montarMensagem(d: DB, e: Envio): Promise<Mensagem> {
  const [n] = await d.select().from(notas).where(eq(notas.id, e.notaId));
  if (!n || !n.chaveAcesso) throw new EnvioRecusado("Nota sem chave de acesso.");
  if (n.status !== "autorizada") throw new EnvioRecusado("A nota foi cancelada antes do envio do e-mail.");
  const [emp] = await d.select({ razao: empresa.razao }).from(empresa).where(eq(empresa.id, e.empresaId));
  const xml = (await arquivosXml(d, n)).find((a) => !a.nome.includes("cancelamento"));
  if (!xml) throw new Error("XML da NFS-e ainda não está gravado.");
  const c = conteudo(n, emp?.razao || "Sua prestadora de serviços");
  return {
    para: e.para,
    assunto: c.assunto,
    html: c.html,
    texto: c.texto,
    anexos: [{ nome: xml.nome, conteudo: xml.xml, tipo: "application/xml" }],
    idempotencia: `nfse-envio-${e.id}`,
  };
}

function conteudo(n: Nota, razao: string) {
  const teste = n.ambiente !== "producao";
  const consulta = CONSULTA_PUBLICA[n.ambiente];
  const emissao = fmtDataBR(hojeBR(n.dhProc ?? new Date()));
  const linhas: [string, string][] = [
    ["NFS-e nº", n.nNfse ?? ""],
    ["Emissão", emissao],
    ["Serviço", n.descricao],
    ["Valor do serviço", brl(n.valor)],
    ...(n.vLiq !== n.valor ? ([["Valor líquido", brl(n.vLiq)]] as [string, string][]) : []),
    ["Vencimento", fmtDataBR(n.vencimento)],
    ["Chave de acesso", n.chaveAcesso!],
  ];
  const assunto = `${teste ? "[TESTE] " : ""}NFS-e nº ${n.nNfse} de ${razao}`;
  const aviso = teste ? "Ambiente de testes: esta nota não tem valor fiscal." : "";
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#101828;line-height:1.5;max-width:560px">
<p>Olá, ${esc(n.tomadorNome)}.</p>
<p>${esc(razao)} emitiu a nota fiscal de serviço abaixo para você.</p>
${aviso ? `<p style="background:#fbf0da;color:#8f5e0c;padding:10px 12px;border-radius:8px">${aviso}</p>` : ""}
<table cellpadding="6" style="border-collapse:collapse;margin:8px 0 16px">
${linhas.map(([k, v]) => `<tr><td style="color:#7a8599;vertical-align:top;white-space:nowrap">${k}</td><td>${esc(v).replace(/\n/g, "<br>")}</td></tr>`).join("\n")}
</table>
<p>O XML da nota vai anexo. Para ver ou baixar o DANFSe, abra a <a href="${consulta}">consulta pública da NFS-e</a> e informe a chave de acesso.</p>
</div>`;
  const texto = [
    `Olá, ${n.tomadorNome}.`,
    "",
    `${razao} emitiu a nota fiscal de serviço abaixo para você.`,
    ...(aviso ? ["", aviso] : []),
    "",
    ...linhas.map(([k, v]) => `${k}: ${v}`),
    "",
    `O XML da nota vai anexo. Para ver ou baixar o DANFSe, abra ${consulta} e informe a chave de acesso.`,
  ].join("\n");
  return { assunto, html, texto };
}
