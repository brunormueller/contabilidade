// Ambiente padrão dos testes. Nada aqui é segredo real.
process.env.DATABASE_URL ??= "pglite:memory";
process.env.NFSE_AMBIENTE ??= "producao_restrita";
process.env.CERT_ENC_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.CRON_SECRET ??= "segredo-de-teste";
