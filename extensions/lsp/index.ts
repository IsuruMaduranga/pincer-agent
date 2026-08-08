/**
 * lsp extension — Claude Code's post-edit diagnostics.
 *
 * Two behaviors, no more:
 *  1. After a successful `edit` or `write`, error diagnostics for that file are
 *     appended to the tool result, so the model immediately sees what it broke.
 *  2. An `lsp_diagnostics` tool (deferred behind `tool_search`) for asking about
 *     a file on demand.
 *
 * Claude Code has no other LSP tools; navigation goes through grep/find. Adding
 * hover or definition later is a small `client.request(...)` call each, if the
 * need appears.
 */

import { relative } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFER_CHANNEL } from "../lib/deferred.ts";
import { ccToolRenderers } from "../lib/tui-render.ts";
import { LspClient } from "./client.ts";
import { filterDiagnostics, formatDiagnostics, type SeverityFilter } from "./format.ts";
import { findProjectRoot, serverForPath, typescriptPreflight } from "./servers.ts";

/** Only errors are pushed unasked; warnings would be noise on every edit. */
const AUTO_APPEND_LIMIT = 10;

export default function lspExtension(pi: ExtensionAPI) {
	const clients = new Map<string, LspClient>();
	const startFailures = new Map<string, string>();
	const warned = new Set<string>();

	const clientFor = async (path: string, cwd: string): Promise<LspClient | undefined> => {
		const match = serverForPath(path);
		if (!match) return undefined;

		const root = findProjectRoot(path, match.config.rootMarkers, cwd);
		const key = `${match.languageId}:${root}`;

		const failure = startFailures.get(key);
		if (failure) return undefined;

		const existing = clients.get(key);
		if (existing?.isRunning) return existing;
		if (existing) {
			// Crashed mid-session. Record why so downstream reports the real cause
			// (a server that was running and died) instead of falling through to
			// "install <command>" advice for an already-installed server — and so
			// the one-time post-edit warning still fires. Don't respawn in a loop.
			startFailures.set(key, existing.error ?? "language server stopped unexpectedly");
			return undefined;
		}

		if (match.languageId.startsWith("typescript") || match.languageId.startsWith("javascript")) {
			const problem = typescriptPreflight(root);
			if (problem) {
				startFailures.set(key, problem);
				return undefined;
			}
		}

		const client = new LspClient(match.languageId, match.config, root);
		clients.set(key, client);
		try {
			await client.start();
			return client;
		} catch (error) {
			startFailures.set(key, client.error ?? (error as Error).message);
			return undefined;
		}
	};

	/** One-time notice per root so a missing server doesn't degrade silently. */
	const reportFailureOnce = (path: string, cwd: string, notify: (message: string) => void) => {
		const match = serverForPath(path);
		if (!match) return;
		const root = findProjectRoot(path, match.config.rootMarkers, cwd);
		const key = `${match.languageId}:${root}`;
		const failure = startFailures.get(key);
		if (failure && !warned.has(key)) {
			warned.add(key);
			// Server errors run to paragraphs; the transcript gets one line and
			// /lsp keeps the full status.
			const brief = failure.split("\n")[0].replace(/\s+/g, " ").trim();
			const capped = brief.length > 100 ? `${brief.slice(0, 99)}…` : brief;
			notify(`LSP unavailable for ${match.languageId}: ${capped} (/lsp for status)`);
		}
	};

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return;
		if (event.toolName !== "edit" && event.toolName !== "write") return;

		const path = (event.input as { path?: unknown }).path;
		if (typeof path !== "string") return;

		const client = await clientFor(path, ctx.cwd);
		if (!client) {
			reportFailureOnce(path, ctx.cwd, (message) => {
				if (ctx.hasUI) ctx.ui.notify(message, "warning");
			});
			return;
		}

		const errors = filterDiagnostics(await client.getDiagnostics(path), "error");
		if (errors.length === 0) return;

		const relPath = relative(ctx.cwd, path) || path;
		const summary = formatDiagnostics(relPath, errors, AUTO_APPEND_LIMIT);
		const existing = event.content ?? [];
		return {
			content: [...existing, { type: "text", text: `\n<diagnostics>\n${summary}\n</diagnostics>` }],
		};
	});

	pi.registerTool({
		name: "lsp_diagnostics",
		label: "Diagnostics",
		...ccToolRenderers("Diagnostics"),
		description:
			"Ask the language server for diagnostics (type errors, warnings) on a file. Reflects the file's current contents. Supported: TypeScript/JavaScript, Python, Go, Rust, Java — when that language's server is installed.",
		parameters: Type.Object({
			path: Type.String({ description: "File to analyse (absolute or workspace-relative)" }),
			severity: Type.Optional(
				StringEnum(["error", "warning", "all"] as const, { description: "Minimum severity (default: all)" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const path = params.path.startsWith("/") ? params.path : `${ctx.cwd}/${params.path}`;
			const client = await clientFor(path, ctx.cwd);
			if (!client) {
				const match = serverForPath(path);
				const root = match ? findProjectRoot(path, match.config.rootMarkers, ctx.cwd) : ctx.cwd;
				const failure = match ? startFailures.get(`${match.languageId}:${root}`) : undefined;
				return {
					content: [
						{
							type: "text",
							text:
								failure ??
								(match
									? `No language server available for ${match.languageId}. Install ${match.config.command}.`
									: `No language server is configured for this file type.`),
						},
					],
					details: { available: false },
					// A language was recognised but its server is unavailable/failed —
					// that is an error, not a clean "no diagnostics". Only a genuinely
					// unsupported filetype (no match) is a non-error outcome.
					isError: Boolean(match),
				};
			}

			const all = await client.getDiagnostics(path);
			const filtered = filterDiagnostics(all, (params.severity ?? "all") as SeverityFilter);
			const relPath = relative(ctx.cwd, path) || path;
			return {
				content: [{ type: "text", text: formatDiagnostics(relPath, filtered) }],
				details: { count: filtered.length, languageId: client.languageId },
			};
		},
	});

	pi.registerCommand("lsp", {
		description: "Show language server status",
		handler: async (_args, ctx) => {
			const lines = [...clients.entries()].map(
				([key, client]) => `${client.isRunning ? "running" : "stopped"} ${key} (${client.diagnosticsCount} diagnostics)`,
			);
			for (const [key, failure] of startFailures) lines.push(`failed  ${key}: ${failure}`);
			ctx.ui.notify(lines.length ? lines.join("\n") : "No language servers started.", "info");
		},
	});

	pi.on("session_shutdown", async () => {
		await Promise.all([...clients.values()].map((client) => client.stop()));
		clients.clear();
	});

	pi.events.emit(DEFER_CHANNEL, {
		name: "lsp_diagnostics",
		keywords: ["diagnostics", "errors", "type error", "typecheck", "compile", "lint", "lsp"],
	});
}
