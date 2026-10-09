ALTER TABLE `question_groups` ADD `source_key` text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `question_groups_module_source_key_uq` ON `question_groups` (`module_id`,`source_key`);