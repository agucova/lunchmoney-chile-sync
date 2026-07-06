CREATE TABLE `connection_secrets` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`refresh_token` text NOT NULL,
	`access_token` text,
	`access_token_expires_at` text,
	`seed_fingerprint` text,
	`updated_at` text NOT NULL
);
