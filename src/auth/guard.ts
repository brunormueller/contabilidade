import { createMiddleware } from "hono/factory";
import { db } from "../db/client.js";
import { naoAutenticado, proibido } from "../lib/erros.js";
import type { AppEnv } from "../tipos.js";
import { lerSessao } from "./sessao.js";

// Rotas abertas, sem sessão.
const PUBLICAS = new Set(["/api/health", "/api/auth/login", "/api/cron/processar"]);
// Escritas que o contador pode fazer: são sobre a própria conta.
const ESCRITA_LIVRE = new Set(["/api/auth/logout", "/api/auth/senha", "/api/me/foto"]);
const LEITURA = new Set(["GET", "HEAD"]);
// Funcionário é o contrário do contador: só enxerga a própria rota e a própria conta.
const FUNCIONARIO_LEITURA = [/^\/api\/auth\/me$/, /^\/api\/usuarios\/[^/]+\/foto$/];
const CAMPO = /^\/api\/campo(\/|$)/;

function funcionarioPode(metodo: string, caminho: string) {
  if (CAMPO.test(caminho) || ESCRITA_LIVRE.has(caminho)) return true;
  return LEITURA.has(metodo) && FUNCIONARIO_LEITURA.some((r) => r.test(caminho));
}

export const exigirSessao = createMiddleware<AppEnv>(async (c, next) => {
  if (PUBLICAS.has(c.req.path)) return next();
  const u = await lerSessao(await db(), c);
  if (!u) throw naoAutenticado();
  c.set("user", u);
  if (u.perfil === "funcionario") {
    if (!funcionarioPode(c.req.method, c.req.path)) throw proibido();
    return next();
  }
  // Contador é somente leitura em tudo. A regra é por padrão: rota nova já nasce protegida.
  if (u.perfil !== "empresa" && !LEITURA.has(c.req.method) && !ESCRITA_LIVRE.has(c.req.path)) throw proibido();
  return next();
});

/** Para leituras que o contador também não pode ver (ex.: lista de usuários). */
export const soEmpresa = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("user").perfil !== "empresa") throw proibido();
  return next();
});
