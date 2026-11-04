// Pedido de registro de evento (pedRegEvento), por enquanto só o cancelamento (e101101).
// Leiaute igual nos dois ambientes (xsd/*/tiposEventos_v1.01.xsd).
import type { Ambiente } from "../env.js";
import { LAYOUTS } from "./ambiente.js";
import { dhBrasilia, NS, VER_APLIC, VERSAO } from "./dps.js";
import { g, t } from "./xml.js";

export const EVENTO_CANCELAMENTO = "101101";

// TSCodJustCanc
export const MOTIVOS_CANCELAMENTO = { "1": "Erro na emissão", "2": "Serviço não prestado", "9": "Outros" } as const;
export type MotivoCancelamento = keyof typeof MOTIVOS_CANCELAMENTO;

/** TSIdPedRegEvt: "PRE" + chave de acesso (50) + tipo do evento (6). */
export const idPedRegEvento = (chave: string, tipo: string) => `PRE${chave}${tipo}`;

export function montarCancelamento(a: { chaveAcesso: string; cnpj: string; ambiente: Ambiente; dhEvento: Date; cMotivo: MotivoCancelamento; xMotivo: string }) {
  const id = idPedRegEvento(a.chaveAcesso, EVENTO_CANCELAMENTO);
  const xml =
    `<pedRegEvento xmlns="${NS}" versao="${VERSAO}">` +
    `<infPedReg Id="${id}">` +
    t("tpAmb", LAYOUTS[a.ambiente].tpAmb) +
    t("verAplic", VER_APLIC) +
    t("dhEvento", dhBrasilia(a.dhEvento)) +
    t("CNPJAutor", a.cnpj) +
    t("chNFSe", a.chaveAcesso) +
    g(`e${EVENTO_CANCELAMENTO}`, t("xDesc", "Cancelamento de NFS-e"), t("cMotivo", a.cMotivo), t("xMotivo", a.xMotivo)) +
    `</infPedReg></pedRegEvento>`;
  return { id, xml };
}
