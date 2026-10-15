-- Moves every group's and user's permissions from the view/add/change/delete
-- grid into permission strings from `src/lib/permissions/catalog.ts`.
--
-- The mapping is the same as `LEGACY_MAP` in
-- `src/lib/server/permissions/legacy-map.ts`; a spec keeps the two equal.
-- Each old flag becomes exactly the leaves it used to allow, so nobody gains
-- or loses anything:
--   view → read, add → create, change → update, delete → delete,
--   plus the abilities that used to hide behind a flag: import change also
--   confirms and manages profiles, contacts delete also merges, quotations
--   change also revises and converts, invoices change also sends and voids,
--   reconciliation change also matches.
-- `expenses` and `income` (merged into `records` at startup on books that
-- predate the merge) and `journal` (renamed `adjustments`) are mapped here
-- too, because that startup step no longer runs. `reports` was view-only by
-- rule, so its other flags map to nothing. Superuser groups are skipped: they
-- hold everything without grants.
--
-- Old rows are left in place, unread, for one release.

CREATE TEMP TABLE `permission_map` (`resource` text, `flag` text, `permission` text);
--> statement-breakpoint
INSERT INTO `permission_map` VALUES
  ('dashboard','view','dashboard.read'),
  ('records','view','records.read'),
  ('records','add','records.create'),
  ('records','change','records.update'),
  ('records','delete','records.delete'),
  ('expenses','view','records.read'),
  ('expenses','add','records.create'),
  ('expenses','change','records.update'),
  ('expenses','delete','records.delete'),
  ('income','view','records.read'),
  ('income','add','records.create'),
  ('income','change','records.update'),
  ('income','delete','records.delete'),
  ('adjustments','add','records.adjust'),
  ('adjustments','change','records.adjust'),
  ('adjustments','delete','records.adjust'),
  ('journal','add','records.adjust'),
  ('journal','change','records.adjust'),
  ('journal','delete','records.adjust'),
  ('import','view','import.read'),
  ('import','add','import.create'),
  ('import','change','import.update'),
  ('import','change','import.confirm'),
  ('import','change','import.profiles'),
  ('import','delete','import.delete'),
  ('contacts','view','contacts.read'),
  ('contacts','add','contacts.create'),
  ('contacts','change','contacts.update'),
  ('contacts','delete','contacts.delete'),
  ('contacts','delete','contacts.merge'),
  ('quotations','view','quotations.read'),
  ('quotations','add','quotations.create'),
  ('quotations','change','quotations.update'),
  ('quotations','change','quotations.revise'),
  ('quotations','change','quotations.convert'),
  ('quotations','delete','quotations.delete'),
  ('invoices','view','invoices.read'),
  ('invoices','add','invoices.create'),
  ('invoices','change','invoices.update'),
  ('invoices','change','invoices.issue'),
  ('invoices','change','invoices.void'),
  ('invoices','delete','invoices.delete'),
  ('reconciliation','view','reconciliation.read'),
  ('reconciliation','add','reconciliation.create'),
  ('reconciliation','change','reconciliation.update'),
  ('reconciliation','change','reconciliation.match'),
  ('reconciliation','delete','reconciliation.delete'),
  ('accounts','view','accounts.read'),
  ('accounts','add','accounts.create'),
  ('accounts','change','accounts.update'),
  ('accounts','delete','accounts.delete'),
  ('reports','view','reports.read');
--> statement-breakpoint
INSERT OR IGNORE INTO `group_grants` (`group_id`, `permission`)
SELECT gp.`group_id`, m.`permission`
FROM `group_permissions` gp
JOIN `groups` g ON g.`id` = gp.`group_id` AND g.`is_superuser` = 0
JOIN `permission_map` m ON m.`resource` = gp.`resource`
WHERE (m.`flag` = 'view' AND gp.`can_view` = 1)
   OR (m.`flag` = 'add' AND gp.`can_add` = 1)
   OR (m.`flag` = 'change' AND gp.`can_change` = 1)
   OR (m.`flag` = 'delete' AND gp.`can_delete` = 1);
--> statement-breakpoint
INSERT OR IGNORE INTO `user_grants` (`user_id`, `permission`)
SELECT up.`user_id`, m.`permission`
FROM `user_permissions` up
JOIN `permission_map` m ON m.`resource` = up.`resource`
WHERE (m.`flag` = 'view' AND up.`can_view` = 1)
   OR (m.`flag` = 'add' AND up.`can_add` = 1)
   OR (m.`flag` = 'change' AND up.`can_change` = 1)
   OR (m.`flag` = 'delete' AND up.`can_delete` = 1);
--> statement-breakpoint
-- The default delegation ceiling: what a group may hand on to tokens and apps
-- is everything it can do itself except the sensitive permissions. This keeps
-- what OAuth apps could already be granted; administrators narrow it per group.
INSERT OR IGNORE INTO `group_delegations` (`group_id`, `permission`)
SELECT `group_id`, `permission` FROM `group_grants`
WHERE `permission` NOT IN ('records.adjust', 'settings.manage');
--> statement-breakpoint
-- Settings had no permission at all, so everyone could see and change it.
-- Every existing group keeps seeing it; changing it is left to superusers
-- until an administrator grants settings.manage.
INSERT OR IGNORE INTO `group_grants` (`group_id`, `permission`)
SELECT `id`, 'settings.read' FROM `groups` WHERE `is_superuser` = 0;
--> statement-breakpoint
-- API tokens were one raw secret per user with that user's full access. They
-- are replaced by hashed, fine-grained personal access tokens and are revoked
-- here rather than converted: nothing about an old token says what it was for.
UPDATE `users` SET `bearer_token` = NULL;
--> statement-breakpoint
DROP TABLE `permission_map`;
