ALTER TABLE `mock_sessions` ADD `paper_id` integer DEFAULT 0 NOT NULL REFERENCES papers(id) ON UPDATE no action ON DELETE restrict;--> statement-breakpoint
ALTER TABLE `mock_sessions` ADD `question_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `mock_sessions` ADD `total_minutes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `mock_sessions` ADD `elapsed_ms` integer DEFAULT 0 NOT NULL;