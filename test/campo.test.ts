import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../src/db/client.js";
import { auditoria, visitaItens, visitas } from "../src/db/schema.js";
import { diaDaSemana, garantirVisitas } from "../src/domain/campo.js";
import { criarUsuario } from "../src/domain/usuarios.js";
import { addDias, hojeBR } from "../src/lib/datas.js";
import { CNPJ_EMPRESA, cenarioBase, SENHA } from "./helpers.js";
import { cliente, comoContador, comoEmpresa } from "./cliente.js";

let d: DB;
let empresaId: string;
let func: { id: string };
beforeEach(async () => {
  ({ d, empresaId } = await cenarioBase());
  func = await criarUsuario(d, { empresaId, nome: "Fábio", email: "fabio@empresa.com.br", perfil: "funcionario", senha: SENHA });
});

const hoje = hojeBR();
const dow = diaDaSemana(hoje);
const comoFuncionario = () => cliente().login("fabio@empresa.com.br");
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;

type Visita = { id: string; status: string; clienteNome: string; ordem: number; itens: { nome: string; valor: number }[]; extras: number };

/** Plano, dois serviços, três clientes e uma rota de hoje com os três. */
async function montar() {
  const e = await comoEmpresa();
  const plano = await json<{ id: string }>(e.post("/api/planos", { nome: "Mensal", descricao: "Manutenção mensal", valor: 350 }));
  const s1 = await json<{ id: string }>(e.post("/api/servicos", { nome: "Troca de filtro", valor: 80 }));
  const s2 = await json<{ id: string }>(e.post("/api/servicos", { nome: "Limpeza extra", valor: 45.5 }));
  const cli = [];
  for (const [nome, doc] of [
    ["Ana", "52998224725"],
    ["Bruna Ltda", "11444777000161"],
    ["Carla", "11144477735"],
  ] as const)
    cli.push(await json<{ id: string }>(e.post("/api/clientes", { nome, doc, endereco: `Rua ${nome}, 1`, planoId: plano.id })));
  const rota = await json<{ id: string }>(
    e.post("/api/rotas", { nome: "Centro", funcionarioId: func.id, dias: [dow], clientes: cli.map((c) => c.id) }),
  );
  return { e, plano, s1, s2, cli, rota };
}

describe("cadastros", () => {
  it("cliente valida documento, e-mail, plano e a própria empresa; contador só lê", async () => {
    const e = await comoEmpresa();
    const base = { nome: "Ana", doc: "529.982.247-25", email: "ANA@x.com" };
    expect((await e.post("/api/clientes", { ...base, doc: "123" })).status).toBe(400);
    expect((await e.post("/api/clientes", { ...base, email: "ana@" })).status).toBe(400);
    expect((await e.post("/api/clientes", { ...base, doc: CNPJ_EMPRESA })).status).toBe(400);
    expect((await e.post("/api/clientes", { ...base, planoId: crypto.randomUUID() })).status).toBe(400);
    const r = await e.post("/api/clientes", base);
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ doc: "52998224725", email: "ana@x.com", planoId: null });

    const cont = await comoContador();
    expect(await json<unknown[]>(cont.get("/api/clientes"))).toHaveLength(1);
    expect((await cont.post("/api/clientes", base)).status).toBe(403);
    expect((await cont.post("/api/planos", { nome: "X", valor: 1 })).status).toBe(403);
  });

  it("plano em uso não é removido; id inválido vira 404", async () => {
    const { e, plano, cli } = await montar();
    expect((await e.del(`/api/planos/${plano.id}`)).status).toBe(400);
    for (const c of cli) await e.put(`/api/clientes/${c.id}`, { nome: "X", doc: "52998224725", planoId: null });
    expect((await e.del(`/api/planos/${plano.id}`)).status).toBe(200);
    expect(await json<unknown[]>(e.get("/api/planos"))).toHaveLength(0);
    expect((await e.del("/api/planos/nao-e-uuid")).status).toBe(404);
  });

  it("rota só aceita funcionário ativo, cliente da empresa e sem repetição", async () => {
    const { e, cli } = await montar();
    const base = { nome: "R", funcionarioId: func.id, dias: [1], clientes: [cli[0]!.id] };
    const adm = await json<{ id: string }[]>(e.get("/api/usuarios"));
    expect((await e.post("/api/rotas", { ...base, funcionarioId: adm[0]!.id })).status).toBe(400);
    expect((await e.post("/api/rotas", { ...base, clientes: [cli[0]!.id, cli[0]!.id] })).status).toBe(400);
    expect((await e.post("/api/rotas", { ...base, clientes: [crypto.randomUUID()] })).status).toBe(400);
    expect((await e.post("/api/rotas", { ...base, dias: [] })).status).toBe(400);
    expect((await e.post("/api/rotas", { ...base, dias: [7] })).status).toBe(400);
    const r = await json<{ rotas: { nome: string; clientes: { id: string; nome: string }[] }[]; funcionarios: { nome: string }[] }>(e.get("/api/rotas"));
    expect(r.funcionarios.map((f) => f.nome)).toEqual(["Fábio"]);
    expect(r.rotas[0]!.clientes.map((c) => c.nome)).toEqual(["Ana", "Bruna Ltda", "Carla"]);
    expect(r.rotas[0]!.clientes.map((c) => c.id)).toEqual(cli.map((c) => c.id)); // o editor da rota usa o id
  });
});

