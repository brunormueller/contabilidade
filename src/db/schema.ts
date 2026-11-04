// Modelo do banco. Dinheiro em centavos (bigint) e alíquota em centésimos de ponto
// percentual (2,5% = 250) para não depender de ponto flutuante.
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({ dataType: () => "bytea" });
const agora = () => timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow();
const ts = () => timestamp({ withTimezone: true, mode: "date" });
const centavos = () => bigint({ mode: "number" });

export const perfilEnum = pgEnum("perfil", ["empresa", "contador"]);
export const ambienteEnum = pgEnum("ambiente", ["producao_restrita", "producao"]);
export const notaStatusEnum = pgEnum("nota_status", [
  "fila",
  "processando",
  "verificar", // resultado do envio incerto (timeout, 5xx): consultar a Sefin antes de reenviar
  "autorizada",
  "rejeitada",
  "cancelamento_pendente",
  "cancelada",
]);
export const docTipoEnum = pgEnum("doc_tipo", [
  "dps",
  "resposta",
  "nfse",
  "evento_envio",
  "evento_resposta",
  "consulta",
]);

export const empresa = pgTable("empresa", {
  id: uuid().primaryKey().defaultRandom(),
  razao: text().notNull().default(""),
  cnpj: text().notNull(),
  im: text().notNull().default(""),
  ibge: text().notNull().default("4208906"),
  serieDps: text().notNull().default("900"),
  vencDias: integer().notNull().default(10),
  cTribNacPadrao: text().notNull().default(""),
  cNbsPadrao: text().notNull().default(""),
  aliqIssPadrao: integer(),
  // configuração fiscal da DPS, preenchida com o contador
  pTotTribSn: integer(),
  cLocPrestacao: text().notNull().default(""),
  ibsCbs: jsonb().$type<{ cst: string; cClassTrib: string; cIndOp?: string; indDest: "0" | "1"; indFinal?: "0" | "1" }>(),
  atualizadoEm: agora(),
});

export const dpsSequencia = pgTable(
  "dps_sequencia",
  {
    empresaId: uuid().notNull().references(() => empresa.id),
    ambiente: ambienteEnum().notNull(),
    serie: text().notNull(),
    proxNdps: bigint({ mode: "number" }).notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.empresaId, t.ambiente, t.serie] })],
);

export const usuarios = pgTable(
  "usuarios",
  {
    id: uuid().primaryKey().defaultRandom(),
    empresaId: uuid().notNull().references(() => empresa.id),
    nome: text().notNull(),
    email: text().notNull(),
    perfil: perfilEnum().notNull(),
    senhaHash: text().notNull(),
    foto: bytea(),
    ativo: boolean().notNull().default(true),
    criadoEm: agora(),
    ultimoLogin: ts(),
  },
  (t) => [uniqueIndex("usuarios_email_uq").on(sql`lower(${t.email})`)],
);

export const sessoes = pgTable(
  "sessoes",
  {
    id: uuid().primaryKey().defaultRandom(),
    usuarioId: uuid()
      .notNull()
      .references(() => usuarios.id, { onDelete: "cascade" }),
    tokenHash: bytea().notNull(),
    criadoEm: agora(),
    expiraEm: ts().notNull(),
    ultimoUso: agora(),
    ip: text(),
    userAgent: text(),
  },
  (t) => [uniqueIndex("sessoes_token_uq").on(t.tokenHash), index("sessoes_usuario_ix").on(t.usuarioId)],
);

export const tentativasLogin = pgTable(
  "tentativas_login",
  {
    id: uuid().primaryKey().defaultRandom(),
    email: text().notNull(),
    ip: text(),
    criadoEm: agora(),
  },
  (t) => [index("tentativas_email_ix").on(t.email, t.criadoEm), index("tentativas_ip_ix").on(t.ip, t.criadoEm)],
);

export const certificados = pgTable(
  "certificados",
  {
    id: uuid().primaryKey().defaultRandom(),
    empresaId: uuid().notNull().references(() => empresa.id),
    pfxCifrado: bytea().notNull(),
    pfxIv: bytea().notNull(),
    pfxTag: bytea().notNull(),
    senhaCifrada: bytea().notNull(),
    senhaIv: bytea().notNull(),
    senhaTag: bytea().notNull(),
    keyVersion: integer().notNull(),
    titular: text().notNull(),
    cnpj: text().notNull(),
    emissor: text().notNull().default(""),
    serial: text().notNull(),
    fingerprint: text().notNull(),
    validoDe: ts().notNull(),
    validoAte: ts().notNull(),
    ativo: boolean().notNull().default(true),
    enviadoPor: uuid().references(() => usuarios.id),
    criadoEm: agora(),
  },
  (t) => [uniqueIndex("certificados_ativo_uq").on(t.empresaId).where(sql`${t.ativo}`)],
);

