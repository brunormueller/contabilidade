// Contrato entre a fila e a API da Sefin Nacional. A fila só conhece este contrato; o cliente
// HTTP com mTLS (etapa 11) o implementa quando o Swagger confirmar campos, codificação e
// formato de erro. Rotas confirmadas no manual do Emissor Público: POST /nfse,
// GET /nfse/{chaveAcesso}, GET /dps/{id}.
import type { Pfx } from "../cert/pfx.js";
import type { Ambiente } from "../env.js";

/** O que voltou da Sefin, como texto, para guardar junto com a nota. */
export type Bruto = { http?: number; corpo?: string };

export type ErroSefin = { codigo: string; mensagem: string };

export type NfseGerada = { chaveAcesso: string; nNfse: string; dhProc: Date; xml: string };

export type RespostaEmissao =
  | ({ tipo: "autorizada"; nfse: NfseGerada } & Bruto)
  // a Sefin leu a DPS e recusou: nada foi gerado
  | ({ tipo: "rejeitada"; erros: ErroSefin[] } & Bruto)
  // timeout, queda de conexão, 5xx, resposta ilegível: pode ou não ter gerado a NFS-e
  | ({ tipo: "incerto"; motivo: string } & Bruto);

export type RespostaConsultaDps =
  | ({ tipo: "existe"; chaveAcesso: string } & Bruto)
  | ({ tipo: "nao_existe" } & Bruto)
  | ({ tipo: "incerto"; motivo: string } & Bruto);

export type RespostaConsultaNfse = ({ tipo: "ok"; nfse: NfseGerada } & Bruto) | ({ tipo: "incerto"; motivo: string } & Bruto);

/** xmlEvento: o evento registrado que a Sefin devolve (leiaute evento_v1.01.xsd). */
export type RespostaEvento =
  | ({ tipo: "registrado"; xmlEvento: string } & Bruto)
  | ({ tipo: "rejeitada"; erros: ErroSefin[] } & Bruto)
  | ({ tipo: "incerto"; motivo: string } & Bruto);

export type RespostaConsultaEvento =
  | ({ tipo: "existe"; xmlEvento: string } & Bruto)
  | ({ tipo: "nao_existe" } & Bruto)
  | ({ tipo: "incerto"; motivo: string } & Bruto);

export interface Sefin {
  emitir(dpsAssinada: string): Promise<RespostaEmissao>;
  consultarDps(idDps: string): Promise<RespostaConsultaDps>;
  consultarNfse(chaveAcesso: string): Promise<RespostaConsultaNfse>;
  /** POST /nfse/{chaveAcesso}/eventos */
  registrarEvento(chaveAcesso: string, pedidoAssinado: string): Promise<RespostaEvento>;
  /** GET /nfse/{chaveAcesso}/eventos/{tipoEvento} */
  consultarEvento(chaveAcesso: string, tipoEvento: string): Promise<RespostaConsultaEvento>;
}

export type FabricaSefin = (cert: Pfx, ambiente: Ambiente) => Sefin;

// Anexo I, E0014: série + número + município + CNPJ já viraram NFS-e. Não é recusa de
// verdade: a nota existe e precisa ser buscada pela consulta da DPS.
export const DPS_JA_EXISTE = "E0014";

let fabrica: FabricaSefin = () => {
  throw new Error("Cliente da Sefin ainda não implementado (etapa 11: falta o Swagger da API).");
};

export const sefinPara: FabricaSefin = (cert, ambiente) => fabrica(cert, ambiente);

/** Testes trocam pelo simulador; a etapa 11 registra o cliente real. */
export function usarSefin(f: FabricaSefin) {
  fabrica = f;
}
