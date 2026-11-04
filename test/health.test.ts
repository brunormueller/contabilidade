import { describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { redigir } from "../src/lib/log.js";

describe("esqueleto", () => {
  it("GET /api/health responde com o ambiente", async () => {
    const r = await app.request("/api/health");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, ambiente: "producao_restrita" });
  });

  it("rota desconhecida sem sessão devolve 401 em JSON (não revela o que existe)", async () => {
    const r = await app.request("/api/nao-existe");
    expect(r.status).toBe(401);
    expect(await r.json()).toHaveProperty("erro");
  });

  it("POST de formulário vindo de outra origem é barrado (CSRF)", async () => {
    const r = await app.request("http://localhost/api/health", {
      method: "POST",
      headers: { origin: "https://site-malicioso.example", "content-type": "application/x-www-form-urlencoded" },
      body: "a=1",
    });
    expect(r.status).toBe(403);
  });

  it("log redige segredos", () => {
    const out = redigir({ email: "a@b.c", senha: "x", nested: { pfx: new Uint8Array(3), CERT_ENC_KEY: "k" }, token_hash: "t" });
    expect(out).toEqual({ email: "a@b.c", senha: "[redigido]", nested: { pfx: "[redigido]", CERT_ENC_KEY: "[redigido]" }, token_hash: "[redigido]" });
  });
});
