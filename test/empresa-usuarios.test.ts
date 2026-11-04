import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../src/db/client.js";
import { auditoria, notas, usuarios } from "../src/db/schema.js";
import { CNPJ_EMPRESA, cenarioBase, SENHA } from "./helpers.js";
import { cliente, comoContador, comoEmpresa } from "./cliente.js";

let d: DB;
let empresaId: string;
beforeEach(async () => {
  ({ d, empresaId } = await cenarioBase());
});

const cfg = {
  razao: "Empresa Teste Ltda",
  cnpj: "11.222.333/0001-81",
  im: "123",
  cServPadrao: "01.07.01",
  cNBSPadrao: "1.1502.10.00",
  aliqIss: 2.5,
  vencDias: 15,
  serie: "900",
  proxDPS: 1,
};

describe("empresa", () => {
  it("contador lê, mas não salva", async () => {
    const c = await comoContador();
    const r = await c.get("/api/empresa");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ cnpj: CNPJ_EMPRESA, ibge: "4208906", proxDPS: 1, cert: null });
    expect((await c.put("/api/empresa", cfg)).status).toBe(403);
  });

  it("empresa salva com as mesmas regras do front e grava auditoria", async () => {
    const c = await comoEmpresa();
    const r = await c.put("/api/empresa", cfg);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ cServPadrao: "010701", cNBSPadrao: "115021000", aliqIss: 2.5, vencDias: 15, serie: "900" });
    const a = await d.select().from(auditoria).where(eq(auditoria.acao, "salvar_empresa"));
    expect(a).toHaveLength(1);
  });

  it("configuração fiscal: pendências somem quando tudo é preenchido, e omitir o campo não apaga", async () => {
    const c = await comoEmpresa();
    const antes = (await (await c.get("/api/empresa")).json()) as { pendencias: string[]; cLocPrestacao: string };
    expect(antes.cLocPrestacao).toBe("4208906");
    expect(antes.pendencias.join(" ")).toMatch(/certificado.*pTotTribSN.*IBS\/CBS/);

    const ibsCbs = { cst: "000", cClassTrib: "000001", indDest: "0" };
    const r = await c.put("/api/empresa", { ...cfg, pTotTribSN: 6, ibsCbs });
    expect(r.status).toBe(200);
    const depois = (await r.json()) as { pendencias: string[]; pTotTribSN: number; ibsCbs: unknown };
    expect(depois).toMatchObject({ pTotTribSN: 6, ibsCbs });
    expect(depois.pendencias).toEqual(["Envie o certificado A1 da empresa."]);

    const sem = (await (await c.put("/api/empresa", cfg)).json()) as { pTotTribSN: number; ibsCbs: unknown };
    expect(sem).toMatchObject({ pTotTribSN: 6, ibsCbs });
    expect((await c.put("/api/empresa", { ...cfg, ibsCbs: { ...ibsCbs, cst: "1" } })).status).toBe(400);
    expect((await c.put("/api/empresa", { ...cfg, cLocPrestacao: "42" })).status).toBe(400);
  });

  it.each([
    [{ cnpj: "11.222.333/0001-00" }, /CNPJ/],
    [{ cServPadrao: "0107" }, /6 dígitos/],
    [{ cNBSPadrao: "1.15" }, /9 dígitos/],
    [{ aliqIss: 6 }, /entre 1,8% e 5%/],
    [{ aliqIss: 1 }, /entre 1,8% e 5%/],
    [{ serie: "95000" }, /Série/],
  ])("recusa %o", async (troca, msg) => {
    const c = await comoEmpresa();
    const r = await c.put("/api/empresa", { ...cfg, ...troca });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { erro: string }).erro).toMatch(msg);
  });

  it("não deixa o nº da DPS voltar para um número já usado", async () => {
    await d.insert(notas).values({
      empresaId, ambiente: "producao_restrita", serie: "900", nDps: 7, idDps: "x", tomadorDoc: "1", tomadorNome: "a",
      descricao: "a", cTribNac: "010701", valor: 100, vLiq: 100, competencia: "2026-11-01", vencimento: "2026-11-10",
    });
    const c = await comoEmpresa();
    const r = await c.put("/api/empresa", { ...cfg, proxDPS: 7 });
    expect(r.status).toBe(400);
    expect((await c.put("/api/empresa", { ...cfg, proxDPS: 8 })).status).toBe(200);
    // e o CNPJ fica travado com nota emitida
    const r2 = await c.put("/api/empresa", { ...cfg, proxDPS: 8, cnpj: "11444777000161" });
    expect(((await r2.json()) as { erro: string }).erro).toMatch(/não pode mudar/);
  });
});

describe("usuários", () => {
  it("contador não vê a lista nem cria", async () => {
    const c = await comoContador();
    expect((await c.get("/api/usuarios")).status).toBe(403);
    expect((await c.post("/api/usuarios", { nome: "X", email: "x@x.com", perfil: "empresa", senha: SENHA })).status).toBe(403);
  });

  it("empresa cria, lista e remove acesso; quem sai perde a sessão", async () => {
    const c = await comoEmpresa();
    const r = await c.post("/api/usuarios", { nome: "Maria", email: "Maria@x.com", perfil: "contador", senha: SENHA });
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    const lista = (await (await c.get("/api/usuarios")).json()) as { email: string }[];
    expect(lista.map((u) => u.email)).toContain("maria@x.com");
    expect(JSON.stringify(lista)).not.toMatch(/argon2|senhaHash/);

    const maria = await cliente().login("maria@x.com");
    expect((await c.del(`/api/usuarios/${id}`)).status).toBe(200);
    expect((await maria.get("/api/auth/me")).status).toBe(401);
    expect((await cliente().req("POST", "/api/auth/login", { email: "maria@x.com", senha: SENHA })).status).toBe(401);

    // e pode ser convidada de novo
    expect((await c.post("/api/usuarios", { nome: "Maria", email: "maria@x.com", perfil: "empresa", senha: SENHA })).status).toBe(201);
    await cliente().login("maria@x.com");
  });

  it("não remove o próprio acesso e recusa e-mail repetido", async () => {
    const c = await comoEmpresa();
    const [me] = await d.select().from(usuarios).where(eq(usuarios.email, "gustavo@empresa.com.br"));
    expect((await c.del(`/api/usuarios/${me!.id}`)).status).toBe(400);
    expect((await c.post("/api/usuarios", { nome: "X", email: "CONTADOR@escritorio.com.br", perfil: "empresa", senha: SENHA })).status).toBe(400);
  });
});

describe("foto do perfil", () => {
  const jpeg = "data:image/jpeg;base64," + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64");

  it("contador pode trocar a própria foto; outros baixam a imagem", async () => {
    const c = await comoContador();
    expect((await c.put("/api/me/foto", { dataUrl: jpeg })).status).toBe(200);
    const me = (await (await c.get("/api/auth/me")).json()) as { usuario: { id: string; temFoto: boolean } };
    expect(me.usuario.temFoto).toBe(true);
    const e = await comoEmpresa();
    const f = await e.get(`/api/usuarios/${me.usuario.id}/foto`);
    expect(f.status).toBe(200);
    expect(f.headers.get("content-type")).toBe("image/jpeg");
    expect((await c.del("/api/me/foto")).status).toBe(200);
  });

  it("recusa o que não é JPEG", async () => {
    const c = await comoEmpresa();
    const png = "data:image/jpeg;base64," + Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    expect((await c.put("/api/me/foto", { dataUrl: png })).status).toBe(400);
    expect((await c.put("/api/me/foto", { dataUrl: "data:text/html;base64,PGI+" })).status).toBe(400);
  });
});
