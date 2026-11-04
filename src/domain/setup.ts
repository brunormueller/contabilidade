import type { DB } from "../db/client.js";
import { empresa } from "../db/schema.js";
import { invalido } from "../lib/erros.js";
import { normDoc, validCNPJ } from "./documentos.js";
import { criarUsuario } from "./usuarios.js";

/** O sistema atende uma empresa só. Devolve a empresa cadastrada, se houver. */
export async function empresaAtual(d: DB) {
  const [e] = await d.select().from(empresa).limit(1);
  return e ?? null;
}

export async function criarEmpresaEAdmin(
  d: DB,
  a: { cnpj?: string; razao?: string; nome: string; email: string; senha: string },
) {
  return d.transaction(async (tx) => {
    let [e] = await tx.select().from(empresa).limit(1);
    if (!e) {
      const cnpj = normDoc(a.cnpj);
      if (!validCNPJ(cnpj)) throw invalido("Informe o CNPJ válido da empresa (--cnpj).");
      [e] = await tx
        .insert(empresa)
        .values({ cnpj, razao: (a.razao ?? "").trim() })
        .returning();
    } else if (a.cnpj && normDoc(a.cnpj) !== e.cnpj) {
      throw invalido(`Já existe uma empresa cadastrada com outro CNPJ (${e.cnpj}).`);
    }
    const u = await criarUsuario(tx, { empresaId: e!.id, nome: a.nome, email: a.email, perfil: "empresa", senha: a.senha });
    return { empresaId: e!.id, ...u };
  });
}
