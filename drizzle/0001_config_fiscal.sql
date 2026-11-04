ALTER TABLE "empresa" ADD COLUMN "p_tot_trib_sn" integer;--> statement-breakpoint
ALTER TABLE "empresa" ADD COLUMN "c_loc_prestacao" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "empresa" ADD COLUMN "ibs_cbs" jsonb;