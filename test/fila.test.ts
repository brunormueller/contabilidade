import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { guardarCertificado } from "../src/cert/certificado.js";
import { lerPfx } from "../src/cert/pfx.js";
import type { DB } from "../src/db/client.js";
import { empresa, notaDocumentos, notas, receber } from "../src/db/schema.js";
import { conferirAssinatura } from "../src/nfse/assinatura.js";
import { MAX_TENTATIVAS, processarFila } from "../src/nfse/fila.js";
import { gerarPfx } from "./certTeste.js";
import { app } from "../src/app.js";
import { comoContador, comoEmpresa } from "./cliente.js";
import { CNPJ_EMPRESA, cenarioBase } from "./helpers.js";
import { instalarSefinFake } from "./sefinFake.js";

type Resumo = { id: string; qtd: number; pendentes: number; contagem: Record<string, number> };
type NotaApi = { id: string; nDPS: number; status: string; numero: string | null; chaveAcesso: string | null; erro: { origem: string; mensagem: string } | null };

let d: DB;
let empresaId: string;
let sefin: ReturnType<typeof instalarSefinFake>;
const cert = gerarPfx({ cnpj: CNPJ_EMPRESA });
const AMB = { ambiente: "producao_restrita" as const };

beforeEach(async () => {
  let adm: { id: string };
  ({ d, empresaId, adm } = await cenarioBase());
  // códigos de IBS/CBS fictícios, só com o formato do XSD
  await d.update(empresa).set({ cTribNacPadrao: "010701", cNbsPadrao: "115021000", pTotTribSn: 600, ibsCbs: { cst: "000", cClassTrib: "000001", indDest: "0" } });
  const [u] = await d.select().from(empresa);
  await d.transaction((tx) => guardarCertificado(tx, { empresaId, cnpjEmpresa: u!.cnpj, pfx: cert.pfx, senha: cert.senha, usuarioId: adm.id }));
  sefin = instalarSefinFake();
});

const linha = (o: Record<string, unknown> = {}) => ({ tomador_documento: "11.444.777/0001-61", tomador_nome: "Metalúrgica Itapocu", descricao: "Manutenção", valor: "1.000,00", ...o });

async function novoLote(linhas = [linha(), linha({ tomador_nome: "Outro Cliente", valor: "250,50" })]) {
  const c = await comoEmpresa();
  const r = await c.post("/api/lotes", { chave: randomUUID(), arquivo: "novembro.xlsx", linhas });
  expect(r.status).toBe(201);
  return { c, lote: ((await r.json()) as { lote: Resumo }).lote };
}
const notasDe = async (c: Awaited<ReturnType<typeof comoEmpresa>>, id: string) =>
  ((await (await c.get(`/api/lotes/${id}`)).json()) as { notas: NotaApi[] }).notas;
const vencerEspera = () => d.update(notas).set({ proximaTentativaEm: new Date(Date.now() - 1000) }).where(eq(notas.status, "verificar"));

