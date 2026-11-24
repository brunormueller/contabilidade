import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guardarCertificado } from "../src/cert/certificado.js";
import type { DB } from "../src/db/client.js";
import { empresa, envios, faturas, notas, rotas, visitaItens, visitas } from "../src/db/schema.js";
import { processarEnvios } from "../src/domain/envios.js";
import { dataEmissao, faturarDoDia, proximaEmissao } from "../src/domain/faturamento.js";
import { criarUsuario } from "../src/domain/usuarios.js";
import { addDias, hojeBR } from "../src/lib/datas.js";
import { EnvioRecusado, type Mensagem, usarCarteiro } from "../src/lib/email.js";
import { processarFila } from "../src/nfse/fila.js";
import { gerarPfx } from "./certTeste.js";
import { cliente, comoContador, comoEmpresa } from "./cliente.js";
import { CNPJ_EMPRESA, cenarioBase, SENHA } from "./helpers.js";
import { instalarSefinFake } from "./sefinFake.js";

let d: DB;
let empresaId: string;
let enviados: Mensagem[];
let falhar: Error | null;
const cert = gerarPfx({ cnpj: CNPJ_EMPRESA });
const hoje = hojeBR();
const AMB = { ambiente: "producao_restrita" as const };

beforeEach(async () => {
  let adm: { id: string };
  ({ d, empresaId, adm } = await cenarioBase());
  await d.update(empresa).set({ cTribNacPadrao: "010701", cNbsPadrao: "115021000", pTotTribSn: 600, ibsCbs: { cst: "000", cClassTrib: "000001", indDest: "0" } });
  await d.transaction((tx) => guardarCertificado(tx, { empresaId, cnpjEmpresa: CNPJ_EMPRESA, pfx: cert.pfx, senha: cert.senha, usuarioId: adm.id }));
  instalarSefinFake();
  enviados = [];
  falhar = null;
  usarCarteiro({
    async enviar(m) {
      if (falhar) throw falhar;
      enviados.push(m);
    },
  });
});
afterEach(() => usarCarteiro(null));

const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
type Previa = { clientes: { nome: string; mensalidade: number; extras: number; total: number; fatura: { notaId: string } | null; itens: { nome: string; qtd: number }[] }[] };

/** Ana com plano e dois serviços avulsos; Bruna com plano; Carla sem plano nem avulsos. */
async function montar() {
  const e = await comoEmpresa();
  const plano = await json<{ id: string }>(e.post("/api/planos", { nome: "Mensal", descricao: "Manutenção mensal de piscina", valor: 350 }));
  const filtro = await json<{ id: string }>(e.post("/api/servicos", { nome: "Troca de filtro", valor: 80 }));
  const ana = await json<{ id: string }>(e.post("/api/clientes", { nome: "Ana", doc: "52998224725", email: "ana@cliente.com", planoId: plano.id }));
  const bruna = await json<{ id: string }>(e.post("/api/clientes", { nome: "Bruna Ltda", doc: "11444777000161", planoId: plano.id }));
  await e.post("/api/clientes", { nome: "Carla", doc: "11144477735" });
  // duas visitas concluídas da Ana com troca de filtro
  const f = await criarUsuario(d, { empresaId, nome: "Fábio", email: "fabio@empresa.com.br", perfil: "funcionario", senha: SENHA });
  const [r] = await d.insert(rotas).values({ empresaId, nome: "R", funcionarioId: f.id, dias: [1] }).returning();
  for (const dia of [addDias(hoje, -7), addDias(hoje, -1)]) {
    const [v] = await d
      .insert(visitas)
      .values({ empresaId, rotaId: r!.id, clienteId: ana.id, funcionarioId: f.id, data: dia, ordem: 1, status: "concluida" })
      .returning();
    await d.insert(visitaItens).values({ visitaId: v!.id, servicoId: filtro.id, nome: "Troca de filtro", valor: 8000 });
  }
  return { e, plano, ana, bruna };
}

