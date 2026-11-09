CREATE TABLE "links" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "links_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint,
	"slug" text COLLATE "C" NOT NULL,
	"is_custom" boolean DEFAULT false NOT NULL,
	"destination" text NOT NULL,
	"title" text,
	"redirect_type" smallint DEFAULT 302 NOT NULL,
	"cache_ttl" integer DEFAULT 3600 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"max_clicks" integer,
	"password_hash" text,
	"forward_query" boolean DEFAULT true NOT NULL,
	"rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "links_redirect_type_check" CHECK ("links"."redirect_type" IN (301, 302, 307, 308)),
	CONSTRAINT "links_status_check" CHECK ("links"."status" IN ('active', 'disabled', 'blocked_loop')),
	CONSTRAINT "links_max_clicks_check" CHECK ("links"."max_clicks" > 0),
	CONSTRAINT "links_cache_ttl_check" CHECK ("links"."cache_ttl" >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "links_slug_key" ON "links" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "links_user_created_idx" ON "links" USING btree ("user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "links"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree (lower("email"));