describe("funcionário", () => {
  it("só acessa a própria rota e a própria conta", async () => {
    const f = await comoFuncionario();
    expect((await f.get("/api/campo/hoje")).status).toBe(200);
    expect(await json(f.get("/api/auth/me"))).toMatchObject({ usuario: { perfil: "funcionario" }, empresa: "Empresa Teste Ltda" });
    for (const p of ["/api/empresa", "/api/notas", "/api/painel", "/api/clientes", "/api/rotas", "/api/visitas", "/api/usuarios", "/api/receber"])
      expect((await f.get(p)).status, p).toBe(403);
    expect((await f.post("/api/clientes", { nome: "X", doc: "52998224725" })).status).toBe(403);
    expect((await f.post("/api/usuarios", { nome: "X", email: "x@x.com", perfil: "empresa", senha: SENHA })).status).toBe(403);
    expect((await f.post("/api/auth/logout")).status).toBe(200);
  });

  it("recebe as visitas de hoje na ordem da rota; rota de outro dia não aparece", async () => {
    const { e, cli } = await montar();
    await e.post("/api/rotas", { nome: "Outro dia", funcionarioId: func.id, dias: [(dow + 1) % 7], clientes: [cli[0]!.id] });
    const h = await json<{ data: string; visitas: Visita[]; servicos: { nome: string }[] }>((await comoFuncionario()).get("/api/campo/hoje"));
    expect(h.data).toBe(hoje);
    expect(h.visitas.map((v) => [v.ordem, v.clienteNome, v.status])).toEqual([
      [1, "Ana", "pendente"],
      [2, "Bruna Ltda", "pendente"],
      [3, "Carla", "pendente"],
    ]);
    expect(h.servicos.map((s) => s.nome)).toEqual(["Limpeza extra", "Troca de filtro"]);
  });

  it("chega, marca o que fez e conclui; os serviços ficam copiados com o valor do dia", async () => {
    const { e, s1, s2 } = await montar();
    const f = await comoFuncionario();
    const [ana, bruna] = (await json<{ visitas: Visita[] }>(f.get("/api/campo/hoje"))).visitas;
    const gps = { lat: -26.48, lng: -49.07, precisao: 12.4 };

    expect((await f.post(`/api/campo/visitas/${ana!.id}/concluir`, { gps })).status).toBe(409); // sem chegada
    expect((await f.post(`/api/campo/visitas/${ana!.id}/chegada`, { gps })).status).toBe(200);
    expect((await f.post(`/api/campo/visitas/${ana!.id}/chegada`, { gps })).status).toBe(200); // toque repetido
    const outra = await f.post(`/api/campo/visitas/${bruna!.id}/chegada`, { gps });
    expect(outra.status).toBe(409);
    expect((await json<{ erro: string }>(outra)).erro).toMatch(/Ana/);
    expect((await f.post(`/api/campo/visitas/${ana!.id}/concluir`, { gps, servicos: [crypto.randomUUID()] })).status).toBe(400);

    const r = await f.post(`/api/campo/visitas/${ana!.id}/concluir`, { gps, servicos: [s1.id, s2.id, s1.id], obs: "Filtro trocado" });
    expect(r.status).toBe(200);
    expect((await f.post(`/api/campo/visitas/${ana!.id}/concluir`, { gps })).status).toBe(409);

    // mudar o preço depois não muda o que já foi feito
    await e.put(`/api/servicos/${s1.id}`, { nome: "Troca de filtro", valor: 999 });
    const v = (await json<{ visitas: Visita[] }>(f.get("/api/campo/hoje"))).visitas[0]!;
    expect(v).toMatchObject({ status: "concluida", extras: 125.5 });
    expect(v.itens.map((i) => [i.nome, i.valor])).toEqual([
      ["Limpeza extra", 45.5],
      ["Troca de filtro", 80],
    ]);
    const [linha] = await d.select().from(visitas).where(eq(visitas.id, ana!.id));
    expect(linha!.chegadaGps).toEqual({ lat: -26.48, lng: -49.07, precisao: 12 });
    expect(await d.select().from(auditoria).where(eq(auditoria.acao, "concluir_visita"))).toHaveLength(1);
  });

  it("não realizada exige motivo; GPS ausente é aceito; visita de outro funcionário é 404", async () => {
    await montar();
    await criarUsuario(d, { empresaId, nome: "Gil", email: "gil@empresa.com.br", perfil: "funcionario", senha: SENHA });
    const f = await comoFuncionario();
    const [ana] = (await json<{ visitas: Visita[] }>(f.get("/api/campo/hoje"))).visitas;
    expect((await (await cliente().login("gil@empresa.com.br")).post(`/api/campo/visitas/${ana!.id}/chegada`)).status).toBe(404);
    expect((await f.post(`/api/campo/visitas/${ana!.id}/nao-realizada`, { motivo: " " })).status).toBe(400);
    expect((await f.post(`/api/campo/visitas/${ana!.id}/nao-realizada`, { motivo: "Portão fechado" })).status).toBe(200);
    expect((await f.post(`/api/campo/visitas/${ana!.id}/chegada`)).status).toBe(409);
    expect((await f.post(`/api/campo/visitas/${ana!.id}/chegada`, { gps: { lat: 200, lng: 0 } })).status).toBe(400);
  });

  it("visita de outro dia não pode ser registrada", async () => {
    const { rota, cli } = await montar();
    const [v] = await d
      .insert(visitas)
      .values({ empresaId, rotaId: rota.id, clienteId: cli[0]!.id, funcionarioId: func.id, data: addDias(hoje, -1), ordem: 1 })
      .returning();
    expect((await (await comoFuncionario()).post(`/api/campo/visitas/${v!.id}/chegada`)).status).toBe(409);
  });
});

