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

export const perfilEnum = pgEnum("perfil", ["empresa", "contador", "funcionario"]);
export const visitaStatusEnum = pgEnum("visita_status", ["pendente", "em_atendimento", "concluida", "nao_realizada"]);
export const envioStatusEnum = pgEnum("envio_status", ["pendente", "enviado", "erro"]);
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
  // faturamento mensal: dia do mês da emissão automática (null = desligada; 31 vira o último dia)
  diaEmissao: smallint(),
  // meses com data de emissão antes disto não são faturados sozinhos (configurou no meio do mês)
  faturamentoDesde: date({ mode: "string" }),
  enviarEmail: boolean().notNull().default(false),
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

export const lotes = pgTable(
  "lotes",
  {
    id: uuid().primaryKey().defaultRandom(),
    empresaId: uuid().notNull().references(() => empresa.id),
    ambiente: ambienteEnum().notNull(),
    arquivo: text().notNull().default(""),
    // chave que o navegador gera ao carregar a planilha: clique duplo ou reenvio não cria
    // um segundo lote com outros números de DPS
    chaveIdem: text().notNull(),
    hashLinhas: text().notNull(),
    criadoPor: uuid().references(() => usuarios.id),
    criadoEm: agora(),
    qtd: integer().notNull(),
    valorTotal: centavos().notNull(),
  },
  (t) => [uniqueIndex("lotes_idem_uq").on(t.empresaId, t.chaveIdem)],
);

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
    index("notas_fila_ix").on(t.ambiente, t.status, t.proximaTentativaEm),
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

// ---------- clientes, rotas e visitas ----------

/** Mensalidade contratada pelo cliente. */
export const planos = pgTable(
  "planos",
  {
    id: uuid().primaryKey().defaultRandom(),
    empresaId: uuid().notNull().references(() => empresa.id),
    nome: text().notNull(),
    // texto que vai na descrição da nota
    descricao: text().notNull().default(""),
    valor: centavos().notNull(),
    ativo: boolean().notNull().default(true),
    criadoEm: agora(),
  },
  (t) => [index("planos_empresa_ix").on(t.empresaId)],
);

/** Serviço avulso que o funcionário marca na visita e é cobrado além da mensalidade. */
export const servicos = pgTable(
  "servicos",
  {
    id: uuid().primaryKey().defaultRandom(),
    empresaId: uuid().notNull().references(() => empresa.id),
    nome: text().notNull(),
    valor: centavos().notNull(),
    ativo: boolean().notNull().default(true),
    criadoEm: agora(),
  },
  (t) => [index("servicos_empresa_ix").on(t.empresaId)],
);

export const clientes = pgTable(
  "clientes",
  {
    id: uuid().primaryKey().defaultRandom(),
    empresaId: uuid().notNull().references(() => empresa.id),
    doc: text().notNull(),
    nome: text().notNull(),
    email: text().notNull().default(""),
    telefone: text().notNull().default(""),
    endereco: text().notNull().default(""),
    planoId: uuid().references(() => planos.id),
    ativo: boolean().notNull().default(true),
    criadoEm: agora(),
    atualizadoEm: agora(),
  },
  (t) => [index("clientes_empresa_ix").on(t.empresaId, t.ativo)],
);

export const rotas = pgTable(
  "rotas",
  {
    id: uuid().primaryKey().defaultRandom(),
    empresaId: uuid().notNull().references(() => empresa.id),
    nome: text().notNull(),
    funcionarioId: uuid()
      .notNull()
      .references(() => usuarios.id),
    // dias da semana em que a rota roda: 0 = domingo … 6 = sábado
    dias: smallint().array().notNull(),
    ativo: boolean().notNull().default(true),
    criadoEm: agora(),
  },
  (t) => [index("rotas_empresa_ix").on(t.empresaId, t.ativo)],
);

