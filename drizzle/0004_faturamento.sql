CREATE TYPE "public"."envio_status" AS ENUM('pendente', 'enviado', 'erro');--> statement-breakpoint
CREATE TABLE "envios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"empresa_id" uuid NOT NULL,
	"nota_id" uuid NOT NULL,
	"para" text NOT NULL,
	"status" "envio_status" DEFAULT 'pendente' NOT NULL,
	"tentativas" integer DEFAULT 0 NOT NULL,
	"proxima_tentativa_em" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_ate" timestamp with time zone,
	"ultimo_erro" text,
	"enviado_em" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "faturas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"empresa_id" uuid NOT NULL,
	"ambiente" "ambiente" NOT NULL,
	"cliente_id" uuid NOT NULL,
	"mes" text NOT NULL,
	"nota_id" uuid NOT NULL,
	"mensalidade" bigint NOT NULL,
	"extras" bigint NOT NULL,
	"automatica" boolean NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "empresa" ADD COLUMN "dia_emissao" smallint;--> statement-breakpoint
ALTER TABLE "empresa" ADD COLUMN "faturamento_desde" date;--> statement-breakpoint
ALTER TABLE "empresa" ADD COLUMN "enviar_email" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "visita_itens" ADD COLUMN "nota_id" uuid;--> statement-breakpoint
ALTER TABLE "envios" ADD CONSTRAINT "envios_empresa_id_empresa_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envios" ADD CONSTRAINT "envios_nota_id_notas_id_fk" FOREIGN KEY ("nota_id") REFERENCES "public"."notas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faturas" ADD CONSTRAINT "faturas_empresa_id_empresa_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faturas" ADD CONSTRAINT "faturas_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."clientes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faturas" ADD CONSTRAINT "faturas_nota_id_notas_id_fk" FOREIGN KEY ("nota_id") REFERENCES "public"."notas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "envios_nota_uq" ON "envios" USING btree ("nota_id");--> statement-breakpoint
CREATE INDEX "envios_fila_ix" ON "envios" USING btree ("status","proxima_tentativa_em");--> statement-breakpoint
CREATE UNIQUE INDEX "faturas_mes_uq" ON "faturas" USING btree ("ambiente","cliente_id","mes");--> statement-breakpoint
CREATE INDEX "faturas_empresa_ix" ON "faturas" USING btree ("empresa_id","ambiente","mes");--> statement-breakpoint
ALTER TABLE "visita_itens" ADD CONSTRAINT "visita_itens_nota_id_notas_id_fk" FOREIGN KEY ("nota_id") REFERENCES "public"."notas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "visita_itens_nota_ix" ON "visita_itens" USING btree ("nota_id");