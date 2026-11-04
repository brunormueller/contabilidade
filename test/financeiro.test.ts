import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../src/db/client.js";
import { notas, pagar, receber } from "../src/db/schema.js";
import { csv } from "../src/lib/csv.js";
import { addDias, addMeses, hojeBR } from "../src/lib/datas.js";
import { cenarioBase } from "./helpers.js";
import { comoContador, comoEmpresa } from "./cliente.js";

let d: DB;
let empresaId: string;
beforeEach(async () => {
  ({ d, empresaId } = await cenarioBase());
});

const hoje = hojeBR();

async function notaAutorizada(n: number, valor: number, venc: string, ambiente: "producao_restrita" | "producao" = "producao_restrita") {
  const [nota] = await d
    .insert(notas)
    .values({
      empresaId, ambiente, serie: "900", nDps: n, idDps: `id${n}${ambiente}`, status: "autorizada", nNfse: String(n), chaveAcesso: `chave${n}${ambiente}`,
      tomadorDoc: "11444777000161", tomadorNome: "=HYPERLINK(\"x\")", descricao: "Serviço", cTribNac: "010701",
      valor, vLiq: valor, competencia: hoje, vencimento: venc, dhProc: new Date(),
    })
    .returning();
  await d.insert(receber).values({ empresaId, ambiente, notaId: nota!.id, descricao: `NFS-e nº ${n}`, cliente: "Cliente", valor, venc });
  return nota!;
}

describe("datas", () => {
  it("soma meses respeitando o último dia", () => {
    expect(addMeses("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMeses("2026-12-15", 1)).toBe("2027-01-15");
    expect(addDias("2026-02-28", 1)).toBe("2026-03-01");
  });
});

describe("contas a receber", () => {
  it("lista por filtro, marca e desfaz recebimento; contador só lê", async () => {
    await notaAutorizada(1, 100_00, addDias(hoje, -3));
    await notaAutorizada(2, 200_00, addDias(hoje, 5));
    await notaAutorizada(3, 999_00, hoje, "producao"); // outro ambiente não aparece

    const e = await comoEmpresa();
    const abertos = (await (await e.get("/api/receber")).json()) as { id: string; valor: number }[];
    expect(abertos.map((t) => t.valor)).toEqual([100, 200]);
    const vencidos = (await (await e.get("/api/receber?filtro=vencido")).json()) as unknown[];
    expect(vencidos).toHaveLength(1);

    const cont = await comoContador();
    expect((await cont.get("/api/receber")).status).toBe(200);
    expect((await cont.post(`/api/receber/${abertos[0]!.id}/recebido`)).status).toBe(403);

    const r = await e.post(`/api/receber/${abertos[0]!.id}/recebido`);
    expect(((await r.json()) as { recebidoEm: string }).recebidoEm).toBe(hoje);
    expect((await (await e.get("/api/receber?filtro=recebido")).json()) as unknown[]).toHaveLength(1);
    await e.del(`/api/receber/${abertos[0]!.id}/recebido`);
    expect((await (await e.get("/api/receber?filtro=recebido")).json()) as unknown[]).toHaveLength(0);
  });
});

describe("contas a pagar", () => {
  it("valida a conta nova como o front", async () => {
    const e = await comoEmpresa();
    const base = { descricao: "Aluguel", fornecedor: "Imob", categoria: "Aluguel", valor: 1500, venc: hoje, recorrente: false };
    expect((await e.post("/api/pagar", { ...base, descricao: " " })).status).toBe(400);
    expect((await e.post("/api/pagar", { ...base, valor: 0 })).status).toBe(400);
    expect((await e.post("/api/pagar", { ...base, categoria: "Lazer" })).status).toBe(400);
    expect((await e.post("/api/pagar", { ...base, venc: "2026-02-30" })).status).toBe(400);
    expect((await e.post("/api/pagar", base)).status).toBe(201);
  });

  it("recorrente gera a próxima uma vez só, mesmo pagando, desfazendo e pagando de novo", async () => {
    const e = await comoEmpresa();
    const r = await e.post("/api/pagar", { descricao: "Contador", categoria: "Serviços e assinaturas", valor: 300.5, venc: "2026-01-31", recorrente: true });
    const { id } = (await r.json()) as { id: string };
    const p1 = (await (await e.post(`/api/pagar/${id}/pago`)).json()) as { proxima: string };
    expect(p1.proxima).toBe("2026-02-28");
    await e.del(`/api/pagar/${id}/pago`);
    const p2 = (await (await e.post(`/api/pagar/${id}/pago`)).json()) as { proxima: string | null };
    expect(p2.proxima).toBeNull();
    const todas = await d.select().from(pagar);
    expect(todas).toHaveLength(2);
    expect(todas.map((t) => t.valor).sort()).toEqual([300_50, 300_50]);
  });

  it("exclui conta", async () => {
    const e = await comoEmpresa();
    const { id } = (await (await e.post("/api/pagar", { descricao: "X", categoria: "Outros", valor: 1, venc: hoje })).json()) as { id: string };
    expect((await e.del(`/api/pagar/${id}`)).status).toBe(200);
    expect(await d.select().from(pagar)).toHaveLength(0);
  });
});

describe("painel e arquivos do mês", () => {
  it("painel soma o mês, os abertos e o que vence em 7 dias", async () => {
    await notaAutorizada(1, 850_00, addDias(hoje, -1));
    await notaAutorizada(2, 1025_00, addDias(hoje, 10));
    await d.insert(pagar).values({ empresaId, descricao: "Luz", categoria: "Outros", valor: 120_00, venc: addDias(hoje, 3) });
    await d.insert(pagar).values({ empresaId, descricao: "Longe", categoria: "Outros", valor: 1_00, venc: addDias(hoje, 30) });
    const r = (await (await (await comoContador()).get("/api/painel")).json()) as Record<string, unknown>;
    expect(r).toMatchObject({ faturado: 1875, notasMes: 2, aReceberAberto: 1875, vencidosQtd: 1, pagarSemanaTotal: 120, temNotas: true });
  });

  it("CSV de notas sai com BOM, ';' e sem fórmula executável", async () => {
    await notaAutorizada(7, 1200_50, hoje);
    const r = await (await comoContador()).get(`/api/exportar/${hoje.slice(0, 7)}/notas.csv`);
    expect(r.headers.get("content-type")).toMatch(/text\/csv/);
    const bytes = new Uint8Array(await r.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM (Response.text() o esconderia)
    const t = new TextDecoder().decode(bytes);
    expect(t).toContain("1200,50");
    expect(t).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it("csv() não estraga número negativo", () => {
    expect(csv([["-170,50", "-texto", "@x"]])).toBe("﻿-170,50;'-texto;'@x");
  });
});
