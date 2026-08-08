/**
 * web-fetch extension — Claude Code's WebFetch.
 *
 * Fetches a URL, extracts the readable content, and returns markdown. Deferred
 * behind `tool_search`. With a `prompt`, a small same-containment reader model
 * (chosen in summarize.ts, same one-shot `completeSimple` shape as the
 * auto-mode classifier) answers it against the *full* page, keeping long pages
 * out of the main conversation. A reader failure falls back to the raw
 * windowed markdown with a note saying so — the original reason this feature
 * was deferred was that a summariser failing *silently* degrades quality
 * invisibly, so the fallback is loud, never silent.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFER_CHANNEL } from "../lib/deferred.ts";
import { htmlToMarkdown, isSameHost, normalizeUrl, paginate } from "./extract.ts";
import { pickReaderModel, READER_MAX_TOKENS, readerMessages } from "./summarize.ts";
import { ccToolRenderers } from "../lib/tui-render.ts";

const DEFAULT_MAX_CHARS = 30_000;
const CACHE_TTL_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
/** Longer than the classifier's cap: the reader ingests whole pages. */
const READER_TIMEOUT_MS = 60_000;
const USER_AGENT = "pincer/0.1 (+https://github.com/earendil-works/pi)";

/**
 * Declared up front because pi infers a tool's `details` generic from the first
 * `return` it sees; an early `details: {}` would narrow every field to undefined.
 */
interface FetchDetails {
	url?: string;
	totalChars?: number;
	truncated?: boolean;
	nextOffset?: number;
	/** `provider/id` of the model that answered `prompt`, when one did. */
	reader?: string;
}

interface CacheEntry {
	markdown: string;
	title?: string;
	fetchedAt: number;
	note?: string;
}

/**
 * One-shot reader call, the same shape as the auto-mode classifier: no tools,
 * no session, no history — the page and the question in, an answer out.
 * `reasoning` and `temperature` are deliberately not sent; both fail *closed*
 * on providers that reject them (see the classifier notes), and a reader that
 * errors turns into the raw-content fallback, wasting the fetch.
 */
async function answerFromPage(
	ctx: ExtensionContext,
	prompt: string,
	entry: { markdown: string; title?: string },
	url: string,
	signal: AbortSignal | undefined,
): Promise<{ answer?: string; reader?: string; truncated?: boolean; error?: string }> {
	const choice = pickReaderModel(ctx.modelRegistry.getAvailable(), ctx.model);
	if (!choice) return { error: "no model available to read the page" };
	const reader = `${choice.model.provider}/${choice.model.id}`;

	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(choice.model);
		if (!auth.ok) return { error: `${reader}: ${auth.error}` };
		const baseUrl = (auth as { baseUrl?: string }).baseUrl;

		const messages = readerMessages({ prompt, markdown: entry.markdown, url, title: entry.title });
		const timeout = AbortSignal.timeout(READER_TIMEOUT_MS);
		const result = await completeSimple(
			baseUrl ? ({ ...choice.model, baseUrl } as Model<Api>) : choice.model,
			{
				systemPrompt: messages.system,
				messages: [{ role: "user", content: messages.user, timestamp: Date.now() }],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
				maxTokens: READER_MAX_TOKENS,
			},
		);
		const answer = result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
		if (!answer) return { error: `${reader} returned no text` };
		return { answer, reader, truncated: messages.truncated };
	} catch (error) {
		return { error: `${reader}: ${(error as Error).message}` };
	}
}

