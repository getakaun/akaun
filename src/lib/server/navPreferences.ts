import { eq } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import * as schema from './db/schema.js';
import { userNavPreferences } from './db/schema.js';
import {
	DEFAULT_MOBILE_VISIBLE_IDS,
	DEFAULT_NAV_ITEMS,
	MAX_MOBILE_NAV_ITEMS,
	type NavItem,
	type SerializableNavItem
} from '$lib/nav-config.js';

type Db = BunSQLiteDatabase<typeof schema>;

export type OrderedNavItem = SerializableNavItem & { showOnMobile: boolean };

export function getUserNavOrder(db: Db, userId: number): OrderedNavItem[] {
	const rows = db
		.select()
		.from(userNavPreferences)
		.where(eq(userNavPreferences.userId, userId))
		.orderBy(userNavPreferences.sortOrder)
		.all();

	const saved = new Map(rows.map((r) => [r.itemId, r]));
	const known = new Set(DEFAULT_NAV_ITEMS.map((i) => i.id));

	function toOrderedItem(item: NavItem, showOnMobile: boolean): OrderedNavItem {
		return { id: item.id, label: item.label, href: item.href, permission: item.permission, showOnMobile };
	}

	const ordered: OrderedNavItem[] = [];
	for (const row of rows) {
		if (!known.has(row.itemId)) continue;
		const item = DEFAULT_NAV_ITEMS.find((i) => i.id === row.itemId)!;
		ordered.push(toOrderedItem(item, row.showOnMobile));
	}
	for (const item of DEFAULT_NAV_ITEMS) {
		if (!saved.has(item.id)) ordered.push(toOrderedItem(item, DEFAULT_MOBILE_VISIBLE_IDS.has(item.id)));
	}

	return ordered;
}

export function setUserNavOrder(
	db: Db,
	userId: number,
	items: { itemId: string; showOnMobile: boolean }[]
): void {
	const known = new Set(DEFAULT_NAV_ITEMS.map((i) => i.id));
	const validItems = items.filter((i) => known.has(i.itemId));

	const mobileCount = validItems.filter((i) => i.showOnMobile).length;
	if (mobileCount > MAX_MOBILE_NAV_ITEMS) {
		throw new Error(`At most ${MAX_MOBILE_NAV_ITEMS} items can be shown on mobile.`);
	}

	db.transaction((tx) => {
		tx.delete(userNavPreferences).where(eq(userNavPreferences.userId, userId)).run();
		validItems.forEach((item, index) => {
			tx.insert(userNavPreferences)
				.values({
					userId,
					itemId: item.itemId,
					sortOrder: index,
					showOnMobile: item.showOnMobile
				})
				.run();
		});
	});
}
