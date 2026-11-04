import { z } from "zod";

export const AMBIENTES = ["producao_restrita", "producao"] as const;
export type Ambiente = (typeof AMBIENTES)[number];

const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL não definida"),
  DATABASE_URL_UNPOOLED: z.string().optional(),
  // validada no uso (cert/cripto.ts), para o app subir mesmo sem certificado configurado
  CERT_ENC_KEY: z.string().optional(),
  CERT_ENC_KEY_VERSION: z.coerce.number().int().positive().default(1),
  NFSE_AMBIENTE: z.enum(AMBIENTES).default("producao_restrita"),
  CRON_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cache: Env | null = null;

export function env(): Env {
  if (!cache) {
    const r = schema.safeParse(process.env);
    if (!r.success) {
      const campos = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      throw new Error(`Variáveis de ambiente inválidas: ${campos.join("; ")}`);
    }
    cache = r.data;
  }
  return cache;
}

/** Só para testes: força reler process.env. */
export function resetEnv() {
  cache = null;
}