export const lotes = pgTable("lotes", {
  id: uuid().primaryKey().defaultRandom(),
  empresaId: uuid().notNull().references(() => empresa.id),
  ambiente: ambienteEnum().notNull(),
  arquivo: text().notNull().default(""),
  criadoPor: uuid().references(() => usuarios.id),
  criadoEm: agora(),
  qtd: integer().notNull(),
  valorTotal: centavos().notNull(),
});

export const notas = pgTable(
  "notas",
  {
    id: uuid().primaryKey().defaultRandom(),
    empresaId: uuid().notNull().references(() => empresa.id),
    loteId: uuid().references(() => lotes.id),
    ambiente: ambienteEnum().notNull(),
    linha: integer(),
    serie: text().notNull(),
    nDps: bigint({ mode: "number" }).notNull(),
    idDps: text().notNull(),
    status: notaStatusEnum().notNull().default("fila"),
    tentativas: integer().notNull().default(0),
    leaseAte: ts(),
    proximaTentativaEm: ts(),
    tomadorDoc: text().notNull(),
    tomadorNome: text().notNull(),
    tomadorEmail: text().notNull().default(""),
    descricao: text().notNull(),
    cTribNac: text().notNull(),
    cNbs: text().notNull().default(""),
    valor: centavos().notNull(),
    issRetido: boolean().notNull().default(false),
    aliqIss: integer(),
    vIssRet: centavos().notNull().default(0),
    vInssRet: centavos().notNull().default(0),
    vLiq: centavos().notNull(),
    competencia: date({ mode: "string" }).notNull(),
    vencimento: date({ mode: "string" }).notNull(),
    dhEmi: ts(),
    chaveAcesso: text(),
    nNfse: text(),
    dhProc: ts(),
    ultimoErro: jsonb(),
    cMotivoCanc: smallint(),
    xMotivoCanc: text(),
    dhCanc: ts(),
    criadoEm: agora(),
    atualizadoEm: agora(),
  },
  (t) => [
    uniqueIndex("notas_id_dps_uq").on(t.ambiente, t.idDps),
    uniqueIndex("notas_ndps_uq").on(t.empresaId, t.ambiente, t.serie, t.nDps),
    uniqueIndex("notas_chave_uq").on(t.chaveAcesso),
    index("notas_competencia_ix").on(t.empresaId, t.ambiente, t.competencia),
    index("notas_lote_ix").on(t.loteId, t.status),
  ],
);

export const notaDocumentos = pgTable(
  "nota_documentos",
  {
    id: uuid().primaryKey().defaultRandom(),
    notaId: uuid()
      .notNull()
      .references(() => notas.id),
    tipo: docTipoEnum().notNull(),
    tentativa: integer().notNull(),
    httpStatus: integer(),
    conteudo: text().notNull(),
    sha256: text().notNull(),
    criadoEm: agora(),
  },
  (t) => [index("nota_documentos_nota_ix").on(t.notaId, t.criadoEm)],
);

export const receber = pgTable(
  "receber",
  {
    id: uuid().primaryKey().defaultRandom(),
    empresaId: uuid().notNull().references(() => empresa.id),
    ambiente: ambienteEnum().notNull(),
    notaId: uuid().references(() => notas.id),
    descricao: text().notNull(),
    cliente: text().notNull(),
    valor: centavos().notNull(),
    venc: date({ mode: "string" }).notNull(),
    recebidoEm: date({ mode: "string" }),
    criadoEm: agora(),
  },
  (t) => [uniqueIndex("receber_nota_uq").on(t.notaId), index("receber_venc_ix").on(t.empresaId, t.ambiente, t.venc)],
);

export const pagar = pgTable(
  "pagar",
  {
    id: uuid().primaryKey().defaultRandom(),
    empresaId: uuid().notNull().references(() => empresa.id),
    descricao: text().notNull(),
    fornecedor: text().notNull().default(""),
    categoria: text().notNull(),
    valor: centavos().notNull(),
    venc: date({ mode: "string" }).notNull(),
    recorrente: boolean().notNull().default(false),
    // conta recorrente que gerou esta; único para não gerar a próxima duas vezes
    origemId: uuid(),
    pagoEm: date({ mode: "string" }),
    criadoEm: agora(),
  },
  (t) => [uniqueIndex("pagar_origem_uq").on(t.origemId), index("pagar_venc_ix").on(t.empresaId, t.venc)],
);

export const auditoria = pgTable(
  "auditoria",
  {
    id: uuid().primaryKey().defaultRandom(),
    empresaId: uuid().references(() => empresa.id),
    usuarioId: uuid().references(() => usuarios.id),
    acao: text().notNull(),
    entidade: text().notNull(),
    entidadeId: text(),
    dados: jsonb(),
    ip: text(),
    criadoEm: agora(),
  },
  (t) => [index("auditoria_em_ix").on(t.criadoEm)],
);
