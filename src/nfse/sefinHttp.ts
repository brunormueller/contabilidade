// Cliente da API da Sefin Nacional (Swagger "API NFS-e - Sefin Nacional" v1): JSON sobre HTTPS
// com autenticação mútua pelo certificado A1; cada XML vai e volta em GZip + base64.
//
// Regra que guia as respostas: só é "rejeitada"/"nao_existe" quando a Sefin disse isso com
// clareza. Timeout, queda, 5xx ou resposta que não dá para ler é "incerto", e a fila consulta
// antes de reenviar.
import { request } from "node:https";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Pfx } from "../cert/pfx.js";
import type { Ambiente } from "../env.js";
import { log } from "../lib/log.js";
import type { Bruto, ErroSefin, NfseGerada, Sefin } from "./sefin.js";

export const URLS: Record<Ambiente, string> = {
  producao: "https://sefin.nfse.gov.br/SefinNacional",
  producao_restrita: "https://sefin.producaorestrita.nfse.gov.br/SefinNacional",
};

// duas chamadas cabem no tempo da função (ver ORCAMENTO_MS na fila)
const TIMEOUT_MS = 15_000;
const LIMITE_BYTES = 5 * 1024 * 1024;

export type OpcoesSefin = { url?: string; ca?: string; timeoutMs?: number };

type Resposta = { http: number; corpo: string; json: Record<string, unknown> | null };

export const compactar = (xml: string) => {
  const completo = xml.startsWith("<?xml") ? xml : `<?xml version="1.0" encoding="UTF-8"?>${xml}`;
  return gzipSync(Buffer.from(completo, "utf8")).toString("base64");
};

export const descompactar = (b64: string) => gunzipSync(Buffer.from(b64, "base64"), { maxOutputLength: LIMITE_BYTES }).toString("utf8");

/** Lê o campo sem depender de maiúsculas/minúsculas no nome. */
function campo(o: unknown, nome: string): unknown {
  if (!o || typeof o !== "object") return undefined;
  const k = Object.keys(o).find((x) => x.toLowerCase() === nome.toLowerCase());
  return k ? (o as Record<string, unknown>)[k] : undefined;
}
const texto = (o: unknown, nome: string) => {
  const v = campo(o, nome);
  return typeof v === "string" ? v : "";
};

/** Erros vêm em "erros" (lista) na emissão e em "erro" nas consultas e eventos. */
function errosDe(json: Record<string, unknown> | null): ErroSefin[] {
  const v = campo(json, "erros") ?? campo(json, "erro");
  const lista = Array.isArray(v) ? v : v ? [v] : [];
  return lista
    .map((e) => ({ codigo: texto(e, "codigo"), mensagem: [texto(e, "descricao"), texto(e, "complemento")].filter(Boolean).join(" ") }))
    .filter((e) => e.codigo || e.mensagem);
}

function xmlDe(json: Record<string, unknown> | null, nome: string): string | null {
  const b64 = texto(json, nome);
  if (!b64) return null;
  try {
    const xml = descompactar(b64);
    return xml.includes("<") ? xml : null;
  } catch {
    return null;
  }
}

const tag = (xml: string, nome: string) => new RegExp(`<(?:\\w+:)?${nome}>([^<]+)</`).exec(xml)?.[1] ?? "";

function nfseDe(json: Record<string, unknown> | null, chavePedida = ""): NfseGerada | null {
  const xml = xmlDe(json, "nfseXmlGZipB64");
  if (!xml) return null;
  const chaveAcesso = texto(json, "chaveAcesso") || chavePedida;
  const nNfse = tag(xml, "nNFSe");
  if (!chaveAcesso || !nNfse) return null;
  const dh = new Date(tag(xml, "dhProc"));
  return { chaveAcesso, nNfse, dhProc: Number.isNaN(dh.getTime()) ? new Date() : dh, xml };
}