export const rotaParadas = pgTable(
  "rota_paradas",
  {
    rotaId: uuid()
      .notNull()
      .references(() => rotas.id, { onDelete: "cascade" }),
    clienteId: uuid()
      .notNull()
      .references(() => clientes.id),
    ordem: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.rotaId, t.clienteId] })],
);

export type Gps = { lat: number; lng: number; precisao: number | null };

export const visitas = pgTable(
  "visitas",
  {
    id: uuid().primaryKey().defaultRandom(),
    empresaId: uuid().notNull().references(() => empresa.id),
    rotaId: uuid()
      .notNull()
      .references(() => rotas.id),
    clienteId: uuid()
      .notNull()
      .references(() => clientes.id),
    funcionarioId: uuid()
      .notNull()
      .references(() => usuarios.id),
    data: date({ mode: "string" }).notNull(),
    ordem: integer().notNull(),
    status: visitaStatusEnum().notNull().default("pendente"),
    chegadaEm: ts(),
    chegadaGps: jsonb().$type<Gps>(),
    fimEm: ts(),
    fimGps: jsonb().$type<Gps>(),
    obs: text().notNull().default(""),
    motivo: text().notNull().default(""),
    criadoEm: agora(),
    atualizadoEm: agora(),
  },
  (t) => [
    // a mesma parada não vira duas visitas no mesmo dia
    uniqueIndex("visitas_dia_uq").on(t.rotaId, t.clienteId, t.data),
    index("visitas_empresa_ix").on(t.empresaId, t.data),
    index("visitas_funcionario_ix").on(t.funcionarioId, t.data),
  ],
);

/** O que foi feito na visita. Nome e valor copiados: mudar o catálogo depois não muda o histórico. */
export const visitaItens = pgTable(
  "visita_itens",
  {
    visitaId: uuid()
      .notNull()
      .references(() => visitas.id, { onDelete: "cascade" }),
    servicoId: uuid()
      .notNull()
      .references(() => servicos.id),
    nome: text().notNull(),
    valor: centavos().notNull(),
    // nota em que o serviço foi cobrado; null = ainda não faturado
    notaId: uuid().references(() => notas.id),
  },
  (t) => [primaryKey({ columns: [t.visitaId, t.servicoId] }), index("visita_itens_nota_ix").on(t.notaId)],
);

/** Mensalidade do mês já faturada para o cliente. Impede cobrar o mesmo mês duas vezes. */
export const faturas = pgTable(
  "faturas",
  {
    id: uuid().primaryKey().defaultRandom(),
    empresaId: uuid().notNull().references(() => empresa.id),
    ambiente: ambienteEnum().notNull(),
    clienteId: uuid()
      .notNull()
      .references(() => clientes.id),
    mes: text().notNull(), // YYYY-MM
    notaId: uuid()
      .notNull()
      .references(() => notas.id),
    mensalidade: centavos().notNull(),
    extras: centavos().notNull(),
    automatica: boolean().notNull(),
    criadoEm: agora(),
  },
  (t) => [uniqueIndex("faturas_mes_uq").on(t.ambiente, t.clienteId, t.mes), index("faturas_empresa_ix").on(t.empresaId, t.ambiente, t.mes)],
);

/** E-mail da nota autorizada para o tomador. */
export const envios = pgTable(
  "envios",
  {
    id: uuid().primaryKey().defaultRandom(),
    empresaId: uuid().notNull().references(() => empresa.id),
    notaId: uuid()
      .notNull()
      .references(() => notas.id),
    para: text().notNull(),
    status: envioStatusEnum().notNull().default("pendente"),
    tentativas: integer().notNull().default(0),
    proximaTentativaEm: ts().notNull().defaultNow(),
    leaseAte: ts(),
    ultimoErro: text(),
    enviadoEm: ts(),
    criadoEm: agora(),
  },
  (t) => [uniqueIndex("envios_nota_uq").on(t.notaId), index("envios_fila_ix").on(t.status, t.proximaTentativaEm)],
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
