/**
 * hooks extension — Claude Code-compatible command hooks.
 *
 * Reads CC hook config (user/managed .claude settings always; project/local
 * after a once-per-config consent — trust.ts; plugin hooks/hooks.json as user
 * scope), matches CC-style matchers against tool calls and lifecycle events,
 * runs the commands with the CC stdin/stdout protocol (protocol.ts,
 * executor.ts), and applies the verdicts.
 *
 * Position in package.json pi.extensions is load-bearing: this extension must
 * run its tool_call handler BEFORE worktree/file-tracker/permissions, so hook
 * matchers and updatedInput see the tool call as the model produced it, and
 * everything downstream — including the permission gate, safety floor, and
 * auto-mode classifier — evaluates the hook-rewritten input (CC semantics).
 *
 * A hook can block anything, loaders included (tool_search/skill/
 * structured_output) — full CC fidelity, the user's config is the user's
 * choice; see docs/findings.md for the foot-gun note. A hook can never
 * pre-approve: "allow" is informational and the permission gate still runs.
 *
 * pi's emitToolCall has no try/catch around handlers, so every hook dispatch
 * here is wrapped — a throwing hook fails open, never takes the turn down.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { claudeConfigDir } from "../lib/paths.ts";
import { appendHookLog, formatDebugLine, hooksDebugEnabled, hooksLogPath } from "./debug.ts";
import { runHookCommand } from "./executor.ts";
import { matcherApplies, ccToolName, toolMatchCandidates } from "./matcher.ts";
import { loadPluginHooks } from "./plugin-hooks.ts";
import {
	type CcHookEvent,
	type HookOutcome,
	type HookStdinPayload,
	interpretHookResult,
} from "./protocol.ts";
import { type HookCommand, type HooksSource, loadHookSettings } from "./settings.ts";
import { projectHooksApproved } from "./trust.ts";

interface MatchedHook {
	source: HooksSource;
	hook: HookCommand;
}

export default function hooksExtension(pi: ExtensionAPI) {
	let stopHookActive = false;
	let pendingPromptContext: string[] = [];

	const notify = (ctx: ExtensionContext, message: string) => {
		if (ctx.hasUI) ctx.ui.notify(message, "info");
		else process.stderr.write(`${message}\n`);
	};

	/** All hooks for an event across trusted sources, matcher already applied. */
	const collectHooks = async (
		ctx: ExtensionContext,
		event: CcHookEvent,
		matchValue: { candidates?: string[]; ignoreMatcher?: boolean },
	): Promise<MatchedHook[]> => {
		const claudeDir = claudeConfigDir();
		const loaded = loadHookSettings(claudeDir, ctx.cwd);
		const pluginSources = loadPluginHooks(claudeDir, loaded.diagnostics);
		if (hooksDebugEnabled()) {
			for (const diagnostic of loaded.diagnostics) process.stderr.write(`[hooks] ${diagnostic}\n`);
		}

		const projectSources = loaded.sources.filter((s) => s.scope === "project" || s.scope === "local");
		const hasProjectHooks = projectSources.some((s) => s.config[event]?.length);
		let projectAllowed = true;
		if (hasProjectHooks) {
			projectAllowed = await projectHooksApproved(ctx.cwd, projectSources, {
				hasUI: ctx.hasUI,
				confirm: (title, message) => ctx.ui.confirm(title, message),
				notify: (message) => notify(ctx, message),
			});
		}

		const sources = [
			...loaded.sources.filter((s) => s.scope === "user" || s.scope === "managed"),
			...pluginSources,
			...(projectAllowed ? projectSources : []),
		];

		const matched: MatchedHook[] = [];
		for (const source of sources) {
			for (const entry of source.config[event] ?? []) {
				const applies = matchValue.ignoreMatcher || matcherApplies(entry.matcher, matchValue.candidates ?? []);
				if (!applies) continue;
				for (const hook of entry.hooks) matched.push({ source, hook });
			}
		}
		return matched;
	};

	const basePayload = (ctx: ExtensionContext, event: CcHookEvent): HookStdinPayload => ({
		session_id: ctx.sessionManager.getSessionId(),
		transcript_path: ctx.sessionManager.getSessionFile() ?? "",
		cwd: ctx.cwd,
		hook_event_name: event,
	});

	/**
	 * Run every matched hook in parallel (CC runs matching hooks concurrently)
	 * and merge: first block wins, updatedInput merges in order, contexts and
	 * systemMessages concatenate. Any throw inside is caught → fail open.
	 */
	const dispatch = async (
		ctx: ExtensionContext,
		event: CcHookEvent,
		matchValue: { candidates?: string[]; ignoreMatcher?: boolean },
		payload: HookStdinPayload,
	): Promise<HookOutcome> => {
		const merged: HookOutcome = {};
		try {
			const hooks = await collectHooks(ctx, event, matchValue);
			if (hooks.length === 0) return merged;
			const stdin = JSON.stringify(payload);
			const outcomes = await Promise.all(
				hooks.map(async ({ source, hook }) => {
					const run = await runHookCommand(hook.command, stdin, {
						cwd: ctx.cwd,
						timeoutSeconds: hook.timeout,
						projectDir: ctx.cwd,
					});
					const outcome = interpretHookResult(event, run);
					const decision = outcome.block ? "block" : outcome.additionalContext ? "context" : run.exitCode === 0 || run.exitCode === 2 ? "allow" : "error";
					const logEntry = {
						event,
						scope: source.pluginName ? `plugin:${source.pluginName}` : source.scope,
						command: hook.command,
						decision: decision as "allow" | "block" | "context" | "error",
						reason: outcome.block?.reason,
						exitCode: run.exitCode,
						durationMs: run.durationMs,
					};
					if (hooksDebugEnabled()) process.stderr.write(`${formatDebugLine(logEntry)}\n`);
					if (process.env.CC_HOOKS_DEBUG === "2") {
						appendHookLog({ ts: new Date().toISOString(), sessionId: payload.session_id, ...logEntry }, hooksLogPath());
					}
					return outcome;
				}),
			);
			for (const outcome of outcomes) {
				merged.block ??= outcome.block;
				if (outcome.updatedInput) merged.updatedInput = { ...merged.updatedInput, ...outcome.updatedInput };
				if ("updatedToolResult" in outcome) merged.updatedToolResult = outcome.updatedToolResult;
				if (outcome.additionalContext) {
					merged.additionalContext = [merged.additionalContext, outcome.additionalContext].filter(Boolean).join("\n");
				}
				if (outcome.systemMessage) {
					merged.systemMessage = [merged.systemMessage, outcome.systemMessage].filter(Boolean).join("\n");
				}
			}
		} catch (error) {
			// Fail open: a broken hook pipeline must never take the turn down.
			if (hooksDebugEnabled()) {
				process.stderr.write(`[hooks] dispatch error (${event}): ${error instanceof Error ? error.message : error}\n`);
			}
		}
		if (merged.systemMessage) notify(ctx, merged.systemMessage);
		return merged;
	};

	/** Hidden custom message the model sees as context, CC's additionalContext. */
	const injectContext = (text: string, midLoop: boolean) => {
		const message = { customType: "pincer:hook-context", content: `<hook-additional-context>\n${text}\n</hook-additional-context>`, display: false };
		try {
			if (midLoop) pi.sendMessage(message, { deliverAs: "steer" });
			else pi.sendMessage(message);
		} catch {
			try {
				pi.sendMessage(message);
			} catch {
				// No session to speak to; drop the context.
			}
		}
	};

	// ---- PreToolUse ---------------------------------------------------------
	pi.on("tool_call", async (event, ctx) => {
		const payload: HookStdinPayload = {
			...basePayload(ctx, "PreToolUse"),
			tool_name: ccToolName(event.toolName),
			tool_input: event.input as Record<string, unknown>,
		};
		const outcome = await dispatch(ctx, "PreToolUse", { candidates: toolMatchCandidates(event.toolName) }, payload);
		if (outcome.block) return { block: true, reason: `PreToolUse hook: ${outcome.block.reason}` };
		if (outcome.updatedInput) {
			// In-place, so worktree/file-tracker/permissions (later in the
			// extension order) all see the rewritten input — CC applies hook
			// input updates before permission evaluation.
			Object.assign(event.input as Record<string, unknown>, outcome.updatedInput);
		}
		if (outcome.additionalContext) injectContext(outcome.additionalContext, true);
		return undefined;
	});

	// ---- PostToolUse --------------------------------------------------------
	pi.on("tool_result", async (event, ctx) => {
		const payload: HookStdinPayload = {
			...basePayload(ctx, "PostToolUse"),
			tool_name: ccToolName(event.toolName),
			tool_input: event.input,
			tool_response: { content: event.content, is_error: event.isError },
		};
		const outcome = await dispatch(ctx, "PostToolUse", { candidates: toolMatchCandidates(event.toolName) }, payload);
		if (!outcome.block && outcome.updatedToolResult === undefined && !outcome.additionalContext) return undefined;

		let content = [...event.content];
		let isError = event.isError;
		if (outcome.updatedToolResult !== undefined) {
			const replacement = outcome.updatedToolResult;
			content = [{ type: "text", text: typeof replacement === "string" ? replacement : JSON.stringify(replacement) }];
		}
		if (outcome.block) {
			// The tool already ran; the only channel left is the result the
			// model reads, so the objection is delivered there (CC feeds
			// PostToolUse block reasons back to the model the same way).
			content = [{ type: "text" as const, text: `PostToolUse hook: ${outcome.block.reason}` }, ...content];
			isError = true;
		}
		if (outcome.additionalContext) {
			content = [...content, { type: "text" as const, text: `<hook-additional-context>\n${outcome.additionalContext}\n</hook-additional-context>` }];
		}
		return { content, isError };
	});

	// ---- UserPromptSubmit ---------------------------------------------------
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return undefined;
		stopHookActive = false;
		const payload: HookStdinPayload = { ...basePayload(ctx, "UserPromptSubmit"), prompt: event.text };
		const outcome = await dispatch(ctx, "UserPromptSubmit", { ignoreMatcher: true }, payload);
		if (outcome.block) {
			notify(ctx, `Prompt blocked by UserPromptSubmit hook: ${outcome.block.reason}`);
			return { action: "handled" as const };
		}
		if (outcome.additionalContext) pendingPromptContext.push(outcome.additionalContext);
		return undefined;
	});

	// Prompt-hook context is injected right before the agent loop builds its
	// context, so it lands on the same turn as the prompt that produced it.
	pi.on("before_agent_start", () => {
		if (pendingPromptContext.length === 0) return;
		const texts = pendingPromptContext;
		pendingPromptContext = [];
		for (const text of texts) injectContext(text, false);
	});

	// ---- SessionStart / SessionEnd -----------------------------------------
	const dispatchSessionStart = async (ctx: ExtensionContext, source: string) => {
		const payload: HookStdinPayload = { ...basePayload(ctx, "SessionStart"), source };
		const outcome = await dispatch(ctx, "SessionStart", { candidates: [source] }, payload);
		if (outcome.additionalContext) injectContext(outcome.additionalContext, false);
	};

	pi.on("session_start", async (event, ctx) => {
		const reason = (event as { reason?: string }).reason ?? "startup";
		if (reason === "reload" || reason === "fork") return;
		await dispatchSessionStart(ctx, reason === "new" ? "startup" : reason);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const payload: HookStdinPayload = { ...basePayload(ctx, "SessionEnd"), source: "other" };
		// Fire and forget: the process is on its way out; nothing to apply.
		void dispatch(ctx, "SessionEnd", { ignoreMatcher: true }, payload);
	});

	// ---- Stop ---------------------------------------------------------------
	pi.on("agent_end", async (_event, ctx) => {
		const payload: HookStdinPayload = { ...basePayload(ctx, "Stop"), stop_hook_active: stopHookActive };
		const outcome = await dispatch(ctx, "Stop", { ignoreMatcher: true }, payload);
		if (!outcome.block) return;
		stopHookActive = true;
		try {
			pi.sendMessage(
				{
					customType: "pincer:hook-stop",
					content: `Stop hook blocked stopping: ${outcome.block.reason}`,
					display: false,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			// Session is gone; nothing to continue.
		}
	});

	// ---- PreCompact / PostCompact ------------------------------------------
	pi.on("session_before_compact", async (event, ctx) => {
		const reason = (event as { reason?: string }).reason;
		const trigger = reason === "manual" ? "manual" : "auto";
		const payload: HookStdinPayload = { ...basePayload(ctx, "PreCompact"), trigger };
		const outcome = await dispatch(ctx, "PreCompact", { candidates: [trigger] }, payload);
		if (outcome.block) {
			notify(ctx, `Compaction cancelled by PreCompact hook: ${outcome.block.reason}`);
			return { cancel: true };
		}
		return undefined;
	});

	pi.on("session_compact", async (_event, ctx) => {
		const payload: HookStdinPayload = { ...basePayload(ctx, "PostCompact"), trigger: "auto" };
		const outcome = await dispatch(ctx, "PostCompact", { ignoreMatcher: true }, payload);
		if (outcome.additionalContext) injectContext(outcome.additionalContext, false);
		// CC fires SessionStart(source: "compact") after compaction.
		await dispatchSessionStart(ctx, "compact");
	});
}
