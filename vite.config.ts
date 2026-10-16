import fs from 'node:fs';
import { execSync } from 'node:child_process';
import basicSsl from '@vitejs/plugin-basic-ssl';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { VitePWA } from 'vite-plugin-pwa';

// Lets `bun run dev`/`preview` serve HTTPS locally using the same env vars as production.
// SSL_KEY_PATH/SSL_CERT_PATH are optional in dev — when omitted, basicSsl() generates and
// caches a self-signed cert automatically (browsers will show an untrusted-cert warning).
const sslEnabled = process.env.SSL_ENABLED === 'true';
const hasCustomCert = !!(process.env.SSL_KEY_PATH && process.env.SSL_CERT_PATH);
const httpsOptions = hasCustomCert
	? {
			key: fs.readFileSync(process.env.SSL_KEY_PATH!),
			cert: fs.readFileSync(process.env.SSL_CERT_PATH!)
		}
	: undefined;

// The version the UI shows, handed to SvelteKit as kit.version.name below. Git is the source of
// truth: `describe` gives the tag on a tagged build, the upstream tag plus its distance on a local
// build past it, and appends -dirty when a file is uncommitted. AKAUN_VERSION wins so a build with
// no .git can still be stamped — the Docker build dockerignores .git and the bun-alpine image has
// no git binary, so CI computes this on the runner and passes it in.
function resolveAppVersion(): string {
	if (process.env.AKAUN_VERSION) return process.env.AKAUN_VERSION;
	try {
		return execSync('git describe --tags --always --dirty', {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'] // swallow git's stderr when there is no repo
		}).trim();
	} catch {
		return 'unknown';
	}
}
const appVersion = resolveAppVersion();

export default defineConfig({
	plugins: [
		sslEnabled && !hasCustomCert ? basicSsl() : null,
		tailwindcss(),
		VitePWA({
			registerType: 'autoUpdate',
			strategies: 'generateSW',
			manifest: false,
			workbox: {
				globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
				// opencv.js (~9 MB) exceeds the 2 MiB precache limit; it's runtime-cached
				// via the CacheFirst rule below instead of precached.
				globIgnores: ['**/opencv.js'],
				navigateFallback: null,
				runtimeCaching: [
					{
						urlPattern: /^\/api\//,
						handler: 'NetworkFirst',
						options: { cacheName: 'api-cache', networkTimeoutSeconds: 3 }
					},
					{
						// opencv.js (~9 MB) is too large to precache (exceeds workbox's 2 MB
						// limit), so cache it at runtime: fetched once, then served from cache
						// on every later scanner open and offline.
						urlPattern: ({ url }) => url.pathname === '/opencv.js',
						handler: 'CacheFirst',
						options: {
							cacheName: 'opencv',
							expiration: { maxEntries: 1, maxAgeSeconds: 60 * 60 * 24 * 365 },
							cacheableResponse: { statuses: [0, 200] }
						}
					}
				]
			}
		}),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// SvelteKit's built-in Origin check has no knowledge of our Bearer-token auth and
			// would block third-party API-token requests with non-JSON bodies (e.g. file uploads).
			// hooks.server.ts implements the real CSRF check, scoped to cookie-session requests only.
			csrf: { trustedOrigins: ['*'] },

			// Surfaces as `version` from $app/environment, which $lib/version.ts formats for the
			// sidebar. Default is Date.now(); a git-derived name is what makes it meaningful.
			version: { name: appVersion },

			adapter: adapter()
		})
	],
	// Pre-transform all Svelte files at startup so Vite discovers transitive deps
	// (icons from income/claims/etc.) before the first browser request.
	server: {
		https: httpsOptions,
		warmup: {
			clientFiles: ['./src/routes/**/*.svelte', './src/lib/components/**/*.svelte']
		}
	},
	preview: {
		https: httpsOptions
	},
	optimizeDeps: {
		include: [
			// Root layout — loaded on every page
			'mode-watcher',
			'svelte-sonner',
			'@lucide/svelte', // named icon imports

			// Icons imported via single subpath (`@lucide/svelte/icons/<name>`) instead of the
			// named barrel import above. List only the icons actually used — regenerate with:
			//   grep -rhoE "@lucide/svelte/icons/[a-z0-9-]+" src/ | sort -u
			// Do NOT go back to the `@lucide/svelte/icons/*` glob: it pre-bundles all ~1700 icons
			// in the package regardless of usage, needlessly bloating cold start and the
			// optimizer's tracked-dep surface. Add a line here when a component starts importing
			// a new icon by subpath.
			'@lucide/svelte/icons/calendar',
			'@lucide/svelte/icons/check',
			'@lucide/svelte/icons/chevron-down',
			'@lucide/svelte/icons/chevron-left',
			'@lucide/svelte/icons/chevron-right',
			'@lucide/svelte/icons/chevron-up',
			'@lucide/svelte/icons/circle-check',
			'@lucide/svelte/icons/info',
			'@lucide/svelte/icons/loader-2',
			'@lucide/svelte/icons/minus',
			'@lucide/svelte/icons/octagon-x',
			'@lucide/svelte/icons/scale',
			'@lucide/svelte/icons/triangle-alert',
			'@lucide/svelte/icons/x',

			// Expenses page — first post-login page
			'bits-ui',
			'@internationalized/date', // DatePicker transitive dep
			'tailwind-variants',

			// Utilities used across almost every component
			'tailwind-merge',
			'clsx',

			// Settings / profile pages — drag-and-drop reordering (nav prefs, custom fields).
			// Previously missing here; only discoverable live via server.warmup crawling those
			// pages, which forces an unrelated full-reload of any already-connected client.
			'@thisux/sveltednd',

			// Scanner feature — client-side PDF assembly from scanned pages
			// (src/lib/components/scanner/pdf-assembly.ts). Same missing-dep risk as above.
			'jspdf'
		]
	},
	// bun:sqlite is a Bun builtin; unpdf and tesseract.js skip Vite SSR transform
	// so the first request isn't interrupted by dep optimization.
	//
	// `noExternal: ['zod']` is there for the test runner. Vitest's `server`
	// project runs under Bun (see the `test:unit` script — the upgrade-conversion
	// spec needs `bun:sqlite` to test against a real temporary database, as the
	// constitution requires). Left external, zod resolves through Bun's CJS
	// interop to a namespace with no `z` on it, and every spec that imports a
	// schema dies with "undefined is not an object (evaluating 'z.object')".
	// Having Vite transform it instead fixes the interop and changes nothing
	// about the production build.
	ssr: {
		external: ['bun:sqlite', 'unpdf', 'tesseract.js', 'pngjs'],
		noExternal: ['zod']
	},
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'client',
					browser: {
						enabled: true,
						provider: playwright(),
						instances: [{ browser: 'chromium', headless: true }]
					},
					include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					exclude: ['src/lib/server/**']
				}
			},

			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}', 'scripts/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
