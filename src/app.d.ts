import type { RoleAccess } from '$lib/server/permissions.js';
import type { LeafPermission } from '$lib/permissions/catalog.js';

declare global {
	namespace App {
		interface Locals {
			oauth?: { clientId: string; grantId: string; resource: string; scopes: import('$lib/server/oauth/config.js').OAuthScope[] };
			user: { id: number; email: string; username: string; name: string | null; role: string } | null;
			/**
			 * What this request may do: the role, or — through a token or an app —
			 * role ∩ delegation ceiling ∩ the credential's own permissions. Asked
			 * with `can(locals, "x.y")`, never read for a superuser flag.
			 */
			permissions: ReadonlySet<LeafPermission> | null;
			/** The user's own role, for screens that offer what could be delegated. */
			role?: RoleAccess | null;
			/** Set when the request carries a personal access token or an OAuth token. */
			credential?: { kind: 'pat'; tokenId: number } | { kind: 'oauth'; grantId: string; clientId: string };
		}
		// `PageState.viaPush` was here. Detail views were drawers opened with
		// shallow routing, and it recorded whether the drawer had pushed the
		// history entry it would later pop. Detail views are pages now, so the
		// navigation is real and the browser keeps the entry itself.
		interface PageState {}
	}
}

declare module 'svelte/elements' {
	interface SvelteWindowAttributes {
		'onfilter-dropdown-open'?: (e: CustomEvent) => void;
	}
}

export {};
