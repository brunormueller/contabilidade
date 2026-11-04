import { sql } from "drizzle-orm";
import { conectar, migrar, usarDb, type DB } from "../src/db/client.js";
import { criarEmpresaEAdmin } from "../src/domain/setup.js";
import { criarUsuario } from "../src/domain/usuarios.js";

export const CNPJ_EMPRESA = "11222333000181";
export const SENHA = "senha-de-teste-123";

let base: Promise<DB> | null = null;

/** PGlite migrado uma vez por arquivo de teste; cada chamada devolve as tabelas vazias. */
export async function bancoNovo(): Promise<DB> {
  base ??= (async () => {
    const d = await conectar("pglite:memory");
    await migrar(d);
    return d;
  })();
  const d = await base;
  const r = await d.execute(sql`select string_agg(format('%I', tablename), ', ') as t from pg_tables where schemaname = 'public'`);
  const tabelas = (r.rows as { t: string }[])[0]!.t;
  await d.execute(sql.raw(`truncate ${tabelas} restart identity cascade`));
  usarDb(d);
  return d;
}

/** Banco com empresa, um usuário "empresa" e um "contador". */
export async function cenarioBase() {
  const d = await bancoNovo();
  const adm = await criarEmpresaEAdmin(d, { cnpj: CNPJ_EMPRESA, razao: "Empresa Teste Ltda", nome: "Gustavo", email: "gustavo@empresa.com.br", senha: SENHA });
  const cont = await criarUsuario(d, { empresaId: adm.empresaId, nome: "Contador", email: "contador@escritorio.com.br", perfil: "contador", senha: SENHA });
  return { d, empresaId: adm.empresaId, adm, cont };
}