describe("criar lote", () => {
  it("cria uma nota por linha válida, com DPS em sequência, e ignora as com erro", async () => {
    const c = await comoEmpresa();
    const r = await c.post("/api/lotes", { chave: randomUUID(), linhas: [linha(), linha({ valor: "0" }), linha({ valor: "10" })] });
    expect(r.status).toBe(201);
    const b = (await r.json()) as { lote: Resumo; ignoradas: { linha: number; erros: string[] }[] };
    expect(b.lote).toMatchObject({ qtd: 2, pendentes: 2, contagem: { fila: 2 } });
    expect(b.ignoradas).toEqual([{ linha: 3, erros: ["Valor deve ser maior que zero"] }]);
    const ns = await notasDe(c, b.lote.id);
    expect(ns.map((n) => n.nDPS)).toEqual([1, 2]);
    expect((await (await c.get("/api/empresa")).json()) as { proxDPS: number }).toMatchObject({ proxDPS: 3 });
  });

  it("mesma chave de envio não cria outro lote; chave repetida com outro conteúdo é recusada", async () => {
    const c = await comoEmpresa();
    const corpo = { chave: randomUUID(), linhas: [linha()] };
    const [a, b] = await Promise.all([c.post("/api/lotes", corpo), c.post("/api/lotes", corpo)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(await d.$count(notas)).toBe(1);
    expect((await c.post("/api/lotes", { ...corpo, linhas: [linha({ valor: "5" })] })).status).toBe(409);
  });

  it("recusa com pendências de configuração e sem gastar número de DPS", async () => {
    await d.update(empresa).set({ pTotTribSn: null });
    const c = await comoEmpresa();
    const r = await c.post("/api/lotes", { chave: randomUUID(), linhas: [linha()] });
    expect(r.status).toBe(409);
    expect(JSON.stringify(await r.json())).toMatch(/pTotTribSN/);
    expect((await (await c.get("/api/empresa")).json()) as { proxDPS: number }).toMatchObject({ proxDPS: 1 });
  });

  it("contador não cria, não processa e não reprocessa", async () => {
    const { lote } = await novoLote();
    const k = await comoContador();
    expect((await k.post("/api/lotes", { chave: randomUUID(), linhas: [linha()] })).status).toBe(403);
    expect((await k.post(`/api/lotes/${lote.id}/processar`)).status).toBe(403);
    expect((await k.post(`/api/lotes/${lote.id}/reprocessar`)).status).toBe(403);
    expect((await k.get(`/api/lotes/${lote.id}`)).status).toBe(200);
  });
});

describe("processar", () => {
  it("autoriza, guarda XML enviado e devolvido e cria a conta a receber com o valor líquido", async () => {
    const { c, lote } = await novoLote();
    const r = (await (await c.post(`/api/lotes/${lote.id}/processar`)).json()) as Resumo & { rodada: { processadas: number } };
    expect(r).toMatchObject({ pendentes: 0, contagem: { autorizada: 2 }, rodada: { processadas: 2 } });
    const ns = await notasDe(c, lote.id);
    expect(ns.every((n) => n.numero && n.chaveAcesso && !n.erro)).toBe(true);

    const contas = await d.select().from(receber);
    expect(contas.map((x) => [x.descricao, x.valor, x.cliente]).sort()).toEqual([
      ["NFS-e nº 1", 1000_00, "Metalúrgica Itapocu"],
      ["NFS-e nº 2", 250_50, "Outro Cliente"],
    ]);
    const docs = await d.select().from(notaDocumentos).where(eq(notaDocumentos.notaId, ns[0]!.id));
    expect(docs.map((x) => x.tipo).sort()).toEqual(["dps", "nfse", "resposta"]);
    const dps = docs.find((x) => x.tipo === "dps")!.conteudo;
    expect(conferirAssinatura(dps, "infDPS", lerPfx(cert.pfx, cert.senha).certPem)).toBe(true);
  });

  it("processa em pedaços: cada chamada respeita o limite e a seguinte continua", async () => {
    const { lote } = await novoLote();
    expect((await processarFila(d, { ...AMB, loteId: lote.id }, { max: 1 })).processadas).toBe(1);
    expect((await processarFila(d, { ...AMB, loteId: lote.id }, { max: 1 })).processadas).toBe(1);
    expect((await processarFila(d, { ...AMB, loteId: lote.id })).processadas).toBe(0);
    expect(sefin.chamadas.emitir).toHaveLength(2);
  });

  it("rejeição fica com o motivo; reprocessar consulta a Sefin antes de reenviar", async () => {
    const { c, lote } = await novoLote([linha()]);
    sefin.roteiro.emitir.push("rejeita");
    await c.post(`/api/lotes/${lote.id}/processar`);
    let [n] = await notasDe(c, lote.id);
    expect(n).toMatchObject({ status: "rejeitada", erro: { origem: "sefin", mensagem: "E9999: Rejeição simulada" } });
    expect(await d.$count(receber)).toBe(0);

    const rp = (await (await c.post(`/api/lotes/${lote.id}/reprocessar`)).json()) as { reprocessadas: number };
    expect(rp.reprocessadas).toBe(1);
    await c.post(`/api/lotes/${lote.id}/processar`);
    [n] = await notasDe(c, lote.id);
    expect(n!.status).toBe("autorizada");
    expect(sefin.chamadas.consultarDps).toHaveLength(1);
    expect(sefin.chamadas.emitir).toHaveLength(2);
  });

  it("timeout depois de a Sefin gerar a nota: não reenvia, busca pela DPS e autoriza uma vez só", async () => {
    const { c, lote } = await novoLote([linha()]);
    sefin.roteiro.emitir.push("gera_sem_responder");
    await c.post(`/api/lotes/${lote.id}/processar`);
    const [n] = await notasDe(c, lote.id);
    expect(n!.status).toBe("verificar");
    // ainda esperando: chamar de novo não faz nada
    expect((await processarFila(d, AMB)).processadas).toBe(0);

    await vencerEspera();
    await c.post(`/api/lotes/${lote.id}/processar`);
    expect((await notasDe(c, lote.id))[0]!.status).toBe("autorizada");
    expect(sefin.chamadas.emitir).toHaveLength(1);
    expect(sefin.chamadas.consultarNfse).toHaveLength(1);
    expect(sefin.geradas.size).toBe(1);
    expect(await d.$count(receber)).toBe(1);
  });

  it("timeout sem gerar: consulta, não acha e reenvia com o mesmo número", async () => {
    const { lote } = await novoLote([linha()]);
    sefin.roteiro.emitir.push("timeout");
    await processarFila(d, AMB);
    await vencerEspera();
    await processarFila(d, AMB);
    expect(sefin.chamadas.emitir).toEqual([sefin.chamadas.emitir[0], sefin.chamadas.emitir[0]]);
    const [n] = await d.select().from(notas).where(eq(notas.loteId, lote.id));
    expect(n).toMatchObject({ status: "autorizada", nDps: 1, tentativas: 2 });
  });

  it("E0014 (DPS já virou NFS-e) vai para verificar e é resolvido pela consulta", async () => {
    await novoLote([linha()]);
    sefin.roteiro.emitir.push("ja_existe");
    await processarFila(d, AMB);
    const [n] = await d.select().from(notas);
    expect(n!.status).toBe("autorizada");
    expect(sefin.chamadas.consultarDps).toHaveLength(1);
  });

  it("Sefin inconsistente (E0014, mas a consulta não acha) para depois do limite de tentativas", async () => {
    await novoLote([linha()]);
    sefin.roteiro.emitir.push("ja_existe");
    sefin.roteiro.consultarDps.push(...Array(MAX_TENTATIVAS).fill("nao_existe"));
    await processarFila(d, AMB);
    const [n] = await d.select().from(notas);
    expect(n).toMatchObject({ status: "verificar", proximaTentativaEm: null, tentativas: MAX_TENTATIVAS });
    expect(sefin.chamadas.emitir).toHaveLength(MAX_TENTATIVAS);
  });

  it("função que caiu no meio: lease vencido, a próxima consulta antes de enviar", async () => {
    await novoLote([linha()]);
    await d.update(notas).set({ status: "processando", tentativas: 1, leaseAte: new Date(Date.now() - 1000) });
    await processarFila(d, AMB);
    expect(sefin.chamadas.consultarDps).toHaveLength(1);
    expect((await d.select().from(notas))[0]!.status).toBe("autorizada");
  });

  it("lease ainda válido não é pego por outra chamada", async () => {
    await novoLote([linha()]);
    await d.update(notas).set({ status: "processando", tentativas: 1, leaseAte: new Date(Date.now() + 60_000) });
    expect((await processarFila(d, AMB)).processadas).toBe(0);
  });

  it("quem perdeu o lease não grava o resultado", async () => {
    await novoLote([linha()]);
    sefin.roteiro.antesDeResponder = async () => {
      await d.update(notas).set({ leaseAte: new Date(Date.now() + 999_000) });
    };
    await processarFila(d, AMB);
    expect((await d.select().from(notas))[0]!.status).toBe("processando");
    expect(await d.$count(receber)).toBe(0);
  });

  it("depois de muitas tentativas incertas, para e espera o Reprocessar", async () => {
    const { c, lote } = await novoLote([linha()]);
    await d.update(notas).set({ tentativas: MAX_TENTATIVAS - 1, status: "verificar" });
    sefin.roteiro.consultarDps.push("incerto");
    await processarFila(d, AMB);
    let [n] = await d.select().from(notas);
    expect(n).toMatchObject({ status: "verificar", proximaTentativaEm: null });
    expect((await processarFila(d, AMB)).processadas).toBe(0);

    await c.post(`/api/lotes/${lote.id}/reprocessar`);
    await c.post(`/api/lotes/${lote.id}/processar`);
    [n] = await d.select().from(notas);
    expect(n!.status).toBe("autorizada");
  });

  it("configuração apagada depois do lote: rejeita local, sem chamar a Sefin", async () => {
    const { c, lote } = await novoLote([linha()]);
    await d.update(empresa).set({ pTotTribSn: null });
    await c.post(`/api/lotes/${lote.id}/processar`);
    const [n] = await notasDe(c, lote.id);
    expect(n).toMatchObject({ status: "rejeitada", erro: { origem: "local" } });
    expect(n!.erro!.mensagem).toMatch(/pTotTribSN/);
    expect(sefin.chamadas.emitir).toHaveLength(0);
  });

  it("só processa notas da própria empresa e do ambiente atual", async () => {
    await novoLote([linha()]);
    expect((await processarFila(d, { ambiente: "producao" })).processadas).toBe(0);
    expect((await processarFila(d, { ...AMB, empresaId: randomUUID() })).processadas).toBe(0);
    expect(
      await d.$count(notas, and(eq(notas.status, "fila"), eq(notas.empresaId, empresaId))),
    ).toBe(1);
  });
});

describe("cron", () => {
  it("exige o segredo e processa a fila", async () => {
    await novoLote([linha()]);
    expect((await app.request("http://localhost/api/cron/processar")).status).toBe(401);
    expect((await app.request("http://localhost/api/cron/processar", { headers: { authorization: "Bearer errado" } })).status).toBe(401);
    const r = await app.request("http://localhost/api/cron/processar", { headers: { authorization: "Bearer segredo-de-teste" } });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ processadas: 1, resultado: { autorizada: 1 } });
  });
});
