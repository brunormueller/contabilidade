import { app } from "../src/app.js";
import { SENHA } from "./helpers.js";

/** Navegador de mentira: guarda o cookie de sessão entre requisições. */
export function cliente() {
  let cookie = "";
  async function req(metodo: string, caminho: string, body?: unknown, headers: Record<string, string> = {}) {
    // como um navegador, manda Origin em toda requisição que não é GET/HEAD
    const h: Record<string, string> = { ...headers };
    if (metodo !== "GET" && metodo !== "HEAD") h.origin ??= "http://localhost";
    if (cookie) h.cookie ??= cookie;
    const init: RequestInit = { method: metodo, headers: h };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)["content-type"] = "application/json";
    }
    const r = await app.request(`http://localhost${caminho}`, init);
    const sc = r.headers.get("set-cookie");
    if (sc) {
      const [par] = sc.split(";");
      cookie = /=$/.test(par!) || /Max-Age=0/i.test(sc) ? "" : par!;
    }
    return r;
  }
  return {
    req,
    get: (p: string) => req("GET", p),
    post: (p: string, b?: unknown) => req("POST", p, b ?? {}),
    put: (p: string, b?: unknown) => req("PUT", p, b ?? {}),
    del: (p: string) => req("DELETE", p),
    get cookie() {
      return cookie;
    },
    async login(email: string, senha = SENHA) {
      const r = await req("POST", "/api/auth/login", { email, senha });
      if (r.status !== 200) throw new Error(`login falhou: ${r.status} ${await r.text()}`);
      return this;
    },
  };
}

export const comoEmpresa = () => cliente().login("gustavo@empresa.com.br");
export const comoContador = () => cliente().login("contador@escritorio.com.br");
