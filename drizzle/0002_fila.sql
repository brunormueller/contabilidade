ALTER TABLE "lotes" ADD COLUMN "chave_idem" text NOT NULL;--> statement-breakpoint
ALTER TABLE "lotes" ADD COLUMN "hash_linhas" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "lotes_idem_uq" ON "lotes" USING btree ("empresa_id","chave_idem");--> statement-breakpoint
CREATE INDEX "notas_fila_ix" ON "notas" USING btree ("ambiente","status","proxima_tentativa_em");