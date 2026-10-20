import { isLeafPermission, leafMeta } from '$lib/permissions/catalog.js';
import {
	AccountRoleDisplayLabels,
	AccountSubTypeDisplayLabels,
	AccountTypeDisplayLabels,
	DefaultAccountPurposeDisplayLabels,
	DocumentTypeDisplayLabels,
	EntityTypeLabels,
	InvoiceStatusDisplayLabels,
	LedgerRecordKindDisplayLabels,
	QuotationStatusDisplayLabels,
	RoleLabels,
	StatementDirectionDisplayLabels,
	StatementExtractionStateDisplayLabels
} from '$lib/enums.js';
import { ImportMode, importModeLabel } from '$lib/import-reading.js';
import { LAYOUT_CATALOG } from '$lib/pdf/layout-catalog.js';
import { PROVIDER_LABELS } from '$lib/llm-provider-labels.js';

/**
 * How the audit log reads, on the Audit Log page and on each record's Activity.
 *
 * The server stores what changed as plain values (`FieldChange`); this turns
 * them into something a person reads — a field name in words, a sum in money,
 * a list of permissions as what was added and taken away. Nothing here
 * decides anything, so nothing here mirrors a server rule.
 */

export type AuditVia = 'session' | 'pat' | 'oauth' | 'system';
export type AuditChange = { field: string; before: unknown; after: unknown };

export const RECORD_TYPE_LABELS: Record<string, string> = {
	record: 'Record',
	account: 'Account',
	contact: 'Contact',
	invoice: 'Invoice',
	quotation: 'Quotation',
	settlement: 'Settlement',
	reconciliation: 'Bank statement',
	import_profile: 'Import profile',
	import_job: 'Import',
	user: 'User',
	group: 'Group',
	access_token: 'Access token',
	oauth_grant: 'Connected app',
	settings: 'Settings',
	llm_provider: 'AI provider'
};

export const VIA_LABELS: Record<AuditVia, string> = {
	session: 'Signed in',
	pat: 'Access token',
	oauth: 'Connected app',
	system: 'System'
};

export const ACTION_LABELS: Record<string, string> = {
	create: 'Created',
	update: 'Changed',
	delete: 'Deleted'
};

type ChannelEntry = {
	via: AuditVia;
	credentialLabel: string | null;
};

/** "via token “CI”", "via Claude (app)", "" for the browser. */
export function channelLabel(entry: ChannelEntry): string {
	if (entry.via === 'pat') return `via token “${entry.credentialLabel ?? 'deleted token'}”`;
	if (entry.via === 'oauth') return `via ${entry.credentialLabel ?? 'a connected app'} (app)`;
	return '';
}

/** Who did it, as one line: "Alice", "Alice via token “CI”", "System". */
export function actorLine(entry: ChannelEntry & { actorName: string | null }): string {
	if (entry.via === 'system' && !entry.actorName) return 'System';
	const who = entry.actorName ?? 'A deleted user';
	if (entry.via === 'system') return `System, for ${who}`;
	const channel = channelLabel(entry);
	return channel ? `${who} ${channel}` : who;
}

/** True when a token or an app made the change: the rows to look at first. */
export function isAgent(entry: { via: AuditVia }): boolean {
	return entry.via === 'pat' || entry.via === 'oauth';
}

type NameMap = Record<number | string, string>;

const LAYOUT_LABELS: NameMap = Object.fromEntries(LAYOUT_CATALOG.map((l) => [l.key, l.label]));
const IMPORT_MODE_LABELS: NameMap = Object.fromEntries(
	Object.values(ImportMode).map((mode) => [mode, importModeLabel(mode)])
);

/**
 * Which fields hold a code, per kind of record, and the map that names it.
 * The log stores the code itself, so an entry stays exact if a name is
 * reworded; it is named here, when it is read. The type is part of the key
 * because one field name means different things: `status` 3 is Paid on an
 * invoice and Accepted on a quotation.
 *
 * Every map is a display map from `$lib/enums.ts` (or one of the named
 * text-code maps above) — never a private copy. A newly audited code column
 * needs its line here.
 */
export const ENUM_FIELDS: Record<string, Record<string, NameMap>> = {
	quotation: { status: QuotationStatusDisplayLabels },
	invoice: { status: InvoiceStatusDisplayLabels },
	record: { kind: LedgerRecordKindDisplayLabels },
	account: {
		role: AccountRoleDisplayLabels,
		type: AccountTypeDisplayLabels,
		subType: AccountSubTypeDisplayLabels
	},
	contact: {
		entityType: EntityTypeLabels,
		roles: RoleLabels
	},
	reconciliation: {
		extractionState: StatementExtractionStateDisplayLabels,
		direction: StatementDirectionDisplayLabels
	},
	import_job: { documentType: DocumentTypeDisplayLabels },
	import_profile: { mode: IMPORT_MODE_LABELS },
	llm_provider: { type: PROVIDER_LABELS },
	settings: {
		'pdf.invoiceLayoutKey': LAYOUT_LABELS,
		'pdf.quotationLayoutKey': LAYOUT_LABELS
	}
};

/**
 * The map naming a field's codes, if it has one. `item 3.documentType` is
 * matched by its last part, so an import item's fields are named too.
 */
function enumFor(recordType: string, field: string): NameMap | null {
	const fields = ENUM_FIELDS[recordType];
	if (!fields) return null;
	const map = fields[field] ?? fields[field.replace(/^item \d+\./, '')];
	return map && Object.keys(map).length ? map : null;
}

