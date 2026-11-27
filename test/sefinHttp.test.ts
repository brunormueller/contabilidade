// O cliente de verdade contra um servidor local que exige certificado, como a Sefin.
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import forge from "node-forge";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clienteSefin, compactar, descompactar } from "../src/nfse/sefinHttp.js";
import { gerarPfx } from "./certTeste.js";

function certServidor() {
  const k = forge.pki.rsa.generateKeyPair(2048);
  const c = forge.pki.createCertificate();
  c.publicKey = k.publicKey;
  c.serialNumber = "01";
  c.validity.notBefore = new Date(Date.now() - 86400e3);
  c.validity.notAfter = new Date(Date.now() + 86400e3);
  const nome = [{ name: "commonName", value: "localhost" }];
  c.setSubject(nome);
  c.setIssuer(nome);
  c.setExtensions([{ name: "basicConstraints", cA: true }, { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] }]);
  c.sign(k.privateKey, forge.md.sha256.create());
  return { key: forge.pki.privateKeyToPem(k.privateKey), cert: forge.pki.certificateToPem(c) };
}

type Pedido = { metodo: string; url: string; corpo: string; cliente: string };
let servidor: Server;
let url: string;
const srv = certServidor();
const cli = gerarPfx();
const pedidos: Pedido[] = [];
let resposta: { http: number; corpo: unknown; demora?: number };

beforeAll(async () => {
  servidor = createServer({ ...srv, requestCert: true, rejectUnauthorized: false }, (req, res) => {
    let corpo = "";
    req.on("data", (p) => (corpo += p));
    req.on("end", () => {
      const par = (req.socket as TLSSocket).getPeerCertificate();
      pedidos.push({ metodo: req.method!, url: req.url!, corpo, cliente: String(par?.subject?.CN ?? "") });
      setTimeout(() => {
        res.writeHead(resposta.http, { "content-type": "application/json" });
        res.end(typeof resposta.corpo === "string" ? resposta.corpo : JSON.stringify(resposta.corpo));
      }, resposta.demora ?? 0);
    });
  });
  await new Promise<void>((ok) => servidor.listen(0, ok));
  url = `https://localhost:${(servidor.address() as AddressInfo).port}/SefinNacional`;
});
afterAll(() => {
  servidor.closeAllConnections();
  servidor.close();
});
beforeEach(() => {
  pedidos.length = 0;
});

const sefin = (timeoutMs?: number) =>
  clienteSefin({ chavePem: cli.chavePem, certPem: cli.certPem, cadeiaPem: [cli.acPem] }, "producao_restrita", { url, ca: srv.cert, timeoutMs });

const CHAVE = "4".repeat(50);
const NFSE = `<NFSe><infNFSe Id="NFS${CHAVE}"><nNFSe>123</nNFSe><dhProc>2026-11-27T10:00:00-03:00</dhProc></infNFSe></NFSe>`;

