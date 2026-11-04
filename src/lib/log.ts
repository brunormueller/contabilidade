// Logger mínimo em JSON. Toda chave com cara de segredo é trocada por "[redigido]"
// antes de sair, para que senha, certificado, token ou cookie nunca parem no log da Vercel.

const SEGREDO = /senha|password|passphrase|pfx|p12|private|chave_?privada|token|cookie|authorization|secret|_key$|^key$/i;

export function redigir(v: unknown, prof = 0): unknown {
  if (prof > 6) return "[profundo]";
  if (v == null || typeof v !== "object") return v;
  if (v instanceof Uint8Array) return `[${v.byteLength} bytes]`;
  if (v instanceof Error) return { nome: v.name, mensagem: v.message };
  if (Array.isArray(v)) return v.map((x) => redigir(x, prof + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = SEGREDO.test(k) ? "[redigido]" : redigir(x, prof + 1);
  return out;
}

type Nivel = "info" | "warn" | "error";

function escrever(nivel: Nivel, msg: string, dados?: Record<string, unknown>) {
  const linha = JSON.stringify({ nivel, msg, ...(dados ? (redigir(dados) as object) : {}), em: new Date().toISOString() });
  if (nivel === "error") console.error(linha);
  else if (nivel === "warn") console.warn(linha);
  else console.log(linha);
}

export const log = {
  info: (msg: string, dados?: Record<string, unknown>) => escrever("info", msg, dados),
  warn: (msg: string, dados?: Record<string, unknown>) => escrever("warn", msg, dados),
  error: (msg: string, dados?: Record<string, unknown>) => escrever("error", msg, dados),
};
