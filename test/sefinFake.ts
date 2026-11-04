// Sefin de mentira para os testes da fila. Guarda as NFS-e "geradas" como a de verdade
// guardaria, confere a assinatura com o certificado da conexão e deixa cada teste roteirizar
// a próxima resposta (rejeição, timeout depois de gerar, E0014...).
import { conferirAssinatura } from "../src/nfse/assinatura.js";
import type { NfseGerada, RespostaEmissao, Sefin } from "../src/nfse/sefin.js";
import { usarSefin } from "../src/nfse/sefin.js";

export type Comportamento = "autoriza" | "rejeita" | "gera_sem_responder" | "timeout" | "ja_existe";
export type ComportamentoEvento = "registra" | "rejeita" | "registra_sem_responder" | "timeout";

export function instalarSefinFake() {
  const geradas = new Map<string, NfseGerada>();
  const eventos = new Map<string, string>(); // chave + tipo -> XML do evento
  const chamadas = { emitir: [] as string[], consultarDps: [] as string[], consultarNfse: [] as string[], registrarEvento: [] as string[], consultarEvento: [] as string[] };
  const roteiro = {
    emitir: [] as Comportamento[],
    consultarDps: [] as ("incerto" | "nao_existe")[],
    evento: [] as ComportamentoEvento[],
    antesDeResponder: null as null | (() => Promise<void>),
  };
  let numero = 0;

  // chave no formato de TSChaveNFSe: município, ambiente, tipo de inscrição, CNPJ, nº, AAMM, código, DV
  const gerar = (id: string): NfseGerada => {
    numero++;
    const cnpj = id.slice(11, 25);
    const chave = `420890622${cnpj}${String(numero).padStart(13, "0")}2611${String(numero).padStart(9, "0")}0`;
    const nfse = { chaveAcesso: chave, nNfse: String(numero), dhProc: new Date(), xml: `<NFSe><infNFSe Id="NFS${chave}"><nNFSe>${numero}</nNFSe></infNFSe></NFSe>` };
    geradas.set(id, nfse);
    return nfse;
  };

  usarSefin((cert) => {
    const s: Sefin = {
      async emitir(xml) {
        const id = /<infDPS Id="([^"]+)"/.exec(xml)![1]!;
        chamadas.emitir.push(id);
        await roteiro.antesDeResponder?.();
        if (!conferirAssinatura(xml, "infDPS", cert.certPem))
          return { tipo: "rejeitada", erros: [{ codigo: "E0714", mensagem: "Arquivo enviado com erro na assinatura." }], http: 400, corpo: "{}" };
        const c = roteiro.emitir.shift() ?? "autoriza";
        if (geradas.has(id) || c === "ja_existe") {
          if (!geradas.has(id)) gerar(id);
          return { tipo: "rejeitada", erros: [{ codigo: "E0014", mensagem: "DPS já existe em uma NFS-e." }], http: 400, corpo: '{"erro":"E0014"}' };
        }
        const r: Record<Exclude<Comportamento, "ja_existe">, () => RespostaEmissao> = {
          autoriza: () => ({ tipo: "autorizada", nfse: gerar(id), http: 201, corpo: '{"ok":true}' }),
          rejeita: () => ({ tipo: "rejeitada", erros: [{ codigo: "E9999", mensagem: "Rejeição simulada" }], http: 400, corpo: '{"erro":"E9999"}' }),
          gera_sem_responder: () => (gerar(id), { tipo: "incerto", motivo: "timeout" }),
          timeout: () => ({ tipo: "incerto", motivo: "timeout" }),
        };
        return r[c]();
      },
      async consultarDps(id) {
        chamadas.consultarDps.push(id);
        const forcado = roteiro.consultarDps.shift();
        if (forcado === "incerto") return { tipo: "incerto", motivo: "503" };
        const n = forcado === "nao_existe" ? undefined : geradas.get(id);
        return n ? { tipo: "existe", chaveAcesso: n.chaveAcesso, http: 200, corpo: `{"chaveAcesso":"${n.chaveAcesso}"}` } : { tipo: "nao_existe", http: 404 };
      },
      async consultarNfse(chave) {
        chamadas.consultarNfse.push(chave);
        const n = [...geradas.values()].find((x) => x.chaveAcesso === chave);
        return n ? { tipo: "ok", nfse: n, http: 200, corpo: n.xml } : { tipo: "incerto", motivo: "404" };
      },
      async registrarEvento(chave, xml) {
        chamadas.registrarEvento.push(chave);
        if (!conferirAssinatura(xml, "infPedReg", cert.certPem))
          return { tipo: "rejeitada", erros: [{ codigo: "E0714", mensagem: "Arquivo enviado com erro na assinatura." }], http: 400, corpo: "{}" };
        const tipo = /<e(\d{6})>/.exec(xml)![1]!;
        const evento = `<evento><infEvento Id="EVT${chave}${tipo}001"/></evento>`;
        const c = roteiro.evento.shift() ?? "registra";
        if (c === "rejeita") return { tipo: "rejeitada", erros: [{ codigo: "E9998", mensagem: "Cancelamento recusado (simulado)" }], http: 400, corpo: '{"erro":"E9998"}' };
        if (c === "timeout") return { tipo: "incerto", motivo: "timeout" };
        eventos.set(chave + tipo, evento);
        if (c === "registra_sem_responder") return { tipo: "incerto", motivo: "timeout" };
        return { tipo: "registrado", xmlEvento: evento, http: 201, corpo: "{}" };
      },
      async consultarEvento(chave, tipo) {
        chamadas.consultarEvento.push(chave);
        const ev = eventos.get(chave + tipo);
        return ev ? { tipo: "existe", xmlEvento: ev, http: 200, corpo: ev } : { tipo: "nao_existe", http: 404 };
      },
    };
    return s;
  });
  return { geradas, eventos, chamadas, roteiro };
}
