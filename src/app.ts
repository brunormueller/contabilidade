import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { exigirSessao } from "./auth/guard.js";
import { env } from "./env.js";
import { HttpError } from "./lib/erros.js";
import { log } from "./lib/log.js";
import { auth } from "./routes/auth.js";
import { rotaCertificado } from "./routes/certificado.js";
import { rotaEmpresa } from "./routes/empresa.js";
import { rotaExportar } from "./routes/exportar.js";
import { rotaLotes } from "./routes/lotes.js";
import { rotaMe } from "./routes/me.js";
import { rotaPagar } from "./routes/pagar.js";
import { rotaPainel } from "./routes/painel.js";
import { rotaReceber } from "./routes/receber.js";
import { rotaUsuarios } from "./routes/usuarios.js";
import type { AppEnv } from "./tipos.js";

export const app = new Hono<AppEnv>().basePath("/api");

app.use(secureHeaders());
// Requisições de formulário (inclusive o upload multipart do certificado) só da própria origem.
// JSON de outra origem já esbarra no preflight de CORS, que não liberamos.
app.use(csrf());
app.use(async (c, next) => {
  await next();
  if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
});
app.use(exigirSessao);

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ erro: err.message, detalhes: err.detalhes }, err.status);
  if (err instanceof HTTPException) return c.json({ erro: err.message || "Requisição recusada." }, err.status);
  log.error("erro não tratado", { rota: c.req.path, metodo: c.req.method, erro: err });
  return c.json({ erro: "Erro interno. Tente de novo em instantes." }, 500);
});

app.notFound((c) => c.json({ erro: "Rota não encontrada." }, 404));

app.get("/health", (c) => c.json({ ok: true, ambiente: env().NFSE_AMBIENTE }));
app.route("/auth", auth);
app.route("/me", rotaMe);
app.route("/empresa", rotaEmpresa);
app.route("/usuarios", rotaUsuarios);
app.route("/certificado", rotaCertificado);
app.route("/lotes", rotaLotes);
app.route("/receber", rotaReceber);
app.route("/pagar", rotaPagar);
app.route("/painel", rotaPainel);
app.route("/exportar", rotaExportar);
