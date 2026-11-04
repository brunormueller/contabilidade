import type { Context } from "hono";
import type { DB, Tx } from "../db/client.js";
import { auditoria } from "../db/schema.js";
import type { AppEnv } from "../tipos.js";
import { ipDe } from "./http.js";
import { redigir } from "./log.js";

export async function auditar(
  d: DB | Tx,
  c: Context<AppEnv>,
  acao: string,
  entidade: string,
  entidadeId?: string | null,
  dados?: Record<string, unknown>,
) {
  const u = c.get("user");
  await d.insert(auditoria).values({
    empresaId: u?.empresaId ?? null,
    usuarioId: u?.id ?? null,
    acao,
    entidade,
    entidadeId: entidadeId ?? null,
    dados: dados ? (redigir(dados) as object) : null,
    ip: ipDe(c),
  });
}