describe("datas do faturamento", () => {
  it("dia 31 vira o último dia do mês; próxima emissão respeita quando foi configurado", () => {
    expect(dataEmissao("2026-02", 31)).toBe("2026-02-28");
    expect(dataEmissao("2028-02", 30)).toBe("2028-02-29");
    expect(dataEmissao("2026-11", 5)).toBe("2026-11-05");
    expect(proximaEmissao(null, null, "2026-11-12")).toBeNull();
    expect(proximaEmissao(5, null, "2026-11-12")).toBe("2026-12-05");
    expect(proximaEmissao(20, "2026-11-12", "2026-11-12")).toBe("2026-11-20");
    expect(proximaEmissao(12, "2026-11-12", "2026-11-12")).toBe("2026-11-12");
  });
});

describe("emitir agora", () => {
  it("uma nota por cliente com mensalidade + avulsos; quem não tem nada a cobrar fica de fora", async () => {
    const { e, ana } = await montar();
    const antes = await json<Previa>(e.get("/api/faturamento"));
    expect(antes.clientes.map((c) => [c.nome, c.mensalidade, c.extras, c.total])).toEqual([
      ["Ana", 350, 160, 510],
      ["Bruna Ltda", 350, 0, 350],
      ["Carla", 0, 0, 0],
    ]);
    expect(antes.clientes[0]!.itens).toEqual([{ nome: "Troca de filtro", qtd: 2, valor: 160 }]);

    const r = await e.post("/api/faturamento/emitir");
    expect(r.status).toBe(201);
    const b = (await r.json()) as { qtd: number; lote: { id: string; qtd: number; valorTotal: number } };
    expect(b).toMatchObject({ qtd: 2, lote: { qtd: 2, valorTotal: 860 } });

    const ns = await d.select().from(notas).where(eq(notas.loteId, b.lote.id));
    const nAna = ns.find((n) => n.tomadorNome === "Ana")!;
    expect(nAna).toMatchObject({ valor: 51000, tomadorEmail: "ana@cliente.com", competencia: hoje, cTribNac: "010701" });
    expect(nAna.descricao).toMatch(/^Manutenção mensal de piscina, .+: R\$\s?350,00\.\nServiços avulsos: Troca de filtro \(2x\) R\$\s?160,00\.$/);
    expect((await d.select().from(visitaItens)).every((i) => i.notaId === nAna.id)).toBe(true);
    expect(await d.select().from(faturas).where(eq(faturas.clienteId, ana.id))).toHaveLength(1);

    // de novo no mesmo mês: nada a emitir, e a prévia mostra quem já foi faturado
    expect(await json(e.post("/api/faturamento/emitir"))).toMatchObject({ qtd: 0, lote: null });
    const depois = await json<Previa>(e.get("/api/faturamento"));
    expect(depois.clientes.map((c) => [c.nome, c.total, c.fatura != null])).toEqual([
      ["Ana", 0, true],
      ["Bruna Ltda", 0, true],
      ["Carla", 0, false],
    ]);
  });

  it("cadastro que a nota recusaria volta em ignorados, sem gastar número", async () => {
    const { e } = await montar();
    await d.update(empresa).set({ cTribNacPadrao: "" });
    const b = await json<{ qtd: number; ignorados: { cliente: string; erros: string[] }[] }>(e.post("/api/faturamento/emitir"));
    expect(b.qtd).toBe(0);
    expect(b.ignorados.map((i) => i.cliente)).toEqual(["Ana", "Bruna Ltda"]);
    expect(b.ignorados[0]!.erros.join()).toMatch(/Código de serviço/);
    expect(await d.$count(notas)).toBe(0);
  });

  it("nota cancelada libera o mês e os avulsos para faturar de novo", async () => {
    const { e } = await montar();
    await e.post("/api/faturamento/emitir");
    await processarFila(d, AMB);
    const nAna = (await d.select().from(notas)).find((n) => n.tomadorNome === "Ana")!;
    expect(nAna.status).toBe("autorizada");
    const c = await e.post(`/api/notas/${nAna.id}/cancelar`, { cMotivo: "1", xMotivo: "Erro no valor do serviço informado" });
    expect(c.status).toBe(200);
    expect((await d.select().from(visitaItens)).every((i) => i.notaId === null)).toBe(true);
    const b = await json<{ qtd: number; lote: { valorTotal: number } }>(e.post("/api/faturamento/emitir"));
    expect(b).toMatchObject({ qtd: 1, lote: { valorTotal: 510 } });
  });

  it("visita com serviço já faturado não pode ser reaberta", async () => {
    const { e } = await montar();
    const [v] = await d.select().from(visitas);
    await d.update(visitas).set({ data: hoje }).where(eq(visitas.id, v!.id));
    await e.post("/api/faturamento/emitir");
    const r = await e.post(`/api/visitas/${v!.id}/reabrir`);
    expect(r.status).toBe(409);
    expect((await json<{ erro: string }>(r)).erro).toMatch(/nota/);
  });

  it("contador e funcionário não faturam nem configuram", async () => {
    await montar();
    const cont = await comoContador();
    expect((await cont.get("/api/faturamento")).status).toBe(200);
    expect((await cont.post("/api/faturamento/emitir")).status).toBe(403);
    expect((await cont.put("/api/faturamento/config", { diaEmissao: 5, enviarEmail: true })).status).toBe(403);
    const f = await cliente().login("fabio@empresa.com.br");
    expect((await f.get("/api/faturamento")).status).toBe(403);
  });
});

