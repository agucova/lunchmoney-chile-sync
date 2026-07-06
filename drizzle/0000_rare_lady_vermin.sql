CREATE TABLE `account_state` (
	`account_id` text PRIMARY KEY NOT NULL,
	`last_pushed_balance_minor` text,
	`last_pushed_balance_currency` text,
	`last_pushed_balance_at` text
);
--> statement-breakpoint
CREATE TABLE `ops_journal` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`op` text NOT NULL,
	`applied_at` text,
	`result` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_journal_run_seq` ON `ops_journal` (`run_id`,`seq`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`connection_id` text NOT NULL,
	`source` text NOT NULL,
	`outcome` text,
	`error` text,
	`stats` text
);
--> statement-breakpoint
CREATE TABLE `txn_identities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` text NOT NULL,
	`external_id` text NOT NULL,
	`bucket_hash` text NOT NULL,
	`occurrence` integer NOT NULL,
	`date` text NOT NULL,
	`amount_minor` text NOT NULL,
	`currency` text NOT NULL,
	`norm_desc` text NOT NULL,
	`raw_desc` text NOT NULL,
	`desc_variants` text DEFAULT '[]' NOT NULL,
	`norm_version` integer NOT NULL,
	`status` text NOT NULL,
	`installments` text,
	`orig_currency` text,
	`orig_amount_minor` text,
	`lm_txn_id` integer,
	`flagged` text,
	`first_seen_run` integer NOT NULL,
	`last_seen_run` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`first_seen_run`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`last_seen_run`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_identities_bucket` ON `txn_identities` (`account_id`,`date`,`amount_minor`,`currency`);--> statement-breakpoint
CREATE INDEX `idx_identities_bucket_hash` ON `txn_identities` (`account_id`,`bucket_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_identities_account_external` ON `txn_identities` (`account_id`,`external_id`);