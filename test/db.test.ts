import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { conferirSenha } from "../src/auth/senha.js";
import { usuarios } from "../src/db/schema.js";
import { criarEmpresaEAdmin } from "../src/domain/setup.js";
import { bancoNovo, CNPJ_EMPRESA, SENHA } from "./helpers.js";

describe("banco", () => {
  it("migration cria todas as tabelas", async () => {
    const d = await bancoNovo();
    const r = await d.execute(sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`);
    const nomes = (r.rows as { table_name: string }[]).map((x) => x.table_name);
    expect(nomes).toEqual(
      expect.arrayContaining(["empresa", "usuarios", "sessoes", "certificados", "lotes", "notas", "nota_documentos", "receber", "pagar", "auditoria", "dps_sequencia"]),
    );
  });

  it("criar-admin cria empresa e usuário com senha em argon2id", async () => {
    const d = await bancoNovo();
    const r = await criarEmpresaEAdmin(d, { cnpj: "11.222.333/0001-81", razao: "X", nome: "Ana", email: "Ana@X.com", senha: SENHA });
    expect(r.email).toBe("ana@x.com");
    const [u] = await d.select().from(usuarios);
    expect(u!.senhaHash.startsWith("$argon2id$")).toBe(true);
    expect(await conferirSenha(SENHA, u!.senhaHash)).toBe(true);
    expect(await conferirSenha("errada", u!.senhaHash)).toBe(false);
  });

  it("criar-admin recusa CNPJ inválido, e-mail repetido e CNPJ de outra empresa", async () => {
    const d = await bancoNovo();
    await expect(criarEmpresaEAdmin(d, { cnpj: "11222333000100", nome: "A", email: "a@x.com", senha: SENHA })).rejects.toThrow(/CNPJ/);
    await criarEmpresaEAdmin(d, { cnpj: CNPJ_EMPRESA, nome: "A", email: "a@x.com", senha: SENHA });
    await expect(criarEmpresaEAdmin(d, { nome: "B", email: "A@X.COM", senha: SENHA })).rejects.toThrow(/e-mail/);
    await expect(criarEmpresaEAdmin(d, { cnpj: "11444777000161", nome: "C", email: "c@x.com", senha: SENHA })).rejects.toThrow(/outro CNPJ/);
  });

  it("senha curta é recusada", async () => {
    const d = await bancoNovo();
    await expect(criarEmpresaEAdmin(d, { cnpj: CNPJ_EMPRESA, nome: "A", email: "a@x.com", senha: "1234567" })).rejects.toThrow(/8 caracteres/);
  });
});
