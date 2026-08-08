/**
 * bash extension — Claude Code's Bash `run_in_background` on top of pi's own
 * bash tool.
 *
 * Registering a tool named `bash` overrides the built-in (findings §2), which
 * is how pi's official sandbox example does it too. The foreground path
 * delegates to pi's real executor (`createBashToolDefinition`) so upstream
 * bash behavior — timeout handling, truncation, PI_* env, spawn hooks — stays
 * exactly pi's; this file only adds the background branch.
 *
 * A background run spawns detached, returns a task id immediately, spools
 * output to `<sessionDir>/bash/<taskId>/output.log`, registers on the shared
 * background registry (task_output/task_stop just work — they are
 * kind-agnostic), and announces completion as a follow-up system
 * notification. The permission gate and auto-mode classifier run before
 * execute like any bash call — a background command is NOT auto-allowed, and
 * the gate fires before anything detaches.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { generateTaskId, TASK_REGISTER_CHANNEL } from "../background/registry.ts";
import { type BashFinishSummary, startBackgroundBash, tailCap } from "./background.ts";
import { systemNotification } from "../lib/notifications.ts";
import { ccWrapBuiltinRenderers, linesComponent, resultLines } from "../lib/tui-render.ts";

const NOTIFY_OUTPUT_CAP = 30_000;

const BashParams = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(
		Type.Number({ description: "Timeout in seconds (optional; also applies to background runs)" }),
	),
	run_in_background: Type.Optional(
		Type.Boolean({
			description:
				"Run detached and return a task id immediately instead of waiting. Completion arrives as a system notification; inspect with task_output, stop with task_stop. Use this instead of nohup/'&' — those leave an unmanaged orphan process",
		}),
	),
	description: Type.Optional(
		Type.String({ description: "5-10 word description of what the command does (shown in notifications)" }),
	),
});

export default function bashExtension(pi: ExtensionAPI) {
	// pi's definition supplies the description and TUI renderers; the executor
	// is re-created per working directory because it closes over cwd (worktree
	// switches change ctx.cwd mid-session).
	const base = createBashToolDefinition(process.cwd());
	const foregroundDefs = new Map<string, ReturnType<typeof createBashToolDefinition>>();
	const foreground = (cwd: string) => {
		let def = foregroundDefs.get(cwd);
		if (!def) {
			def = createBashToolDefinition(cwd);
			foregroundDefs.set(cwd, def);
		}
		return def;
	};

	const notify = (text: string, details: Record<string, unknown>) => {
		pi.sendMessage(
			{ customType: "task-notification", content: [{ type: "text", text }], display: true, details },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	};

	const taskLogPath = (ctx: ExtensionContext, taskId: string): string | undefined => {
		try {
			const dir = join(ctx.sessionManager.getSessionDir(), "bash", taskId);
			mkdirSync(dir, { recursive: true });
			return join(dir, "output.log");
		} catch {
			return undefined;
		}
	};

	const finishLine = (summary: BashFinishSummary, timeoutSeconds?: number): string => {
		if (summary.stopped) return "stopped";
		if (summary.timedOut) return `failed (timed out after ${timeoutSeconds}s)`;
		if (summary.exitCode === 0) return "completed";
		return `failed (${summary.exitCode !== null ? `exit code ${summary.exitCode}` : `terminated by ${summary.signal ?? "unknown signal"}`})`;
	};

	pi.registerTool({
		name: "bash",
		label: base.label,
		description: `${base.description} Pass run_in_background: true for long-running commands (builds, servers, watches): it returns a task id immediately so you can keep working, completion arrives as a system notification, and the output is retrievable with task_output / stoppable with task_stop.`,
		promptSnippet: base.promptSnippet,
		promptGuidelines: base.promptGuidelines,
		executionMode: base.executionMode,
		...(() => {
			// `● Bash(cmd)` / elbow-indented output, like every other pincer tool.
			// Not passing base.renderCall also drops its timer state, so the
			// misleading "Took Ns" that counted permission-prompt wait disappears.
			const wrapped = ccWrapBuiltinRenderers<{ command?: string }>("Bash", base, { title: (a) => a?.command });
			return {
				renderShell: wrapped.renderShell,
				renderCall: wrapped.renderCall as ToolDefinition<typeof BashParams>["renderCall"],
				renderResult: ((result, options, theme, context) => {
					// A background start returns a model-facing instruction paragraph;
					// the transcript needs one line (Claude Code: "Running in the background").
					const details = result.details as { taskId?: string; logPath?: string } | undefined;
					if (details?.taskId && !context.isError) {
						const line = `Running in background (task ${details.taskId}${details.logPath ? ` · log: ${details.logPath}` : ""})`;
						return linesComponent(() => resultLines(theme as any, line, options.expanded, false));
					}
					return wrapped.renderResult(result, options, theme, context);
				}) as ToolDefinition<typeof BashParams>["renderResult"],
			};
		})(),
		parameters: BashParams,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (!params.run_in_background) {
				return foreground(ctx.cwd).execute(
					toolCallId,
					{ command: params.command, timeout: params.timeout },
					signal,
					onUpdate,
					ctx,
				);
			}

			const id = generateTaskId();
			const logPath = taskLogPath(ctx, id);
			const description = params.description || params.command.slice(0, 80);
			const task = startBackgroundBash({
				id,
				command: params.command,
				description,
				cwd: ctx.cwd,
				timeoutSeconds: params.timeout,
				logPath,
				onFinished: (finishedTask, summary) => {
					notify(
						systemNotification(`Background bash ${id} (${description}) ${finishLine(summary, params.timeout)}.\n\n${tailCap(summary.output, NOTIFY_OUTPUT_CAP)}`),
						{ taskId: id, status: finishedTask.status, exitCode: summary.exitCode, logPath },
					);
				},
			});
			pi.events.emit(TASK_REGISTER_CHANNEL, task);

			return {
				content: [
					{
						type: "text",
						text: `⏳ Bash task ${id} running in background (${description}).\n\nCompletion (with output) will arrive as a system notification on its own — you do not need to wait for it or poll; keep working.${logPath ? ` To check interim output, read ${logPath}.` : ""} If your next step cannot proceed without the result, task_output with block=true waits for it. Stop with task_stop.`,
					},
				],
				details: { taskId: id, logPath },
			};
		},
	});
}
