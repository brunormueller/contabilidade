CREATE TYPE "public"."ambiente" AS ENUM('producao_restrita', 'producao');--> statement-breakpoint
CREATE TYPE "public"."doc_tipo" AS ENUM('dps', 'resposta', 'nfse', 'evento_envio', 'evento_resposta', 'consulta');--> statement-breakpoint
CREATE TYPE "public"."nota_status" AS ENUM('fila', 'processando', 'verificar', 'autorizada', 'rejeitada', 'cancelamento_pendente', 'cancelada');--> statement-breakpoint
CREATE TYPE "public"."perfil" AS ENUM('empresa', 'contador');--> statement-breakpoint
CREATE TABLE "auditoria" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"empresa_id" uuid,
	"usuario_id" uuid,
	"acao" text NOT NULL,
	"entidade" text NOT NULL,
	"entidade_id" text,
	"dados" jsonb,
	"ip" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "certificados" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"empresa_id" uuid NOT NULL,
	"pfx_cifrado" "bytea" NOT NULL,
	"pfx_iv" "bytea" NOT NULL,
	"pfx_tag" "bytea" NOT NULL,
	"senha_cifrada" "bytea" NOT NULL,
	"senha_iv" "bytea" NOT NULL,
	"senha_tag" "bytea" NOT NULL,
	"key_version" integer NOT NULL,
	"titular" text NOT NULL,
	"cnpj" text NOT NULL,
	"emissor" text DEFAULT '' NOT NULL,
	"serial" text NOT NULL,
	"fingerprint" text NOT NULL,
	"valido_de" timestamp with time zone NOT NULL,
	"valido_ate" timestamp with time zone NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"enviado_por" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dps_sequencia" (
	"empresa_id" uuid NOT NULL,
	"ambiente" "ambiente" NOT NULL,
	"serie" text NOT NULL,
	"prox_ndps" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "dps_sequencia_empresa_id_ambiente_serie_pk" PRIMARY KEY("empresa_id","ambiente","serie")
);
--> statement-breakpoint
CREATE TABLE "empresa" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"razao" text DEFAULT '' NOT NULL,
	"cnpj" text NOT NULL,
	"im" text DEFAULT '' NOT NULL,
	"ibge" text DEFAULT '4208906' NOT NULL,
	"serie_dps" text DEFAULT '900' NOT NULL,
	"venc_dias" integer DEFAULT 10 NOT NULL,
	"c_trib_nac_padrao" text DEFAULT '' NOT NULL,
	"c_nbs_padrao" text DEFAULT '' NOT NULL,
	"aliq_iss_padrao" integer,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"empresa_id" uuid NOT NULL,
	"ambiente" "ambiente" NOT NULL,
	"arquivo" text DEFAULT '' NOT NULL,
	"criado_por" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"qtd" integer NOT NULL,
	"valor_total" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nota_documentos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nota_id" uuid NOT NULL,
	"tipo" "doc_tipo" NOT NULL,
	"tentativa" integer NOT NULL,
	"http_status" integer,
	"conteudo" text NOT NULL,
	"sha256" text NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"empresa_id" uuid NOT NULL,
	"lote_id" uuid,
	"ambiente" "ambiente" NOT NULL,
	"linha" integer,
	"serie" text NOT NULL,
	"n_dps" bigint NOT NULL,
	"id_dps" text NOT NULL,
	"status" "nota_status" DEFAULT 'fila' NOT NULL,
	"tentativas" integer DEFAULT 0 NOT NULL,
	"lease_ate" timestamp with time zone,
	"proxima_tentativa_em" timestamp with time zone,
	"tomador_doc" text NOT NULL,
	"tomador_nome" text NOT NULL,
	"tomador_email" text DEFAULT '' NOT NULL,
	"descricao" text NOT NULL,
	"c_trib_nac" text NOT NULL,
	"c_nbs" text DEFAULT '' NOT NULL,
	"valor" bigint NOT NULL,
	"iss_retido" boolean DEFAULT false NOT NULL,
	"aliq_iss" integer,
	"v_iss_ret" bigint DEFAULT 0 NOT NULL,
	"v_inss_ret" bigint DEFAULT 0 NOT NULL,
	"v_liq" bigint NOT NULL,
	"competencia" date NOT NULL,
	"vencimento" date NOT NULL,
	"dh_emi" timestamp with time zone,
	"chave_acesso" text,
	"n_nfse" text,
	"dh_proc" timestamp with time zone,
	"ultimo_erro" jsonb,
	"c_motivo_canc" smallint,
	"x_motivo_canc" text,
	"dh_canc" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pagar" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"empresa_id" uuid NOT NULL,
	"descricao" text NOT NULL,
	"fornecedor" text DEFAULT '' NOT NULL,
	"categoria" text NOT NULL,
	"valor" bigint NOT NULL,
	"venc" date NOT NULL,
	"recorrente" boolean DEFAULT false NOT NULL,
	"origem_id" uuid,
	"pago_em" date,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receber" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"empresa_id" uuid NOT NULL,
	"ambiente" "ambiente" NOT NULL,
	"nota_id" uuid,
	"descricao" text NOT NULL,
	"cliente" text NOT NULL,
	"valor" bigint NOT NULL,
	"venc" date NOT NULL,
	"recebido_em" date,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"usuario_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"expira_em" timestamp with time zone NOT NULL,
	"ultimo_uso" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "tentativas_login" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"ip" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usuarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"empresa_id" uuid NOT NULL,
	"nome" text NOT NULL,
	"email" text NOT NULL,
	"perfil" "perfil" NOT NULL,
	"senha_hash" text NOT NULL,
	"foto" "bytea",
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"ultimo_login" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "auditoria" ADD CONSTRAINT "auditoria_empresa_id_empresa_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auditoria" ADD CONSTRAINT "auditoria_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificados" ADD CONSTRAINT "certificados_empresa_id_empresa_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificados" ADD CONSTRAINT "certificados_enviado_por_usuarios_id_fk" FOREIGN KEY ("enviado_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dps_sequencia" ADD CONSTRAINT "dps_sequencia_empresa_id_empresa_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotes" ADD CONSTRAINT "lotes_empresa_id_empresa_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotes" ADD CONSTRAINT "lotes_criado_por_usuarios_id_fk" FOREIGN KEY ("criado_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nota_documentos" ADD CONSTRAINT "nota_documentos_nota_id_notas_id_fk" FOREIGN KEY ("nota_id") REFERENCES "public"."notas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notas" ADD CONSTRAINT "notas_empresa_id_empresa_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notas" ADD CONSTRAINT "notas_lote_id_lotes_id_fk" FOREIGN KEY ("lote_id") REFERENCES "public"."lotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pagar" ADD CONSTRAINT "pagar_empresa_id_empresa_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receber" ADD CONSTRAINT "receber_empresa_id_empresa_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receber" ADD CONSTRAINT "receber_nota_id_notas_id_fk" FOREIGN KEY ("nota_id") REFERENCES "public"."notas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessoes" ADD CONSTRAINT "sessoes_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_empresa_id_empresa_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auditoria_em_ix" ON "auditoria" USING btree ("criado_em");--> statement-breakpoint
CREATE UNIQUE INDEX "certificados_ativo_uq" ON "certificados" USING btree ("empresa_id") WHERE "certificados"."ativo";--> statement-breakpoint
CREATE INDEX "nota_documentos_nota_ix" ON "nota_documentos" USING btree ("nota_id","criado_em");--> statement-breakpoint
CREATE UNIQUE INDEX "notas_id_dps_uq" ON "notas" USING btree ("ambiente","id_dps");--> statement-breakpoint
CREATE UNIQUE INDEX "notas_ndps_uq" ON "notas" USING btree ("empresa_id","ambiente","serie","n_dps");--> statement-breakpoint
CREATE UNIQUE INDEX "notas_chave_uq" ON "notas" USING btree ("chave_acesso");--> statement-breakpoint
CREATE INDEX "notas_competencia_ix" ON "notas" USING btree ("empresa_id","ambiente","competencia");--> statement-breakpoint
CREATE INDEX "notas_lote_ix" ON "notas" USING btree ("lote_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "pagar_origem_uq" ON "pagar" USING btree ("origem_id");--> statement-breakpoint
CREATE INDEX "pagar_venc_ix" ON "pagar" USING btree ("empresa_id","venc");--> statement-breakpoint
CREATE UNIQUE INDEX "receber_nota_uq" ON "receber" USING btree ("nota_id");--> statement-breakpoint
CREATE INDEX "receber_venc_ix" ON "receber" USING btree ("empresa_id","ambiente","venc");--> statement-breakpoint
CREATE UNIQUE INDEX "sessoes_token_uq" ON "sessoes" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessoes_usuario_ix" ON "sessoes" USING btree ("usuario_id");--> statement-breakpoint
CREATE INDEX "tentativas_email_ix" ON "tentativas_login" USING btree ("email","criado_em");--> statement-breakpoint
CREATE INDEX "tentativas_ip_ix" ON "tentativas_login" USING btree ("ip","criado_em");--> statement-breakpoint
CREATE UNIQUE INDEX "usuarios_email_uq" ON "usuarios" USING btree (lower("email"));