describe("emitir", () => {
  it("manda a DPS em GZip+base64 com o certificado e lê a NFS-e", async () => {
    resposta = { http: 201, corpo: { chaveAcesso: CHAVE, nfseXmlGZipB64: compactar(NFSE) } };
    const r = await sefin().emitir("<DPS>ação</DPS>");
    expect(r).toMatchObject({ tipo: "autorizada", http: 201, nfse: { chaveAcesso: CHAVE, nNfse: "123" } });
    expect(r.tipo === "autorizada" && r.nfse.dhProc.toISOString()).toBe("2026-11-27T13:00:00.000Z");
    expect(pedidos[0]).toMatchObject({ metodo: "POST", url: "/SefinNacional/nfse" });
    expect(pedidos[0]!.cliente).toContain("EMPRESA TESTE");
    const enviado = JSON.parse(pedidos[0]!.corpo) as { dpsXmlGZipB64: string };
    expect(descompactar(enviado.dpsXmlGZipB64)).toBe('<?xml version="1.0" encoding="UTF-8"?><DPS>ação</DPS>');
  });

  it("recusa clara vira rejeitada, com ou sem maiúscula nos campos", async () => {
    resposta = { http: 400, corpo: { erros: [{ Codigo: "E0001", Descricao: "Campo inválido", Complemento: "cTribNac" }] } };
    expect(await sefin().emitir("<DPS/>")).toMatchObject({ tipo: "rejeitada", erros: [{ codigo: "E0001", mensagem: "Campo inválido cTribNac" }] });
    resposta = { http: 403, corpo: "<html>Forbidden</html>" };
    expect(await sefin().emitir("<DPS/>")).toMatchObject({ tipo: "rejeitada", erros: [{ codigo: "HTTP 403" }] });
  });

  it.each([
    ["500", { http: 500, corpo: { erros: [{ codigo: "X", descricao: "falha" }] } }],
    ["400 sem lista de erros", { http: 400, corpo: "Bad Request" }],
    ["404 (endereço errado)", { http: 404, corpo: "" }],
    ["201 sem a NFS-e", { http: 201, corpo: { chaveAcesso: CHAVE } }],
  ])("%s é incerto, nunca rejeitada", async (_n, r) => {
    resposta = r;
    expect((await sefin().emitir("<DPS/>")).tipo).toBe("incerto");
  });

  it("demora além do limite é incerto", async () => {
    resposta = { http: 201, corpo: {}, demora: 500 };
    expect(await sefin(100).emitir("<DPS/>")).toMatchObject({ tipo: "incerto", motivo: expect.stringMatching(/Sem resposta/) });
  });
});

describe("consultas e eventos", () => {
  it("DPS: 200 existe, 404 não existe, o resto é incerto", async () => {
    const numeros = "4".repeat(42);
    resposta = { http: 200, corpo: { chaveAcesso: CHAVE } };
    expect(await sefin().consultarDps(`DPS${numeros}`)).toMatchObject({ tipo: "existe", chaveAcesso: CHAVE });
    expect(pedidos[0]!.url).toBe(`/SefinNacional/dps/${numeros}`);
    resposta = { http: 404, corpo: { erro: { codigo: "E", descricao: "não há" } } };
    expect((await sefin().consultarDps("DPS1")).tipo).toBe("nao_existe");
    resposta = { http: 503, corpo: "" };
    expect((await sefin().consultarDps("DPS1")).tipo).toBe("incerto");
  });

  it("NFS-e pela chave", async () => {
    resposta = { http: 200, corpo: { nfseXmlGZipB64: compactar(NFSE) } };
    expect(await sefin().consultarNfse(CHAVE)).toMatchObject({ tipo: "ok", nfse: { chaveAcesso: CHAVE, nNfse: "123" } });
  });

  it("cancelamento: registra, recusa e consulta pelo sequencial 1", async () => {
    resposta = { http: 201, corpo: { eventoXmlGZipB64: compactar("<evento/>") } };
    expect(await sefin().registrarEvento(CHAVE, "<pedRegEvento/>")).toMatchObject({ tipo: "registrado" });
    expect(Object.keys(JSON.parse(pedidos[0]!.corpo))).toEqual(["pedidoRegistroEventoXmlGZipB64"]);
    resposta = { http: 400, corpo: { erro: { codigo: "E9", descricao: "fora do prazo" } } };
    expect(await sefin().registrarEvento(CHAVE, "<pedRegEvento/>")).toMatchObject({ tipo: "rejeitada", erros: [{ codigo: "E9" }] });
    resposta = { http: 200, corpo: { eventoXmlGZipB64: compactar("<evento/>") } };
    expect(await sefin().consultarEvento(CHAVE, "101101")).toMatchObject({ tipo: "existe" });
    expect(pedidos[2]!.url).toBe(`/SefinNacional/nfse/${CHAVE}/eventos/101101/1`);
    resposta = { http: 404, corpo: "" };
    expect((await sefin().consultarEvento(CHAVE, "101101")).tipo).toBe("nao_existe");
  });
});