function nameOf(map: NameMap, value: unknown): string {
	return map[value as number | string] ?? String(value);
}

// Fields whose names do not read well when split.
const FIELD_LABELS: Record<string, string> = {
	dateCorrectionReason: 'Date correction reason',
	amountMinor: 'Amount',
	contactId: 'Contact',
	accountId: 'Account',
	counterAccountId: 'Contra account',
	categoryAccountId: 'Category',
	groupAccountId: 'Source account',
	ownerId: 'Owner',
	clientId: 'App',
	expiresOn: 'Expires',
	lastFour: 'Token ends in',
	isSuperuser: 'Superuser',
	baseUrl: 'Base URL',
	apiKey: 'API key',
	oauthCredentials: 'Sign-in',
	readAs: 'Read as',
	readAgain: 'Read again',
	originalFilename: 'File',
	passwordHash: 'Password'
};

/** `legalName` → "Legal name"; `item 3.amount` → "Item 3 · amount". */
export function fieldLabel(field: string): string {
	// An account default's purpose is part of the field's name.
	const purpose = /^savedDefault:(\d+)$/.exec(field);
	if (purpose)
		return `Default account: ${DefaultAccountPurposeDisplayLabels[Number(purpose[1])] ?? purpose[1]}`;
	const item = /^item (\d+)(?:\.(.+))?$/.exec(field);
	if (item) return item[2] ? `Item ${item[1]} · ${fieldLabel(item[2]).toLowerCase()}` : `Item ${item[1]}`;
	if (FIELD_LABELS[field]) return FIELD_LABELS[field];
	// Setting keys: `company.name` → "Company name".
	const words = field
		.replace(/[._:]+/g, ' ')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.trim()
		.toLowerCase();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

// Lists that are best read as what was added and what was taken away.
const SET_FIELDS = new Set(['grants', 'delegations', 'permissions', 'scopes', 'groups', 'roles']);

function permissionLabel(value: string): string {
	if (!isLeafPermission(value)) return value;
	const meta = leafMeta(value);
	return `${meta.rootLabel}: ${meta.label}`;
}

/**
 * One value as text. A coded field is named from its enum; money fields are
 * whole cents. An unknown code shows as itself, so nothing is hidden.
 */
export function formatValue(recordType: string, field: string, value: unknown): string {
	if (value === null || value === undefined || value === '') return '—';
	const names = enumFor(recordType, field);
	if (names) {
		if (Array.isArray(value)) return value.map((v) => nameOf(names, v)).join(', ') || '—';
		if (typeof value === 'number' || typeof value === 'string') return nameOf(names, value);
	}
	if (typeof value === 'boolean') return value ? 'Yes' : 'No';
	if (typeof value === 'number' && /Minor$/.test(field))
		return (value / 100).toLocaleString(undefined, {
			minimumFractionDigits: 2,
			maximumFractionDigits: 2
		});
	if (Array.isArray(value)) {
		if (value.every((v) => typeof v === 'string' || typeof v === 'number'))
			return value.map((v) => permissionLabel(String(v))).join(', ') || '—';
		return `${value.length} item${value.length === 1 ? '' : 's'}`;
	}
	if (typeof value === 'object') {
		const text = JSON.stringify(value);
		return text.length > 120 ? `${text.slice(0, 117)}…` : text;
	}
	return String(value);
}

export type ChangeView = {
	label: string;
	before: string;
	after: string;
	/** For a list read as a set: what it gained and lost. */
	added?: string[];
	removed?: string[];
};

export function describeChange(recordType: string, change: AuditChange): ChangeView {
	const view: ChangeView = {
		label: fieldLabel(change.field),
		before: formatValue(recordType, change.field, change.before),
		after: formatValue(recordType, change.field, change.after)
	};
	const asSet = (value: unknown) =>
		Array.isArray(value) ? value.map(String) : value == null ? [] : null;
	if (SET_FIELDS.has(change.field)) {
		const before = asSet(change.before);
		const after = asSet(change.after);
		if (before && after) {
			// A set of codes (a contact's roles) is named from its enum; any
			// other set is permissions.
			const names = enumFor(recordType, change.field);
			const name = names ? (v: string) => nameOf(names, v) : permissionLabel;
			view.added = after.filter((v) => !before.includes(v)).map(name);
			view.removed = before.filter((v) => !after.includes(v)).map(name);
		}
	}
	return view;
}

/** One line for an entry's changes, for a list row or the Activity trail. */
export function changesSummary(
	recordType: string,
	action: string,
	changes: AuditChange[] | null,
	max = 3
): string {
	if (action === 'create') return 'created';
	if (action === 'delete') return 'deleted';
	if (!changes?.length) return 'changed';
	const shown = changes.slice(0, max).map((change) => {
		const view = describeChange(recordType, change);
		if (view.added || view.removed) {
			const parts = [
				...(view.added ?? []).map((v) => `+${v}`),
				...(view.removed ?? []).map((v) => `−${v}`)
			];
			return `${view.label}: ${parts.join(', ') || 'reordered'}`;
		}
		return `${view.label} ${view.before} → ${view.after}`;
	});
	const more = changes.length - shown.length;
	return shown.join('; ') + (more > 0 ? `; and ${more} more` : '');
}

/** `created_at` is UTC `YYYY-MM-DD HH:MM:SS`; shown in the viewer's time. */
export function auditTime(createdAt: string): Date {
	return new Date(`${createdAt.replace(' ', 'T')}Z`);
}

export function formatAuditTime(createdAt: string): string {
	return auditTime(createdAt).toLocaleString(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short'
	});
}
