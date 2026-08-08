/**
 * tool-search extension — Claude Code's ToolSearch.
 *
 * Deactivates every tool registered in the deferred registry at session start,
 * tells the model which names exist (a system reminder, as Claude Code does),
 * and activates matches additively when the model calls `tool_search`.
 *
 * Deferral is FRONTIER-ONLY, matching Claude Code (findings §14: a Haiku
 * session gets all 38 tools eagerly, no ToolSearch) — weaker models are bad at
 * the load-then-call indirection, so mid/low tiers get every tool eagerly and
 * no deferred-tools reminder. The registry is still maintained on all tiers,
 * so a mid-session model change flips the surface in either direction.
 *
 * Load order matters: this extension must come BEFORE any extension that defers
 * a tool, because those emit their defer request while extensions are loading
 * and pi's event bus only delivers to listeners already registered.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	DEFER_CHANNEL,
	deferredRegistry,
	deferredReminderText,
	type DeferRequest,
	searchTools,
	selectedNames,
} from "../lib/deferred.ts";
import { resolveModelTier } from "../lib/model-tier.ts";
import { REMINDER_CHANNEL } from "../lib/reminders.ts";
import { ccToolRenderers } from "../lib/tui-render.ts";

export default function toolSearchExtension(pi: ExtensionAPI) {
	let sessionStarted = false;
	/** Current tier defers (frontier) vs eager-loads everything (mid/low). */
	let defer = true;

	const searchableTools = () =>
		pi
			.getAllTools()
			.filter((tool) => deferredRegistry.has(tool.name))
			.map((tool) => ({
				name: tool.name,
				description: tool.description ?? "",
				keywords: deferredRegistry.keywordsFor(tool.name),
			}));

	const announceDeferred = () => {
		const available = searchableTools();
		if (available.length === 0) return;
		pi.events.emit(REMINDER_CHANNEL, {
			scope: "every-turn",
			key: "deferred-tools",
			text: deferredReminderText(available),
		});
	};

	/** Align the active tool set and the reminder with the model's tier. */
	const applyTier = (model: Parameters<typeof resolveModelTier>[0]) => {
		defer = resolveModelTier(model) === "frontier";
		const deferred = new Set(deferredRegistry.names);
		if (deferred.size === 0) return;
		const active = pi.getActiveTools();
		if (defer) {
			const next = active.filter((name) => !deferred.has(name));
			if (next.length !== active.length) pi.setActiveTools(next);
			announceDeferred();
		} else {
			const missing = deferredRegistry.names.filter((name) => !active.includes(name));
			if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
			pi.events.emit(REMINDER_CHANNEL, { key: "deferred-tools", remove: true });
		}
	};

	pi.events.on(DEFER_CHANNEL, (data) => {
		const request = data as DeferRequest;
		deferredRegistry.add(request);
		// A defer arriving after the session_start pass (MCP servers connect
		// asynchronously and register their tools then) would otherwise leave the
		// tool eager AND unlisted in the reminder. On a deferring tier, deactivate
		// it and refresh the keyed reminder; on an eager tier it stays active.
		if (sessionStarted && defer && request?.name) {
			const active = pi.getActiveTools();
			if (active.includes(request.name)) {
				pi.setActiveTools(active.filter((name) => name !== request.name));
			}
			announceDeferred();
		}
	});

	pi.on("session_start", (_event, ctx) => {
		sessionStarted = true;
		applyTier(ctx.model);
	});
	pi.on("model_select", (event) => applyTier(event.model));

	pi.registerTool({
		name: "tool_search",
		label: "Tool Search",
		...ccToolRenderers("Tool Search"),
		description:
			"Load the schemas of tools that are available but not yet callable. Query forms: `select:<name>[,<name>]` to load exact tools by name, `+<term> <words>` to require a term in the tool name, or plain keywords to search. Returns the tools that are now callable.",
		promptSnippet: "Load additional tool schemas on demand",
		parameters: Type.Object({
			query: Type.String({ description: "Tool names (`select:a,b`) or keywords describing the capability needed" }),
			max_results: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 20, description: "Maximum tools to load (default 5)" }),
			),
		}),
		async execute(_toolCallId, params) {
			const available = searchableTools();
			const matches = searchTools(params.query, available, params.max_results ?? 5);

			// For an exact `select:` query, a requested name that matched nothing was
			// silently dropped before — the model was told the rest "Loaded" and only
			// discovered the miss later as an opaque InputValidationError. Always
			// surface the unmatched names.
			const requested = selectedNames(params.query);
			const notFound = requested
				? requested.filter((n) => !matches.some((m) => m.name.toLowerCase() === n))
				: [];
			const notFoundNote =
				notFound.length > 0
					? ` Not found (not deferred tool names — check spelling, or search by keyword instead of \`select:\`): ${notFound.join(", ")}.`
					: "";

			if (matches.length === 0) {
				const names = available.map((t) => t.name).join(", ") || "(none)";
				return {
					content: [
						{ type: "text", text: `No tools matched "${params.query}".${notFoundNote} Tools that can be loaded: ${names}` },
					],
					details: { matches: [] as string[], added: [] as string[], notFound },
					isError: true,
				};
			}

			const active = pi.getActiveTools();
			const added = matches.map((m) => m.name).filter((name) => !active.includes(name));
			if (added.length > 0) {
				pi.setActiveTools([...new Set([...active, ...added])]);
			}

			const loaded = matches.map((m) => m.name);
			return {
				content: [
					{
						type: "text",
						text:
							(added.length > 0
								? `Loaded ${added.join(", ")}. These tools are now callable.`
								: `Already loaded: ${loaded.join(", ")}.`) + notFoundNote,
					},
				],
				details: { matches: loaded, added, notFound },
			};
		},
	});

	pi.registerCommand("tools-deferred", {
		description: "Show which tools are deferred (loadable via tool_search)",
		handler: async (_args, ctx) => {
			const available = searchableTools();
			const activeSet = new Set(pi.getActiveTools());
			const lines = available.map((t) => `${activeSet.has(t.name) ? "loaded " : "deferred"} ${t.name}`);
			ctx.ui.notify(lines.length ? lines.join("\n") : "No deferred tools registered.", "info");
		},
	});
}
