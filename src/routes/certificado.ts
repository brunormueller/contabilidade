import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { guardarCertificado } from "../cert/certificado.js";
import { db } from "../db/client.js";
import { carregarEmpresa, resumoCertificado } from "../domain/empresa.js";
import { auditar } from "../lib/auditoria.js";
import { HttpError, invalido } from "../lib/erros.js";
import type { AppEnv } from "../tipos.js";

// Um A1 tem poucos KB; o limite barra upload grande antes de ler o corpo.
const PFX_MAX = 64 * 1024;

export const rotaCertificado = new Hono<AppEnv>();

rotaCertificado.get("/", async (c) => {
  return c.json(await resumoCertificado(await db(), c.get("user").empresaId));
});

rotaCertificado.post(
  "/",
  bodyLimit({ maxSize: PFX_MAX + 8 * 1024, onError: () => { throw new HttpError(413, "Arquivo grande demais para um certificado A1."); } }),
  async (c) => {
    const form = await c.req.parseBody().catch(() => null);
    const arquivo = form?.arquivo;
    const senha = form?.senha;
    if (!(arquivo instanceof File)) throw invalido("Escolha o arquivo .pfx ou .p12 do certificado.");
    if (typeof senha !== "string" || !senha) throw invalido("Informe a senha do certificado.");
    if (arquivo.size > PFX_MAX) throw new HttpError(413, "Arquivo grande demais para um certificado A1.");

    const u = c.get("user");
    const d = await db();
    const bytes = new Uint8Array(await arquivo.arrayBuffer());
    const resumo = await d.transaction(async (tx) => {
      const e = await carregarEmpresa(tx, u.empresaId);
      const r = await guardarCertificado(tx, { empresaId: u.empresaId, cnpjEmpresa: e.cnpj, pfx: bytes, senha, usuarioId: u.id });
      await auditar(tx, c, "enviar_certificado", "certificado", r.id, { titular: r.titular, cnpj: r.cnpj, serial: r.serial, validoAte: r.validoAte });
      return r;
    });
    return c.json(resumo, 201);
  },
);