describe("emissão automática", () => {
  const cron = () => cliente().req("GET", "/api/cron/processar", undefined, { authorization: "Bearer segredo-de-teste" });

  it("no dia configurado o cron emite, processa e manda os e-mails; não repete no dia seguinte", async () => {
    const { e } = await montar();
    const dia = Number(hoje.slice(8));
    expect((await e.put("/api/faturamento/config", { diaEmissao: 32, enviarEmail: true })).status).toBe(400);
    await e.put("/api/faturamento/config", { diaEmissao: dia, enviarEmail: true });
    // configurado antes do dia
    await d.update(empresa).set({ faturamentoDesde: addDias(hoje, -3) });

    const r = await json<{ faturamento: { qtd: number }[]; resultado: Record<string, number>; emails: { enviados: number } }>(cron());
    expect(r.faturamento).toEqual([{ empresaId, qtd: 2, ignorados: 0 }]);
    expect(r.resultado).toEqual({ autorizada: 2 });
    // só a Ana tem e-mail
    expect(r.emails).toMatchObject({ configurado: true, enviados: 1, falhas: 0 });
    const m = enviados[0]!;
    expect(m.para).toBe("ana@cliente.com");
    expect(m.assunto).toMatch(/^\[TESTE\] NFS-e nº \d+ de Empresa Teste Ltda$/);
    expect(m.html).toContain("producaorestrita.nfse.gov.br/consultapublica");
    expect(m.anexos).toHaveLength(1);
    expect(m.anexos[0]!.nome).toMatch(/^NFSe-\d+\.xml$/);
    expect(m.anexos[0]!.conteudo).toContain("<NFSe>");
    const [env] = await d.select().from(envios);
    expect(env).toMatchObject({ status: "enviado", tentativas: 1 });

    const r2 = await json<{ faturamento: { qtd: number }[] }>(cron());
    expect(r2.faturamento).toEqual([{ empresaId, qtd: 0, ignorados: 0 }]);
    expect(await d.$count(notas)).toBe(2);
  });

  it("não fatura sozinho mês cujo dia passou antes de configurar, nem fora da tolerância", async () => {
    await montar();
    const dia = Number(hoje.slice(8));
    await d.update(empresa).set({ diaEmissao: dia, faturamentoDesde: addDias(hoje, 1) });
    expect(await faturarDoDia(d, "producao_restrita", hoje)).toEqual([]);
    await d.update(empresa).set({ faturamentoDesde: null });
    expect(await faturarDoDia(d, "producao_restrita", addDias(hoje, 6))).toEqual([]);
    expect(await faturarDoDia(d, "producao_restrita", addDias(hoje, 5))).toMatchObject([{ qtd: 2 }]);
  });

  it("sem envio ligado não cria e-mail", async () => {
    const { e } = await montar();
    await e.post("/api/faturamento/emitir");
    await processarFila(d, AMB);
    expect(await d.$count(envios)).toBe(0);
  });
});