describe("visitas do dia", () => {
  it("acompanham a rota enquanto pendentes; iniciadas e encerradas não mudam", async () => {
    const { e, rota, cli } = await montar();
    const f = await comoFuncionario();
    const [ana] = (await json<{ visitas: Visita[] }>(f.get("/api/campo/hoje"))).visitas;
    await f.post(`/api/campo/visitas/${ana!.id}/chegada`);

    // tira a Ana e a Carla da rota e inverte: só a Bruna continua pendente
    await e.put(`/api/rotas/${rota.id}`, { nome: "Centro", funcionarioId: func.id, dias: [dow], clientes: [cli[1]!.id] });
    await garantirVisitas(d, empresaId, hoje);
    await garantirVisitas(d, empresaId, hoje); // de novo, sem efeito
    const v = (await json<{ visitas: Visita[] }>(e.get("/api/visitas"))).visitas;
    expect(v.map((x) => [x.clienteNome, x.status, x.ordem])).toEqual([
      ["Ana", "em_atendimento", 1],
      ["Bruna Ltda", "pendente", 1],
    ]);

    // cliente removido e rota removida somem das pendentes
    await e.del(`/api/clientes/${cli[1]!.id}`);
    expect((await json<{ visitas: Visita[] }>(e.get("/api/visitas"))).visitas.map((x) => x.clienteNome)).toEqual(["Ana"]);
    await e.del(`/api/rotas/${rota.id}`);
    expect((await json<{ visitas: Visita[] }>(e.get("/api/visitas"))).visitas.map((x) => x.clienteNome)).toEqual(["Ana"]);
  });

  it("funcionário sem acesso não gera visita", async () => {
    const { e } = await montar();
    await e.del(`/api/usuarios/${func.id}`);
    expect((await json<{ visitas: Visita[] }>(e.get("/api/visitas"))).visitas).toHaveLength(0);
  });

  it("empresa reabre a visita de hoje; contador só lê", async () => {
    const { e, s1 } = await montar();
    const f = await comoFuncionario();
    const [ana] = (await json<{ visitas: Visita[] }>(f.get("/api/campo/hoje"))).visitas;
    await f.post(`/api/campo/visitas/${ana!.id}/chegada`);
    await f.post(`/api/campo/visitas/${ana!.id}/concluir`, { servicos: [s1.id] });

    const cont = await comoContador();
    expect((await cont.get(`/api/visitas?data=${hoje}`)).status).toBe(200);
    expect((await cont.post(`/api/visitas/${ana!.id}/reabrir`)).status).toBe(403);
    expect((await e.get("/api/visitas?data=2026-02-30")).status).toBe(400);

    expect((await e.post(`/api/visitas/${ana!.id}/reabrir`)).status).toBe(200);
    const v = (await json<{ visitas: Visita[] }>(e.get("/api/visitas"))).visitas[0]!;
    expect(v).toMatchObject({ status: "pendente", extras: 0 });
    expect(await d.select().from(visitaItens)).toHaveLength(0);
    const [a] = await d.select().from(auditoria).where(eq(auditoria.acao, "reabrir_visita"));
    expect(a!.dados).toMatchObject({ status: "concluida", servicos: ["Troca de filtro"] });
  });
});
