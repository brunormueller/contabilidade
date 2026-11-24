CREATE TYPE "public"."visita_status" AS ENUM('pendente', 'em_atendimento', 'concluida', 'nao_realizada');--> statement-breakpoint
ALTER TYPE "public"."perfil" ADD VALUE 'funcionario';--> statement-breakpoint
CREATE TABLE "clientes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"empresa_id" uuid NOT NULL,
	"doc" text NOT NULL,
	"nome" text NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"telefone" text DEFAULT '' NOT NULL,
	"endereco" text DEFAULT '' NOT NULL,
	"plano_id" uuid,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "planos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"empresa_id" uuid NOT NULL,
	"nome" text NOT NULL,
	"descricao" text DEFAULT '' NOT NULL,
	"valor" bigint NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rota_paradas" (
	"rota_id" uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"ordem" integer NOT NULL,
	CONSTRAINT "rota_paradas_rota_id_cliente_id_pk" PRIMARY KEY("rota_id","cliente_id")
);
--> statement-breakpoint
CREATE TABLE "rotas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"empresa_id" uuid NOT NULL,
	"nome" text NOT NULL,
	"funcionario_id" uuid NOT NULL,
	"dias" smallint[] NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "servicos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"empresa_id" uuid NOT NULL,
	"nome" text NOT NULL,
	"valor" bigint NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visita_itens" (
	"visita_id" uuid NOT NULL,
	"servico_id" uuid NOT NULL,
	"nome" text NOT NULL,
	"valor" bigint NOT NULL,
	CONSTRAINT "visita_itens_visita_id_servico_id_pk" PRIMARY KEY("visita_id","servico_id")
);
--> statement-breakpoint
CREATE TABLE "visitas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"empresa_id" uuid NOT NULL,
	"rota_id" uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"funcionario_id" uuid NOT NULL,
	"data" date NOT NULL,
	"ordem" integer NOT NULL,
	"status" "visita_status" DEFAULT 'pendente' NOT NULL,
	"chegada_em" timestamp with time zone,
	"chegada_gps" jsonb,
	"fim_em" timestamp with time zone,
	"fim_gps" jsonb,
	"obs" text DEFAULT '' NOT NULL,
	"motivo" text DEFAULT '' NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clientes" ADD CONSTRAINT "clientes_empresa_id_empresa_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clientes" ADD CONSTRAINT "clientes_plano_id_planos_id_fk" FOREIGN KEY ("plano_id") REFERENCES "public"."planos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planos" ADD CONSTRAINT "planos_empresa_id_empresa_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rota_paradas" ADD CONSTRAINT "rota_paradas_rota_id_rotas_id_fk" FOREIGN KEY ("rota_id") REFERENCES "public"."rotas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rota_paradas" ADD CONSTRAINT "rota_paradas_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."clientes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotas" ADD CONSTRAINT "rotas_empresa_id_empresa_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotas" ADD CONSTRAINT "rotas_funcionario_id_usuarios_id_fk" FOREIGN KEY ("funcionario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servicos" ADD CONSTRAINT "servicos_empresa_id_empresa_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visita_itens" ADD CONSTRAINT "visita_itens_visita_id_visitas_id_fk" FOREIGN KEY ("visita_id") REFERENCES "public"."visitas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visita_itens" ADD CONSTRAINT "visita_itens_servico_id_servicos_id_fk" FOREIGN KEY ("servico_id") REFERENCES "public"."servicos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitas" ADD CONSTRAINT "visitas_empresa_id_empresa_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitas" ADD CONSTRAINT "visitas_rota_id_rotas_id_fk" FOREIGN KEY ("rota_id") REFERENCES "public"."rotas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitas" ADD CONSTRAINT "visitas_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."clientes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitas" ADD CONSTRAINT "visitas_funcionario_id_usuarios_id_fk" FOREIGN KEY ("funcionario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clientes_empresa_ix" ON "clientes" USING btree ("empresa_id","ativo");--> statement-breakpoint
CREATE INDEX "planos_empresa_ix" ON "planos" USING btree ("empresa_id");--> statement-breakpoint
CREATE INDEX "rotas_empresa_ix" ON "rotas" USING btree ("empresa_id","ativo");--> statement-breakpoint
CREATE INDEX "servicos_empresa_ix" ON "servicos" USING btree ("empresa_id");--> statement-breakpoint
CREATE UNIQUE INDEX "visitas_dia_uq" ON "visitas" USING btree ("rota_id","cliente_id","data");--> statement-breakpoint
CREATE INDEX "visitas_empresa_ix" ON "visitas" USING btree ("empresa_id","data");--> statement-breakpoint
CREATE INDEX "visitas_funcionario_ix" ON "visitas" USING btree ("funcionario_id","data");