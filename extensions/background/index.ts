/**
 * background extension — Claude Code's background-task surface:
 * monitor, task_output, task_stop, schedule_wakeup.
 *
 * Owns the BackgroundRegistry. Other extensions (subagents) register their
 * long-running work over TASK_REGISTER_CHANNEL at runtime, so task_output and
 * task_stop address every background task in the session regardless of which
 * extension started it. Events and completions are delivered as follow-up
 * messages framed as system notifications, never as user input.
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFER_CHANNEL } from "../lib/deferred.ts";
import { ccToolRenderers, customMessageText, notificationComponent } from "../lib/tui-render.ts";
import {
	type BackgroundTask,
	BackgroundRegistry,
	formatTaskLine,
	generateTaskId,
	TASK_REGISTER_CHANNEL,
} from "./registry.ts";
import { buildWakeupMessage, clampDelaySeconds, describeSchedule } from "./wakeup.ts";
import { systemNotification } from "../lib/notifications.ts";

const OUTPUT_CAP = 30_000;
const STORED_OUTPUT_CAP = 200_000;
const EVENT_BATCH_MS = 1000;
const DEFAULT_MONITOR_TIMEOUT_MS = 300_000;
const MAX_MONITOR_TIMEOUT_MS = 3_600_000;
const MAX_BLOCK_TIMEOUT_MS = 600_000;

function tail(text: string, cap: number): string {
	return text.length <= cap ? text : `… (earlier output truncated)\n${text.slice(-cap)}`;
}

export default function backgroundExtension(pi: ExtensionAPI) {
	const registry = new BackgroundRegistry();
	let lastCtx: ExtensionContext | undefined;
	let wakeup: { timer: NodeJS.Timeout; prompt: string; reason: string } | undefined;

	pi.events.on(TASK_REGISTER_CHANNEL, (task) => registry.register(task as BackgroundTask));

	const updateWidget = () => {
		if (!lastCtx?.hasUI) return;
		const running = registry.running().length;
		lastCtx.ui.setWidget("cc-background", running > 0 ? [` background tasks: ${running} running`] : undefined);
	};

	// Harness-injected notifications carry anti-confabulation framing for the
	// model; the transcript shows a compact headline instead (ctrl+o expands).
	// One registration covers every emitter of the type (bash uses it too).
	for (const customType of ["task-notification", "wakeup"]) {
		pi.registerMessageRenderer(customType, (message, { expanded }, theme) =>
			notificationComponent(theme, customMessageText(message.content), expanded),
		);
	}

	const notify = (customType: string, text: string, details: Record<string, unknown>) => {
		pi.sendMessage(
			{ customType, content: [{ type: "text", text }], display: true, details },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	};

	pi.registerTool({
		name: "monitor",
		label: "Monitor",
		...ccToolRenderers("Monitor"),
		description:
			"Start a background monitor that streams events from a long-running command. Each stdout line becomes a notification delivered to the conversation while you keep working; the command exiting ends the watch. Use for 'tell me every time X happens' (tail -f, polling loops); for a single completion signal prefer a subagent or a blocking command. Returns a task id — stop with task_stop, inspect with task_output. Alternatively pass `ws` to watch a WebSocket (each text frame is an event).",
		parameters: Type.Object({
			command: Type.Optional(Type.String({ description: "Shell command; each stdout line is an event, exit ends the watch" })),
			description: Type.String({ description: "Short description of what is being monitored (shown in notifications)" }),
			persistent: Type.Optional(Type.Boolean({ description: "Run for the session lifetime (no timeout); stop with task_stop" })),
			timeout_ms: Type.Optional(
				Type.Number({ minimum: 1000, description: `Kill the monitor after this deadline (default ${DEFAULT_MONITOR_TIMEOUT_MS}, max ${MAX_MONITOR_TIMEOUT_MS}); ignored when persistent` }),
			),
			ws: Type.Optional(
				Type.Object(
					{
						url: Type.String(),
						protocols: Type.Optional(Type.Array(Type.String())),
					},
					{ description: "WebSocket to watch instead of a command; each text frame is an event, close ends the watch" },
				),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			if (Boolean(params.command) === Boolean(params.ws)) {
				return {
					content: [{ type: "text", text: "Pass exactly one of `command` or `ws`." }],
					details: {},
					isError: true,
				};
			}

			const id = generateTaskId();
			let status: BackgroundTask["status"] = "running";
			let stored = "";
			let eventCount = 0;
			let pending: string[] = [];
			let flushTimer: NodeJS.Timeout | undefined;
			let finish!: () => void;
			const finished = new Promise<void>((resolve) => {
				finish = resolve;
			});

			const flush = () => {
				flushTimer = undefined;
				if (pending.length === 0) return;
				const batch = pending;
				pending = [];
				notify(
					"task-notification",
					systemNotification(`Monitor ${id} (${params.description}) emitted ${batch.length} event(s):\n${batch.join("\n")}`),
					{ taskId: id, events: batch.length },
				);
			};

			const onEvent = (line: string) => {
				eventCount++;
				stored = tail(`${stored}${line}\n`, STORED_OUTPUT_CAP);
				pending.push(line);
				flushTimer ??= setTimeout(flush, EVENT_BATCH_MS);
			};

			const end = (finalStatus: BackgroundTask["status"], note?: string) => {
				if (status !== "running") return;
				status = finalStatus;
				task.status = finalStatus;
				task.finishedAt = Date.now();
				if (flushTimer) clearTimeout(flushTimer);
				flush();
				finish();
				updateWidget();
				notify(
					"task-notification",
					systemNotification(`Monitor ${id} (${params.description}) ${finalStatus}${note ? ` — ${note}` : ""} after ${eventCount} event(s).`),
					{ taskId: id, status: finalStatus },
				);
			};

			let stopRequested = false;
			let stop: () => void;
			if (params.command) {
				const child = spawn(process.env.SHELL || "/bin/sh", ["-c", params.command], {
					cwd: ctx.cwd,
					stdio: ["ignore", "pipe", "pipe"],
				});
				let buffer = "";
				child.stdout.on("data", (chunk: Buffer) => {
					buffer += chunk.toString();
					let idx: number;
					while ((idx = buffer.indexOf("\n")) !== -1) {
						const line = buffer.slice(0, idx).trimEnd();
						buffer = buffer.slice(idx + 1);
						if (line) onEvent(line);
					}
				});
				child.stderr.on("data", (chunk: Buffer) => {
					stored = tail(`${stored}${chunk.toString()}`, STORED_OUTPUT_CAP);
				});
				child.on("error", (error) => end("failed", error.message));
				child.on("close", (code) =>
					end(
						stopRequested ? "stopped" : code === 0 ? "completed" : "failed",
						code !== null && code !== 0 ? `exit code ${code}` : undefined,
					),
				);
				stop = () => {
					stopRequested = true;
					child.kill("SIGTERM");
				};
			} else {
				let ws: WebSocket;
				try {
					ws = new WebSocket(params.ws!.url, params.ws!.protocols);
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Could not open the WebSocket — check \`ws.url\` ("${params.ws!.url}"): ${(error as Error).message}`,
							},
						],
						details: {},
						isError: true,
					};
				}
				ws.addEventListener("message", (event) => {
					onEvent(typeof event.data === "string" ? event.data : "[binary frame]");
				});
				ws.addEventListener("error", () => end("failed", "websocket error"));
				ws.addEventListener("close", () => end(stopRequested ? "stopped" : "completed", "socket closed"));
				stop = () => {
					stopRequested = true;
					ws.close();
				};
			}

			const task: BackgroundTask = {
				id,
				kind: "monitor",
				description: params.description,
				status,
				startedAt: Date.now(),
				output: () => stored,
				stop,
				finished,
			};
			registry.register(task);
			updateWidget();

			if (!params.persistent) {
				const timeoutMs = Math.min(params.timeout_ms ?? DEFAULT_MONITOR_TIMEOUT_MS, MAX_MONITOR_TIMEOUT_MS);
				const timer = setTimeout(() => {
					if (task.status === "running") stop();
				}, timeoutMs);
				timer.unref?.();
			}

			return {
				content: [
					{
						type: "text",
						text: `Monitor ${id} started (${params.description}). Events arrive as system notifications; stop with task_stop, inspect with task_output.`,
					},
				],
				details: { taskId: id },
			};
		},
	});

	pi.registerTool({
		name: "task_output",
		label: "Task Output",
		...ccToolRenderers("Task Output"),
		description:
			"Retrieve output from a running or finished background task (monitor, background subagent, or background bash) by task id. block=true (default) waits up to `timeout` ms for completion; block=false returns the current status immediately. You never need this just to learn that a task finished — completion always arrives as a system notification carrying the output; call this only when your next step needs the result now, or for a mid-run peek.",
		parameters: Type.Object({
			task_id: Type.String({ description: "The task id to get output from" }),
			block: Type.Optional(Type.Boolean({ description: "Wait for completion (default true)" })),
			timeout: Type.Optional(Type.Number({ minimum: 0, maximum: MAX_BLOCK_TIMEOUT_MS, description: "Max wait in ms (default 30000)" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const task = registry.get(params.task_id);
			if (!task) {
				const known = registry.list().map((t) => t.id).join(", ") || "(none)";
				return {
					content: [{ type: "text", text: `No background task "${params.task_id}". Known tasks: ${known}` }],
					details: {},
					isError: true,
				};
			}

			if (params.block !== false && task.status === "running") {
				const timeoutMs = Math.min(params.timeout ?? 30_000, MAX_BLOCK_TIMEOUT_MS);
				await Promise.race([
					task.finished,
					new Promise<void>((resolve) => {
						const timer = setTimeout(resolve, timeoutMs);
						timer.unref?.();
						signal?.addEventListener("abort", () => {
							clearTimeout(timer);
							resolve();
						}, { once: true });
					}),
				]);
			}

			updateWidget();
			const header = formatTaskLine(task);
			const body = tail(task.output(), OUTPUT_CAP) || "(no output yet)";
			return {
				content: [{ type: "text", text: `${header}\n\n${body}` }],
				details: { taskId: task.id, status: task.status, logPath: task.logPath },
			};
		},
	});

	pi.registerTool({
		name: "task_stop",
		label: "Stop Task",
		...ccToolRenderers("Stop Task"),
		description: "Stop a running background task (monitor, background subagent, or background bash) by task id.",
		parameters: Type.Object({
			task_id: Type.String({ description: "The id of the background task to stop" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const task = registry.get(params.task_id);
			if (!task) {
				const known = registry.list().map((t) => t.id).join(", ") || "(none)";
				return {
					content: [{ type: "text", text: `No background task "${params.task_id}". Known tasks: ${known}` }],
					details: {},
					isError: true,
				};
			}
			if (task.status !== "running" && !task.resident?.()) {
				return { content: [{ type: "text", text: `Task ${task.id} is already ${task.status}.` }], details: { taskId: task.id } };
			}
			const wasResident = task.status !== "running";
			task.stop();
			updateWidget();
			return {
				content: [
					{
						type: "text",
						text: wasResident
							? `Terminated the resident agent behind ${task.id} (${task.description}); it can no longer be messaged live (send_message will resume it from its session file).`
							: `Stop requested for ${task.id} (${task.description}).`,
					},
				],
				details: { taskId: task.id },
			};
		},
	});

	pi.registerTool({
		name: "schedule_wakeup",
		label: "Schedule Wakeup",
		...ccToolRenderers<{ delaySeconds?: number; stop?: boolean }>("Schedule Wakeup", {
			title: (a) => (a?.stop ? "stop" : a?.delaySeconds !== undefined ? `${a.delaySeconds}s` : undefined),
		}),
		description:
			"Schedule when to resume work on a self-paced recurring task: after `delaySeconds` (clamped to [60, 3600]) the given prompt is delivered as a system notification and a new turn starts. One wakeup is pending at a time — scheduling again replaces it; {stop: true} cancels the loop. Do not use this to poll background tasks you started here — their completion already notifies you.",
		parameters: Type.Object({
			delaySeconds: Type.Optional(Type.Number({ description: "Seconds from now to wake up, clamped to [60, 3600]. Required unless stop is true" })),
			prompt: Type.Optional(Type.String({ description: "The task to continue when the wakeup fires. Required unless stop is true" })),
			reason: Type.Optional(Type.String({ description: "One short sentence explaining the chosen delay; shown to the user. Required unless stop is true" })),
			stop: Type.Optional(Type.Boolean({ description: "End the loop: cancel any pending wakeup and schedule nothing" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const clearPending = () => {
				if (wakeup) {
					clearTimeout(wakeup.timer);
					wakeup = undefined;
				}
			};
			if (params.stop) {
				clearPending();
				return { content: [{ type: "text", text: "Wakeup loop stopped; no further wakeups will fire." }], details: {} };
			}
			// Validate BEFORE touching the pending wakeup: clearing it up front meant
			// a malformed reschedule silently killed a running /loop with no signal.
			if (params.delaySeconds === undefined || !params.prompt || !params.reason) {
				return {
					content: [
						{
							type: "text",
							text: `delaySeconds, prompt, and reason are all required unless stop is true.${wakeup ? " Your previous wakeup is still pending — this call was rejected and left it untouched." : ""}`,
						},
					],
					details: {},
					isError: true,
				};
			}
			// Valid reschedule — now it is safe to replace any pending wakeup.
			clearPending();

			const request = { delaySeconds: params.delaySeconds, prompt: params.prompt, reason: params.reason };
			const delayMs = clampDelaySeconds(params.delaySeconds) * 1000;
			const timer = setTimeout(() => {
				wakeup = undefined;
				notify("wakeup", buildWakeupMessage(request), { reason: request.reason });
			}, delayMs);
			timer.unref?.();
			wakeup = { timer, prompt: params.prompt, reason: params.reason };
			return { content: [{ type: "text", text: describeSchedule(request) }], details: { delayMs } };
		},
	});

	for (const [name, keywords] of Object.entries({
		monitor: ["monitor", "watch", "background", "tail", "events", "stream", "websocket"],
		task_output: ["task", "background", "output", "status", "wait"],
		task_stop: ["task", "background", "stop", "kill", "cancel"],
		schedule_wakeup: ["wakeup", "loop", "schedule", "timer", "recurring", "later"],
	})) {
		pi.events.emit(DEFER_CHANNEL, { name, keywords });
	}

	pi.registerCommand("background", {
		description: "List background tasks (monitors, background subagents)",
		handler: async (_args, ctx) => {
			const tasks = registry.list();
			ctx.ui.notify(tasks.length ? tasks.map(formatTaskLine).join("\n") : "No background tasks.", "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
	});

	pi.on("session_shutdown", () => {
		registry.stopAll();
		if (wakeup) clearTimeout(wakeup.timer);
		wakeup = undefined;
	});
}
