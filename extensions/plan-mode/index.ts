/**
 * plan-mode extension — Claude Code's EnterPlanMode / ExitPlanMode tools,
 * file-based: the plan lives at ~/.pincer/plans/<slug>.md, the one path plan
 * mode may write. The path is announced to the model in an every-turn reminder
 * and to the permissions extension over the event bus, and exit_plan_mode
 * reads the file rather than taking the plan as a parameter.
 *
 * Mode state is owned by the permissions extension; this extension requests
 * changes over MODE_CHANNEL and reacts to transitions it observes on
 * PERMISSION_STATUS_CHANNEL (which fires on every setMode). Plan-file
 * allocation happens lazily in before_agent_start — the one hook that covers
 * all three ways into plan mode (the tool, ctrl+q, defaultMode: "plan") and
 * runs after every extension's session_start, so restoring a previous path
 * from the session branch can never race a fresh allocation.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pincerStateDir } from "../lib/paths.ts";
import { REMINDER_CHANNEL } from "../lib/reminders.ts";
import { ccToolRenderers } from "../lib/tui-render.ts";
import { PERMISSION_STATUS_CHANNEL, type PermissionStatus } from "../permissions/modes.ts";
import { buildPlanModeReminder } from "./reminder.ts";
import { randomSlug } from "./slug.ts";
import { clampOffset, decodeViewerKey, type PlanChoice, renderPlanViewer, wrapPlanText } from "./viewer.ts";

export const MODE_CHANNEL = "pincer:set-permission-mode";
/** Announces plan mode's one writable file; the permissions matcher consumes it. */
export const PLAN_FILE_CHANNEL = "pincer:plan-file-path";
/** Session entry type persisting the allocated path across resume/branch. */
const PLAN_FILE_ENTRY = "plan-mode-file";

const PLANS_DIR = () => join(pincerStateDir(), "plans");

