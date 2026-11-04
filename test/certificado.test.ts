import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { abrirCertificado } from "../src/cert/certificado.js";
import { cifrar, decifrar } from "../src/cert/cripto.js";
import { lerPfx } from "../src/cert/pfx.js";
import type { DB } from "../src/db/client.js";
import { certificados } from "../src/db/schema.js";
import { gerarPfx } from "./certTeste.js";
import { cenarioBase, CNPJ_EMPRESA } from "./helpers.js";
import { comoContador, comoEmpresa } from "./cliente.js";

let d: DB;
let empresaId: string;
beforeEach(async () => {
  ({ d, empresaId } = await cenarioBase());
});
afterEach(() => vi.restoreAllMocks());

function form(pfx: Buffer, senha: string, nome = "empresa.pfx") {
  const f = new FormData();
  f.append("arquivo", new File([new Uint8Array(pfx)], nome, { type: "application/x-pkcs12" }));
  f.append("senha", senha);
  return f;
}

describe("AES-256-GCM", () => {
  it("cifra e decifra; adulterar o dado ou trocar o AAD falha", () => {
    const x = cifrar(Buffer.from("segredo"), "cert:1:pfx");
    expect(x.cifrado.toString()).not.toContain("segredo");
    expect(decifrar(x, "cert:1:pfx").toString()).toBe("segredo");
    expect(() => decifrar(x, "cert:2:pfx")).toThrow();
    const ruim = { ...x, cifrado: Buffer.from(x.cifrado) };
    ruim.cifrado[0]! ^= 1;
    expect(() => decifrar(ruim, "cert:1:pfx")).toThrow();
    // IV novo a cada vez
    expect(cifrar(Buffer.from("a"), "x").iv.equals(cifrar(Buffer.from("a"), "x").iv)).toBe(false);
  });
});

describe("leitura do PFX", () => {
  it("extrai titular, CNPJ e validade do certificado que casa com a chave", () => {
    const c = gerarPfx();
    const p = lerPfx(c.pfx, c.senha);
    expect(p).toMatchObject({ titular: "EMPRESA TESTE LTDA", cnpj: CNPJ_EMPRESA, emissor: "AC TESTE NAO ICP" });
    expect(p.chavePem).toMatch(/BEGIN RSA PRIVATE KEY/);
    expect(p.cadeiaPem).toHaveLength(1);
    expect(p.validoAte.getTime()).toBeGreaterThan(Date.now());
  });

  it("senha errada tem mensagem própria", () => {
    const c = gerarPfx();
    expect(() => lerPfx(c.pfx, "errada")).toThrow(/Senha incorreta/);
    expect(() => lerPfx(Buffer.from("não é pfx"), "x")).toThrow(/Não consegui ler/);
  });
});

describe("POST /api/certificado", () => {
  it("guarda cifrado e devolve só metadados, sem vazar nada no log", async () => {
    const c = gerarPfx();
    const logs: string[] = [];
    for (const k of ["log", "warn", "error"] as const) vi.spyOn(console, k).mockImplementation((...a) => void logs.push(a.join(" ")));

    const e = await comoEmpresa();
    const r = await e.req("POST", "/api/certificado", form(c.pfx, c.senha));
    expect(r.status).toBe(201);
    const txt = await r.text();
    expect(JSON.parse(txt)).toMatchObject({ titular: "EMPRESA TESTE LTDA", cnpj: CNPJ_EMPRESA });
    expect(txt).not.toMatch(/PRIVATE|BEGIN|pfx|senha/i);
    expect(txt).not.toContain(c.pfx.toString("base64").slice(0, 40));

    const [row] = await d.select().from(certificados);
    expect(Buffer.from(row!.pfxCifrado).equals(c.pfx)).toBe(false);
    expect(Buffer.from(row!.senhaCifrada).toString()).not.toContain(c.senha);

    const aberto = await abrirCertificado(d, empresaId);
    expect(aberto.chavePem.replace(/\s/g, "")).toBe(lerPfx(c.pfx, c.senha).chavePem.replace(/\s/g, ""));

    const emp = (await (await e.get("/api/empresa")).json()) as { cert: { titular: string } };
    expect(emp.cert.titular).toBe("EMPRESA TESTE LTDA");
    expect(logs.join("\n")).not.toContain(c.senha);
  });

  it("substituir deixa um só ativo", async () => {
    const e = await comoEmpresa();
    await e.req("POST", "/api/certificado", form(gerarPfx().pfx, "senha-do-pfx"));
    await e.req("POST", "/api/certificado", form(gerarPfx().pfx, "senha-do-pfx"));
    const todos = await d.select({ ativo: certificados.ativo }).from(certificados);
    expect(todos.map((x) => x.ativo).sort()).toEqual([false, true]);
  });

  it.each([
    ["CNPJ diferente", { cnpj: "11444777000161" }, /diferente do cadastrado/],
    ["vencido", { desdeDias: -400, ateDias: -1 }, /vencido/],
    ["ainda não vale", { desdeDias: 2, ateDias: 300 }, /ainda não começou/],
  ])("recusa certificado %s", async (_n, o, msg) => {
    const c = gerarPfx(o);
    const r = await (await comoEmpresa()).req("POST", "/api/certificado", form(c.pfx, c.senha));
    expect(r.status).toBe(400);
    expect(((await r.json()) as { erro: string }).erro).toMatch(msg);
  });

  it("recusa sem arquivo, sem senha, grande demais e para o contador", async () => {
    const e = await comoEmpresa();
    const sem = new FormData();
    sem.append("senha", "x");
    expect((await e.req("POST", "/api/certificado", sem)).status).toBe(400);
    expect((await e.req("POST", "/api/certificado", form(gerarPfx().pfx, ""))).status).toBe(400);
    expect((await e.req("POST", "/api/certificado", form(Buffer.alloc(200 * 1024), "x"))).status).toBe(413);
    expect((await (await comoContador()).req("POST", "/api/certificado", form(gerarPfx().pfx, "senha-do-pfx"))).status).toBe(403);
  });
});
