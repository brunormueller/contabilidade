import type { Context } from "hono";
import type { z } from "zod";
import { invalido } from "./erros.js";

/** Lê o corpo JSON e valida com zod; erro vira 400 com a primeira mensagem legível. */
export async function corpo<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let bruto: unknown;
  try {
    bruto = await c.req.json();
  } catch {
    throw invalido("Corpo da requisição precisa ser JSON.");
  }
  const r = schema.safeParse(bruto);
  if (!r.success) {
    const i = r.error.issues[0]!;
    throw invalido(i.message, r.error.issues.map((x) => ({ campo: x.path.join("."), msg: x.message })));
  }
  return r.data;
}

export function ipDe(c: Context): string | null {
  const real = c.req.header("x-real-ip");
  if (real) return real;
  const fwd = c.req.header("x-forwarded-for");
  return fwd ? fwd.split(",")[0]!.trim() : null;
}