export function clienteSefin(cert: Pick<Pfx, "chavePem" | "certPem" | "cadeiaPem">, ambiente: Ambiente, o: OpcoesSefin = {}): Sefin {
  const base = o.url ?? process.env.SEFIN_URL ?? URLS[ambiente];
  const certificado = [cert.certPem, ...cert.cadeiaPem].join("\n");

  function chamar(metodo: "GET" | "POST", caminho: string, corpo?: object): Promise<Resposta> {
    const dados = corpo ? JSON.stringify(corpo) : undefined;
    const limite = o.timeoutMs ?? TIMEOUT_MS;
    return new Promise((ok, falhou) => {
      const req = request(
        new URL(base + caminho),
        {
          method: metodo,
          key: cert.chavePem,
          cert: certificado,
          ...(o.ca && { ca: o.ca }),
          // o Swagger informa até TLS 1.2; o pedido do certificado por renegociação não existe no 1.3
          maxVersion: "TLSv1.2",
          agent: false,
          headers: { accept: "application/json", ...(dados && { "content-type": "application/json", "content-length": Buffer.byteLength(dados) }) },
          signal: AbortSignal.timeout(limite),
        },
        (res) => {
          const partes: Buffer[] = [];
          let n = 0;
          res.on("data", (p: Buffer) => {
            n += p.length;
            if (n > LIMITE_BYTES) req.destroy(new Error("Resposta grande demais."));
            else partes.push(p);
          });
          res.on("error", falhou);
          res.on("end", () => {
            const t = Buffer.concat(partes).toString("utf8");
            let json: Record<string, unknown> | null = null;
            try {
              const j: unknown = JSON.parse(t);
              if (j && typeof j === "object" && !Array.isArray(j)) json = j as Record<string, unknown>;
            } catch {
              // página de erro em HTML ou corpo vazio: fica só o texto
            }
            ok({ http: res.statusCode ?? 0, corpo: t, json });
          });
        },
      );
      req.on("error", falhou);
      req.end(dados);
    });
  }

  /** Chamada que nunca estoura: sem resposta vira o motivo do "incerto". */
  async function tentar(metodo: "GET" | "POST", caminho: string, corpo?: object): Promise<{ r: Resposta; falha?: never } | { r?: never; falha: string }> {
    try {
      return { r: await chamar(metodo, caminho, corpo) };
    } catch (e) {
      const falha = e instanceof Error ? `${e.name === "AbortError" ? "A Sefin não respondeu a tempo" : e.message}` : String(e);
      log.warn("sem resposta da Sefin", { metodo, caminho, erro: falha });
      return { falha: `Sem resposta da Sefin: ${falha}` };
    }
  }

  const bruto = (r: Resposta): Bruto => ({ http: r.http, corpo: r.corpo });
  const naoEntendi = (r: Resposta) => ({
    tipo: "incerto" as const,
    motivo: `Resposta inesperada da Sefin (HTTP ${r.http}). ${errosDe(r.json).map((e) => `${e.codigo}: ${e.mensagem}`).join("; ")}`.trim(),
    ...bruto(r),
  });

  /** Recusa clara: veio a lista de erros num 400/422, ou o certificado não foi aceito (401/403). */
  function recusa(r: Resposta): ErroSefin[] | null {
    const erros = errosDe(r.json);
    if (r.http === 401 || r.http === 403)
      return erros.length ? erros : [{ codigo: `HTTP ${r.http}`, mensagem: "A Sefin não aceitou o certificado digital desta conexão." }];
    return (r.http === 400 || r.http === 422) && erros.length ? erros : null;
  }

  return {
    async emitir(dpsAssinada) {
      const { r, falha } = await tentar("POST", "/nfse", { dpsXmlGZipB64: compactar(dpsAssinada) });
      if (!r) return { tipo: "incerto", motivo: falha };
      if (r.http === 201 || r.http === 200) {
        const nfse = nfseDe(r.json);
        return nfse ? { tipo: "autorizada", nfse, ...bruto(r) } : naoEntendi(r);
      }
      const erros = recusa(r);
      return erros ? { tipo: "rejeitada", erros, ...bruto(r) } : naoEntendi(r);
    },

    async consultarDps(idDps) {
      // na URL vão só os 42 números: com o prefixo "DPS" do XML a Sefin responde E2400
      const { r, falha } = await tentar("GET", `/dps/${encodeURIComponent(idDps.replace(/^DPS/, ""))}`);
      if (!r) return { tipo: "incerto", motivo: falha };
      const chaveAcesso = texto(r.json, "chaveAcesso");
      if (r.http === 200 && chaveAcesso) return { tipo: "existe", chaveAcesso, ...bruto(r) };
      if (r.http === 404) return { tipo: "nao_existe", ...bruto(r) };
      return naoEntendi(r);
    },

    async consultarNfse(chaveAcesso) {
      const { r, falha } = await tentar("GET", `/nfse/${encodeURIComponent(chaveAcesso)}`);
      if (!r) return { tipo: "incerto", motivo: falha };
      const nfse = r.http === 200 ? nfseDe(r.json, chaveAcesso) : null;
      return nfse ? { tipo: "ok", nfse, ...bruto(r) } : naoEntendi(r);
    },

    async registrarEvento(chaveAcesso, pedidoAssinado) {
      const { r, falha } = await tentar("POST", `/nfse/${encodeURIComponent(chaveAcesso)}/eventos`, {
        pedidoRegistroEventoXmlGZipB64: compactar(pedidoAssinado),
      });
      if (!r) return { tipo: "incerto", motivo: falha };
      if (r.http === 201 || r.http === 200) {
        const xmlEvento = xmlDe(r.json, "eventoXmlGZipB64");
        return xmlEvento ? { tipo: "registrado", xmlEvento, ...bruto(r) } : naoEntendi(r);
      }
      const erros = recusa(r);
      return erros ? { tipo: "rejeitada", erros, ...bruto(r) } : naoEntendi(r);
    },

    async consultarEvento(chaveAcesso, tipoEvento) {
      // cancelamento acontece uma vez só: número sequencial 1
      const { r, falha } = await tentar("GET", `/nfse/${encodeURIComponent(chaveAcesso)}/eventos/${encodeURIComponent(tipoEvento)}/1`);
      if (!r) return { tipo: "incerto", motivo: falha };
      if (r.http === 404) return { tipo: "nao_existe", ...bruto(r) };
      const xmlEvento = r.http === 200 ? xmlDe(r.json, "eventoXmlGZipB64") : null;
      return xmlEvento ? { tipo: "existe", xmlEvento, ...bruto(r) } : naoEntendi(r);
    },
  };
}
