import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { guardarCertificado } from "../src/cert/certificado.js";
import { lerPfx } from "../src/cert/pfx.js";
import type { DB } from "../src/db/client.js";
import { empresa, notas, receber } from "../src/db/schema.js";
import { assinar, conferirAssinatura } from "../src/nfse/assinatura.js";
import { idPedRegEvento, montarCancelamento } from "../src/nfse/evento.js";
import { processarFila } from "../src/nfse/fila.js";
import { validarXsd } from "../src/nfse/xsd.js";
import { gerarPfx } from "./certTeste.js";
import { comoContador, comoEmpresa } from "./cliente.js";
import { CNPJ_EMPRESA, cenarioBase } from "./helpers.js";
import { instalarSefinFake } from "./sefinFake.js";

const cert = gerarPfx({ cnpj: CNPJ_EMPRESA });
// chave no formato de TSChaveNFSe (50 posições)
const CHAVE = `420890622${CNPJ_EMPRESA}${"1".padStart(13, "0")}2611${"1".padStart(9, "0")}0`;
const MOTIVO = { cMotivo: "1", xMotivo: "Erro no valor do serviço informado" };

describe("pedido de cancelamento contra o XSD", () => {
  it("Id no padrão TSIdPedRegEvt", () => {
    expect(CHAVE).toHaveLength(50);
    expect(idPedRegEvento(CHAVE, "101101")).toMatch(/^PRE[0-9]{8}(1[0-9]{14}|2[0-9A-Z]{14})[0-9]{33}$/);
  });

  it.each(["producao_restrita", "producao"] as const)("assinado, passa no XSD de %s", async (amb) => {
    const { xml } = montarCancelamento({ chaveAcesso: CHAVE, cnpj: CNPJ_EMPRESA, ambiente: amb, dhEvento: new Date(), cMotivo: "1", xMotivo: MOTIVO.xMotivo });
    const pfx = lerPfx(cert.pfx, cert.senha);
    const s = assinar(xml, "infPedReg", pfx, "sha256");
    expect((await validarXsd(s, amb, "pedRegEvento_v1.01.xsd")).erros).toEqual([]);
    expect(s).toContain("<e101101><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo>");
    expect(s).toMatch(/<\/infPedReg><Signature xmlns="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#">/);
    expect(conferirAssinatura(s, "infPedReg", pfx.certPem)).toBe(true);
  });

  it("motivo curto demais não passa no XSD (TSMotivo: 15 a 255)", async () => {
    const { xml } = montarCancelamento({ chaveAcesso: CHAVE, cnpj: CNPJ_EMPRESA, ambiente: "producao_restrita", dhEvento: new Date(), cMotivo: "9", xMotivo: "curto" });
    expect((await validarXsd(xml, "producao_restrita", "pedRegEvento_v1.01.xsd")).valido).toBe(false);
  });
});

