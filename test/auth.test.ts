import { beforeEach, describe, expect, it } from "vitest";
import { sessoes } from "../src/db/schema.js";
import type { DB } from "../src/db/client.js";
import { cenarioBase, SENHA } from "./helpers.js";
import { cliente, comoContador, comoEmpresa } from "./cliente.js";

let d: DB;
beforeEach(async () => {
  ({ d } = await cenarioBase());
});

describe("login", () => {
  it("abre sessão em cookie __Host- HttpOnly, Secure e SameSite=Lax", async () => {
    const r = await cliente().req("POST", "/api/auth/login", { email: "GUSTAVO@empresa.com.br", senha: SENHA });
    expect(r.status).toBe(200);
    const sc = r.headers.get("set-cookie")!;
    expect(sc).toMatch(/^__Host-sid=/);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/Secure/i);
    expect(sc).toMatch(/SameSite=Lax/i);
    expect(sc).toMatch(/Path=\//);
    expect(sc).not.toMatch(/Domain=/i);
    const body = (await r.json()) as { usuario: unknown };
    expect(body.usuario).toMatchObject({ email: "gustavo@empresa.com.br", perfil: "empresa" });
    expect(JSON.stringify(body)).not.toMatch(/argon2|senha/i);
  });

  it("senha errada e e-mail inexistente dão a mesma resposta", async () => {
    const a = await cliente().req("POST", "/api/auth/login", { email: "gustavo@empresa.com.br", senha: "errada123" });
    const b = await cliente().req("POST", "/api/auth/login", { email: "ninguem@x.com", senha: "errada123" });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(await a.json()).toEqual(await b.json());
  });

  it("bloqueia após 5 falhas no mesmo e-mail, mesmo com a senha certa", async () => {
    for (let i = 0; i < 5; i++) await cliente().req("POST", "/api/auth/login", { email: "gustavo@empresa.com.br", senha: "errada123" });
    const r = await cliente().req("POST", "/api/auth/login", { email: "gustavo@empresa.com.br", senha: SENHA });
    expect(r.status).toBe(429);
  });
});

describe("sessão", () => {
  it("sem cookie, rotas protegidas respondem 401", async () => {
    expect((await cliente().get("/api/auth/me")).status).toBe(401);
    expect((await cliente().get("/api/nao-existe")).status).toBe(401);
  });

  it("com sessão, /me devolve o usuário e o ambiente", async () => {
    const c = await comoEmpresa();
    const r = await c.get("/api/auth/me");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ usuario: { nome: "Gustavo", perfil: "empresa" }, ambiente: "producao_restrita" });
    expect((await c.get("/api/nao-existe")).status).toBe(404);
  });

  it("logout invalida a sessão no servidor", async () => {
    const c = await comoEmpresa();
    const cookieAntigo = c.cookie;
    await c.post("/api/auth/logout");
    const r = await cliente().req("GET", "/api/auth/me", undefined, { cookie: cookieAntigo });
    expect(r.status).toBe(401);
  });

  it("sessão vencida não vale", async () => {
    const c = await comoEmpresa();
    await d.update(sessoes).set({ expiraEm: new Date(Date.now() - 1000) });
    expect((await c.get("/api/auth/me")).status).toBe(401);
  });

  it("o banco guarda só o hash do token", async () => {
    const c = await comoEmpresa();
    const token = c.cookie.split("=")[1]!;
    const [s] = await d.select().from(sessoes);
    expect(Buffer.from(s!.tokenHash).toString("base64url")).not.toBe(token);
    expect(s!.tokenHash.byteLength).toBe(32);
  });
});

describe("perfis", () => {
  it("contador não faz escrita nenhuma, nem em rota que nem existe", async () => {
    const c = await comoContador();
    expect((await c.post("/api/lotes", {})).status).toBe(403);
    expect((await c.put("/api/empresa", {})).status).toBe(403);
    expect((await c.del("/api/pagar/x")).status).toBe(403);
  });

  it("contador pode trocar a própria senha e sair", async () => {
    const c = await comoContador();
    expect((await c.put("/api/auth/senha", { atual: SENHA, nova: "nova-senha-456" })).status).toBe(200);
    expect((await c.post("/api/auth/logout")).status).toBe(200);
    await cliente().login("contador@escritorio.com.br", "nova-senha-456");
  });

  it("trocar a senha derruba as outras sessões", async () => {
    const a = await comoEmpresa();
    const b = await comoEmpresa();
    expect((await a.put("/api/auth/senha", { atual: SENHA, nova: "outra-senha-789" })).status).toBe(200);
    expect((await a.get("/api/auth/me")).status).toBe(200);
    expect((await b.get("/api/auth/me")).status).toBe(401);
    expect(await d.select().from(sessoes)).toHaveLength(1);
  });

  it("senha atual errada não troca", async () => {
    const a = await comoEmpresa();
    const r = await a.put("/api/auth/senha", { atual: "errada123", nova: "outra-senha-789" });
    expect(r.status).toBe(400);
  });
});
