import { can } from '$lib/server/permissions.js';
import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/client.js';
import { llmProviders } from '$lib/server/db/schema.js';
import { listChatgptModels } from '$lib/server/llm/chatgpt-oauth.js';
import { createTokenSource, dbCredentialStore } from '$lib/server/llm/chatgpt-tokens.js';
import type { RequestHandler } from './$types.js';

interface ModelInfo {
	id: string;
	name: string;
	isFree: boolean;
}

export const GET: RequestHandler = async ({ params, locals, fetch }) => {
	if (!locals.user) return new Response('Unauthorized', { status: 401 });
	if (!can(locals, 'settings.manage')) return new Response('Forbidden', { status: 403 });

	const provider = db.select().from(llmProviders).where(eq(llmProviders.id, params.id)).get();
	if (!provider) return new Response('Not found', { status: 404 });

	if (provider.type === 'chatgpt') {
		// Signed in, not keyed: the token comes from the stored sign-in, and is
		// refreshed first if it has run out.
		try {
			const source = createTokenSource(provider.id, dbCredentialStore);
			const token = await source.token();
			const models = await listChatgptModels(token, fetch, await source.accountId());
			return json({ models: models.map((m) => ({ ...m, isFree: false })) });
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'Failed to fetch models';
			return json({ error: msg }, { status: 502 });
		}
	}

	if (!provider.apiKey) return json({ models: [] });

	try {
		const models = await fetchModels(provider.type, provider.apiKey, provider.baseUrl, fetch);
		return json({ models });
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Failed to fetch models';
		return json({ error: msg }, { status: 502 });
	}
};

async function fetchModels(
	type: string,
	apiKey: string,
	baseUrl: string | null,
	fetch: typeof globalThis.fetch
): Promise<ModelInfo[]> {
	if (type === 'google_ai_studio') {
		const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
			headers: { 'x-goog-api-key': apiKey }
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		const raw: { name: string; displayName: string; supportedGenerationMethods: string[] }[] =
			data.models ?? [];
		return raw
			.filter((m) => m.supportedGenerationMethods.includes('generateContent'))
			.map((m) => ({ id: m.name.replace('models/', ''), name: m.displayName, isFree: false }))
			.sort((a, b) => a.name.localeCompare(b.name));
	} else if (type === 'groq') {
		const res = await fetch('https://api.groq.com/openai/v1/models', {
			headers: { Authorization: `Bearer ${apiKey}` }
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		const raw: { id: string }[] = data.data ?? [];
		return raw
			.map((m) => ({ id: m.id, name: m.id, isFree: false }))
			.sort((a, b) => a.name.localeCompare(b.name));
	} else {
		// openrouter (and any future OpenAI-compatible provider with a baseUrl)
		const base = baseUrl ?? 'https://openrouter.ai/api/v1';
		const res = await fetch(`${base}/models`, {
			headers: { Authorization: `Bearer ${apiKey}` }
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		const raw: { id: string; name: string; pricing?: { prompt?: string } }[] = data.data ?? [];
		return raw
			.map((m) => ({
				id: m.id,
				name: m.name,
				isFree: parseFloat(m.pricing?.prompt ?? '1') === 0
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	}
}