export default function planModeExtension(pi: ExtensionAPI) {
	let currentMode = "default";
	let planFilePath: string | undefined;

	/** Restore the branch's plan file, else allocate a fresh slug. */
	const ensurePlanFile = (ctx: ExtensionContext): string => {
		if (planFilePath) return planFilePath;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== PLAN_FILE_ENTRY) continue;
			const path = (entry.data as { path?: unknown } | undefined)?.path;
			if (typeof path === "string") planFilePath = path;
		}
		if (planFilePath) return planFilePath;

		let path = join(PLANS_DIR(), `${randomSlug()}.md`);
		for (let attempt = 0; attempt < 5 && existsSync(path); attempt++) {
			path = join(PLANS_DIR(), `${randomSlug()}.md`);
		}
		planFilePath = path;
		pi.appendEntry(PLAN_FILE_ENTRY, { path });
		return path;
	};

	/** Re-announce path + reminder; every-turn re-emits replace by key. */
	const refresh = (ctx: ExtensionContext) => {
		const path = ensurePlanFile(ctx);
		pi.events.emit(PLAN_FILE_CHANNEL, { path });
		pi.events.emit(REMINDER_CHANNEL, {
			text: buildPlanModeReminder({ filePath: path, fileExists: existsSync(path) }),
			scope: "every-turn",
			key: "permission-mode",
		});
	};

	pi.events.on(PERMISSION_STATUS_CHANNEL, (data) => {
		const status = data as PermissionStatus;
		if (typeof status?.mode === "string") currentMode = status.mode;
	});

	pi.on("before_agent_start", (_event, ctx) => {
		if (currentMode === "plan") refresh(ctx);
	});

	pi.registerTool({
		name: "enter_plan_mode",
		label: "Enter plan mode",
		...ccToolRenderers("Enter plan mode"),
		description:
			"Enter plan mode for tasks that need investigation and design before changing anything. In plan mode only read-only tools are available, plus one writable file: the plan file whose path you are told, where you build the plan incrementally. Use for non-trivial multi-file work; skip it for simple direct changes.",
		promptSnippet: "Switch to read-only planning before non-trivial changes",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			pi.events.emit(MODE_CHANNEL, { mode: "plan" });
			// setMode fires synchronously over the status channel, so currentMode
			// is already "plan"; announce the file in the tool result too so the
			// model can start writing this same turn.
			const path = ensurePlanFile(ctx);
			refresh(ctx);
			return {
				content: [
					{
						type: "text",
						text: `Entered plan mode. Only read-only tools are available, except for your plan file at ${path} — build your plan there incrementally, then call exit_plan_mode to request approval.`,
					},
				],
				details: { planFilePath: path },
			};
		},
	});

	pi.registerTool({
		name: "exit_plan_mode",
		label: "Exit plan mode",
		...ccToolRenderers("Exit plan mode"),
		description:
			"Signal that planning is complete and ask the user to approve the plan. Takes no parameters: the plan is read from the plan file named in the plan-mode reminder, which you must have written before calling this. The user reviews that file's contents.",
		promptSnippet: "Present your plan file for user approval",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			// Guard the out-of-sequence call: without this, a cold exit_plan_mode
			// (never entered plan mode) allocates a fresh empty plan file and blames
			// "the plan file is empty" — a plausible but wrong cause a weak model
			// then chases. The real fix is to enter plan mode first.
			if (currentMode !== "plan") {
				return {
					content: [
						{
							type: "text",
							text: "Not in plan mode, so there is no plan to approve. Call enter_plan_mode first, build the plan in the file it names, then call exit_plan_mode.",
						},
					],
					details: {},
					isError: true,
				};
			}
			const path = ensurePlanFile(ctx);
			const plan = existsSync(path) ? readFileSync(path, "utf8") : "";
			if (!plan.trim()) {
				return {
					content: [
						{
							type: "text",
							text: `No plan to approve: ${path} is missing or empty. Write your plan there first, then call exit_plan_mode again.`,
						},
					],
					details: { planFilePath: path },
					isError: true,
				};
			}

			if (!ctx.hasUI) {
				pi.events.emit(MODE_CHANNEL, { mode: "default" });
				return {
					content: [
						{ type: "text", text: "Non-interactive session: plan recorded and plan mode exited. Proceed." },
					],
					details: { plan, approved: true },
				};
			}

			const choice = await ctx.ui.custom<PlanChoice | null>((tui, theme, _keybindings, done) => {
				const paint = (color: string, text: string) => {
					const themed = theme as { fg?(c: string, t: string): string } | undefined;
					try {
						return themed?.fg ? themed.fg(color, text) : text;
					} catch {
						return text;
					}
				};
				const maxVisible = 12;
				let offset = 0;
				let selected: PlanChoice = 0;
				let lineCount = 0;
				return {
					render: (width: number) => {
						const lines = wrapPlanText(plan, Math.max(10, width - 1));
						lineCount = lines.length;
						offset = clampOffset(offset, lineCount, maxVisible);
						return renderPlanViewer({ lines, offset, choice: selected, maxVisible }, paint, width);
					},
					handleInput: (data: string) => {
						const key = decodeViewerKey(data, maxVisible);
						if (!key) return;
						if (key.kind === "cancel") return done(null);
						if (key.kind === "confirm") return done(selected);
						if (key.kind === "pick") return done(key.index);
						if (key.kind === "scroll") offset = clampOffset(offset + key.delta, lineCount, maxVisible);
						else if (key.kind === "choice") selected = (((selected + key.delta) % 3) + 3) % 3 as PlanChoice;
						tui.requestRender();
					},
					invalidate: () => {},
				};
			});

			if (choice === 0 || choice === 1) {
				pi.events.emit(MODE_CHANNEL, { mode: choice === 1 ? "acceptEdits" : "default" });
				return {
					content: [
						{
							type: "text",
							text: `Plan approved by the user. You may now implement it. The approved plan stays at ${path} for reference.`,
						},
					],
					details: { plan, approved: true },
				};
			}

			return {
				content: [
					{
						type: "text",
						text: "The user did not approve the plan. Stay in plan mode; refine the plan file based on their feedback.",
					},
				],
				details: { plan, approved: false },
			};
		},
	});
}
