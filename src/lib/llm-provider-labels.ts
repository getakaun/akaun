/**
 * What each AI provider `type` is called on screen. Client-safe, so both the
 * Settings page and the audit log name a provider the same way.
 */
export const PROVIDER_LABELS: Record<string, string> = {
	openrouter: 'OpenRouter',
	google_ai_studio: 'Google AI Studio',
	groq: 'Groq',
	chatgpt: 'ChatGPT plan'
};