export default function webFetchExtension(pi: ExtensionAPI) {
	// Same 15-minute window Claude Code documents, so repeated reads of one page
	// during a task don't re-download it.
	const cache = new Map<string, CacheEntry>();

	const load = async (url: string, signal: AbortSignal | undefined): Promise<CacheEntry> => {
		const cached = cache.get(url);
		if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		timer.unref?.();
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });

		try {
			const response = await fetch(url, {
				redirect: "manual",
				signal: controller.signal,
				headers: { "user-agent": USER_AGENT, accept: "text/html,text/plain,*/*" },
			});

			// Cross-host redirects are reported rather than followed, matching Claude
			// Code, so a redirect can't quietly take the agent somewhere else.
			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get("location");
				if (location) {
					const target = new URL(location, url).toString();
					if (isSameHost(target, url)) {
						return await load(target, signal);
					}
					throw new Error(`Redirects to a different host: ${target}\nCall web_fetch again with that URL if you want it.`);
				}
			}

			if (!response.ok) {
				throw new Error(`HTTP ${response.status} ${response.statusText}`);
			}

			const contentType = response.headers.get("content-type") ?? "";
			const body = await response.text();

			let entry: CacheEntry;
			if (contentType.includes("html")) {
				const extracted = htmlToMarkdown(body, url);
				entry = {
					markdown: extracted.markdown,
					title: extracted.title,
					fetchedAt: Date.now(),
					note: extracted.fallback ? "No article structure found; converted the whole page." : undefined,
				};
			} else if (contentType.includes("json")) {
				entry = { markdown: `\`\`\`json\n${body.trim()}\n\`\`\``, fetchedAt: Date.now() };
			} else {
				entry = { markdown: body.trim(), fetchedAt: Date.now() };
			}

			cache.set(url, entry);
			return entry;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	};

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		...ccToolRenderers("Web Fetch"),
		description:
			"Fetch a URL and return its readable content as markdown. Navigation and boilerplate are stripped. Pass `prompt` to have a small fast model answer it from the full page instead of returning the page itself — prefer that for long pages. Without `prompt`, long pages are windowed; pass `offset` to continue reading. Responses are cached for 15 minutes. Cross-host redirects are reported instead of followed; call again with the new URL to follow one.",
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch (http is upgraded to https)" }),
			prompt: Type.Optional(
				Type.String({
					description:
						"Question to answer from the page. A small same-provider model reads the whole page and returns just the answer, keeping long pages out of context. Omit to get the raw page markdown",
				}),
			),
			offset: Type.Optional(
				Type.Integer({ minimum: 0, description: "Character offset to resume from for a long page" }),
			),
			max_chars: Type.Optional(
				Type.Integer({ minimum: 1000, maximum: 100_000, description: `Characters to return (default ${DEFAULT_MAX_CHARS})` }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			let target: string;
			let normalizeNote: string | undefined;
			try {
				const normalized = normalizeUrl(params.url);
				target = normalized.url;
				normalizeNote = normalized.note;
			} catch (error) {
				return {
					content: [{ type: "text", text: (error as Error).message }],
					details: {} as FetchDetails,
					isError: true,
				};
			}

			try {
				const entry = await load(target, signal);

				// Reader failures degrade to the raw page below — loudly, via
				// readerNote, never silently.
				let readerNote: string | undefined;
				if (params.prompt) {
					const answered = await answerFromPage(ctx, params.prompt, entry, target, signal);
					if (answered.answer !== undefined) {
						const header = [
							entry.title ? `# ${entry.title}` : undefined,
							`Source: ${target}`,
							normalizeNote,
							entry.note,
							answered.truncated ? "(The page exceeded the reader's window; its tail was not read.)" : undefined,
							`Answered by ${answered.reader} from the full page (${entry.markdown.length} chars). Refetch without \`prompt\` for the raw content.`,
						]
							.filter(Boolean)
							.join("\n");
						return {
							content: [{ type: "text", text: `${header}\n\n${answered.answer}` }],
							details: { url: target, totalChars: entry.markdown.length, reader: answered.reader },
						};
					}
					readerNote = `Could not answer \`prompt\` (${answered.error}); returning the raw page content instead.`;
				}

				const page = paginate(entry.markdown, params.offset ?? 0, params.max_chars ?? DEFAULT_MAX_CHARS);

				const header = [
					entry.title ? `# ${entry.title}` : undefined,
					`Source: ${target}`,
					normalizeNote,
					entry.note,
					readerNote,
					page.truncated
						? `Showing characters ${params.offset ?? 0}–${(params.offset ?? 0) + page.text.length} of ${page.totalChars}. Continue with offset ${page.nextOffset}.`
						: undefined,
				]
					.filter(Boolean)
					.join("\n");

				return {
					content: [{ type: "text", text: `${header}\n\n${page.text}` }],
					details: {
						url: target,
						totalChars: page.totalChars,
						truncated: page.truncated,
						nextOffset: page.nextOffset,
					},
				};
			} catch (error) {
				// Node's fetch() reports "fetch failed" / "This operation was aborted"
				// for DNS, connection, and timeout errors alike — the real cause hides
				// in error.cause, and a timeout is indistinguishable from a cancel by
				// name alone. Unpack all three so the model sees what actually failed
				// and what to try next.
				const err = error as Error & { cause?: unknown };
				const aborted = err.name === "AbortError" || err.name === "TimeoutError";
				if (aborted && signal?.aborted) {
					return {
						content: [{ type: "text", text: `Fetch of ${target} was cancelled.` }],
						details: { url: target },
						isError: true,
					};
				}
				const reason = aborted
					? `timed out after ${FETCH_TIMEOUT_MS / 1000}s — the site may be slow, unreachable, or blocking automated requests`
					: err.cause instanceof Error
						? `${err.message}: ${err.cause.message}`
						: err.message;
				return {
					content: [
						{
							type: "text",
							text: `Could not fetch ${target}: ${reason}. Verify the URL and host, retry, or use web_search instead.`,
						},
					],
					details: { url: target },
					isError: true,
				};
			}
		},
	});

	pi.events.emit(DEFER_CHANNEL, {
		name: "web_fetch",
		keywords: ["fetch", "url", "webpage", "web page", "read page", "http", "download", "docs", "article"],
	});
}