describe("e-mails", () => {
  async function notaComEmail() {
    const { e } = await montar();
    await d.update(empresa).set({ enviarEmail: true });
    await e.post("/api/faturamento/emitir");
    await processarFila(d, AMB);
    return e;
  }

  it("falha passageira tenta de novo depois; recusa do provedor vira erro e pode ser reenviada para outro endereço", async () => {
    const e = await notaComEmail();
    falhar = new Error("Resend respondeu 503");
    expect(await processarEnvios(d)).toMatchObject({ enviados: 0, falhas: 1 });
    let [x] = await d.select().from(envios);
    expect(x).toMatchObject({ status: "pendente", tentativas: 1 });
    expect(x!.proximaTentativaEm.getTime()).toBeGreaterThan(Date.now());

    await d.update(envios).set({ proximaTentativaEm: new Date(Date.now() - 1000) });
    falhar = new EnvioRecusado("Resend respondeu 422: invalid to");
    await processarEnvios(d);
    [x] = await d.select().from(envios);
    expect(x).toMatchObject({ status: "erro", tentativas: 2 });

    const lista = await json<{ envios: { id: string; status: string; ultimoErro: string }[] }>(e.get("/api/faturamento"));
    expect(lista.envios[0]).toMatchObject({ status: "erro", ultimoErro: expect.stringMatching(/422/) });
    expect((await e.post(`/api/faturamento/envios/${x!.id}/reenviar`, { para: "x@" })).status).toBe(400);
    falhar = null;
    // reenviar já tenta mandar, sem esperar o cron
    expect(await json(e.post(`/api/faturamento/envios/${x!.id}/reenviar`, { para: "Financeiro@Ana.com" }))).toMatchObject({ enviados: 1 });
    expect(enviados[0]!.para).toBe("financeiro@ana.com");
    expect(enviados[0]!.idempotencia).not.toBe(`nfse-envio-${x!.id}`); // registro novo, chave nova
  });

  it("enviar pendentes agora não espera o horário da próxima tentativa", async () => {
    const e = await notaComEmail();
    falhar = new Error("timeout");
    await processarEnvios(d);
    falhar = null;
    expect(await processarEnvios(d)).toMatchObject({ enviados: 0 }); // ainda esperando
    expect(await json(e.post("/api/faturamento/envios/processar"))).toMatchObject({ enviados: 1 });
    expect((await (await comoContador()).post("/api/faturamento/envios/processar")).status).toBe(403);
  });

  it("sem e-mail configurado no servidor, os envios esperam na fila", async () => {
    const e = await notaComEmail();
    usarCarteiro(null);
    expect(await processarEnvios(d)).toMatchObject({ configurado: false });
    expect(await json(e.get("/api/faturamento"))).toMatchObject({ emailConfigurado: false, envios: [{ status: "pendente" }] });
  });

  it("nota cancelada antes do envio não é mandada", async () => {
    await notaComEmail();
    const [x] = await d.select().from(envios);
    await d.update(notas).set({ status: "cancelada" }).where(eq(notas.id, x!.notaId));
    await processarEnvios(d);
    expect(enviados).toHaveLength(0);
    expect((await d.select().from(envios))[0]).toMatchObject({ status: "erro", ultimoErro: expect.stringMatching(/cancelada/) });
  });
});