describe("notas emitidas e cancelamento", () => {
  let d: DB;
  let sefin: ReturnType<typeof instalarSefinFake>;

  beforeEach(async () => {
    let empresaId: string, adm: { id: string };
    ({ d, empresaId, adm } = await cenarioBase());
    await d.update(empresa).set({ cTribNacPadrao: "010701", cNbsPadrao: "115021000", pTotTribSn: 600, ibsCbs: { cst: "000", cClassTrib: "000001", indDest: "0" } });
    await d.transaction((tx) => guardarCertificado(tx, { empresaId, cnpjEmpresa: CNPJ_EMPRESA, pfx: cert.pfx, senha: cert.senha, usuarioId: adm.id }));
    sefin = instalarSefinFake();
  });

  async function emitida() {
    const c = await comoEmpresa();
    const linhas = [{ tomador_documento: "11.444.777/0001-61", tomador_nome: "Metalúrgica Itapocu", descricao: "Manutenção", valor: "1.000,00" }];
    expect((await c.post("/api/lotes", { chave: randomUUID(), linhas })).status).toBe(201);
    await processarFila(d, { ambiente: "producao_restrita" });
    const [n] = await d.select().from(notas);
    expect(n!.status).toBe("autorizada");
    return { c, n: n! };
  }
  const mes = () => new Date().toISOString().slice(0, 7);

  it("lista do mês, detalhe e XMLs; contador também vê", async () => {
    const { n } = await emitida();
    const k = await comoContador();
    const lista = (await (await k.get(`/api/notas?mes=${mes()}`)).json()) as { id: string; numero: string }[];
    expect(lista.map((x) => x.id)).toEqual([n.id]);
    const det = (await (await k.get(`/api/notas/${n.id}`)).json()) as { documentos: { tipo: string }[] };
    expect(det.documentos.map((x) => x.tipo).sort()).toEqual(["dps", "nfse", "resposta"]);
    const xmls = (await (await k.get(`/api/notas/xmls?mes=${mes()}`)).json()) as { nome: string; xml: string }[];
    expect(xmls).toEqual([{ nome: "NFSe-1.xml", xml: expect.stringContaining("<nNFSe>1</nNFSe>") }]);
    expect((await k.get(`/api/notas?mes=${mes()}&status=cancelada`)).status).toBe(200);
    expect((await k.get("/api/notas?mes=2026-13")).status).toBe(400);
  });

  it("cancela: evento assinado, nota cancelada, título em aberto removido", async () => {
    const { c, n } = await emitida();
    const r = await c.post(`/api/notas/${n.id}/cancelar`, MOTIVO);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "cancelada", nota: { status: "cancelada", cancelamento: { cMotivo: "1", xMotivo: MOTIVO.xMotivo } } });
    expect(await d.$count(receber)).toBe(0);
    const xmls = (await (await c.get(`/api/notas/${n.id}/xmls`)).json()) as { nome: string }[];
    expect(xmls.map((x) => x.nome)).toEqual(["NFSe-1.xml", "NFSe-1-cancelamento.xml"]);
    // não cancela de novo
    expect((await c.post(`/api/notas/${n.id}/cancelar`, MOTIVO)).status).toBe(409);
  });

  it("título já recebido continua no financeiro depois do cancelamento", async () => {
    const { c, n } = await emitida();
    await d.update(receber).set({ recebidoEm: "2026-11-01" });
    await c.post(`/api/notas/${n.id}/cancelar`, MOTIVO);
    expect(await d.$count(receber)).toBe(1);
  });

  it("recusa da Sefin: volta para autorizada com o motivo", async () => {
    const { c, n } = await emitida();
    sefin.roteiro.evento.push("rejeita");
    const r = await c.post(`/api/notas/${n.id}/cancelar`, MOTIVO);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { erro: string }).erro).toMatch(/E9998/);
    const [x] = await d.select().from(notas).where(eq(notas.id, n.id));
    expect(x).toMatchObject({ status: "autorizada", cMotivoCanc: null });
    expect(await d.$count(receber)).toBe(1);
  });

  it("sem resposta: fica pendente; verificar consulta o evento e não pede de novo", async () => {
    const { c, n } = await emitida();
    sefin.roteiro.evento.push("registra_sem_responder");
    const r = await c.post(`/api/notas/${n.id}/cancelar`, MOTIVO);
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ status: "cancelamento_pendente" });
    // aparece no filtro de autorizadas, com a situação pendente
    const lista = (await (await c.get(`/api/notas?mes=${mes()}&status=autorizada`)).json()) as { status: string }[];
    expect(lista[0]!.status).toBe("cancelamento_pendente");

    const v = await c.post(`/api/notas/${n.id}/cancelar`, {});
    expect(await v.json()).toMatchObject({ status: "cancelada" });
    expect(sefin.chamadas.registrarEvento).toHaveLength(1);
    expect(sefin.chamadas.consultarEvento).toHaveLength(1);
  });

  it("valida o motivo e o perfil", async () => {
    const { c, n } = await emitida();
    expect((await c.post(`/api/notas/${n.id}/cancelar`, { cMotivo: "1", xMotivo: "curto" })).status).toBe(400);
    expect((await c.post(`/api/notas/${n.id}/cancelar`, { cMotivo: "5", xMotivo: MOTIVO.xMotivo })).status).toBe(400);
    expect((await c.post(`/api/notas/${n.id}/cancelar`, {})).status).toBe(400);
    expect((await (await comoContador()).post(`/api/notas/${n.id}/cancelar`, MOTIVO)).status).toBe(403);
  });
});
