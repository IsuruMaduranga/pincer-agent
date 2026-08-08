/**
 * worktree extension — Claude Code's EnterWorktree/ExitWorktree.
 *
 * enter_worktree creates (or switches into) a git worktree under
 * `.claude/worktrees/` and "moves" the session there. pi fixes a session's cwd
 * at creation, so the move is enforced on the tool_call hook: bash commands
 * are prefixed with `cd`, relative paths resolve against the worktree (see
 * rewrite.ts), and an every-turn reminder keeps the model oriented. State
 * rides in tool-result details so a resumed or branched session restores it.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFER_CHANNEL } from "../lib/deferred.ts";
import { REMINDER_CHANNEL } from "../lib/reminders.ts";
import { rewriteToolInput, validateWorktreeName } from "./rewrite.ts";
import { ccToolRenderers } from "../lib/tui-render.ts";

const run = promisify(execFile);
const REMINDER_KEY = "cc-worktree-session";

interface WorktreeState {
	path: string;
	branch?: string;
	baseCommit?: string;
	createdByUs: boolean;
	originalCwd: string;
}

interface WorktreeDetails {
	/** null = session exited the worktree; undefined = tool did not change state. */
	worktreeState?: WorktreeState | null;
}

async function git(args: string[], cwd: string): Promise<string> {
	const { stdout } = await run("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
	return stdout.trim();
}

async function listWorktreePaths(cwd: string): Promise<string[]> {
	const out = await git(["worktree", "list", "--porcelain"], cwd);
	return out
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length));
}

export default function worktreeExtension(pi: ExtensionAPI) {
	let state: WorktreeState | undefined;

	const reminderFor = (s: WorktreeState) =>
		`Worktree session active: you are working in the git worktree at ${s.path}` +
		`${s.branch ? ` (branch ${s.branch})` : ""}, not in ${s.originalCwd}. ` +
		"Relative paths and bash commands already run there. Use exit_worktree to leave when the user asks.";

	const applyState = (next: WorktreeState | undefined) => {
		state = next;
		if (next) {
			pi.events.emit(REMINDER_CHANNEL, { text: reminderFor(next), scope: "every-turn", key: REMINDER_KEY });
		} else {
			pi.events.emit(REMINDER_CHANNEL, { key: REMINDER_KEY, remove: true });
		}
	};

	const reconstructState = (ctx: ExtensionContext) => {
		let restored: WorktreeState | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || !["enter_worktree", "exit_worktree"].includes(msg.toolName ?? "")) continue;
			const details = msg.details as WorktreeDetails | undefined;
			if (details?.worktreeState !== undefined) restored = details.worktreeState ?? undefined;
		}
		if (restored && !existsSync(restored.path)) restored = undefined;
		applyState(restored);
	};

	pi.on("session_start", (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", (_event, ctx) => reconstructState(ctx));

	pi.on("tool_call", (event) => {
		if (!state) return;
		if (["enter_worktree", "exit_worktree", "subagent", "send_message", "workflow"].includes(event.toolName)) return;
		rewriteToolInput(event.toolName, event.input as Record<string, unknown>, state.path);
	});

	pi.registerTool({
		name: "enter_worktree",
		label: "Enter Worktree",
		...ccToolRenderers("Enter Worktree"),
		description:
			"Create an isolated git worktree under .claude/worktrees/ (branched from the current HEAD) and switch this session into it — subsequent commands and relative paths run there. Use ONLY when the user or project instructions explicitly ask for a worktree. Pass `name` to name the new worktree, or `path` to switch into an existing worktree instead (mutually exclusive). Leave with exit_worktree.",
		parameters: Type.Object({
			name: Type.Optional(
				Type.String({ description: "Name for a new worktree (segments of letters/digits/._-, max 64 chars). Random if omitted" }),
			),
			path: Type.Optional(Type.String({ description: "Existing worktree (from `git worktree list`) to switch into instead of creating one" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} as WorktreeDetails, isError: true });

			if (params.name && params.path) return fail("Pass either `name` or `path`, not both.");
			// An empty `path` string is falsy, so without this it would fall through
			// to *creating* a new worktree instead of reporting the bad argument —
			// the mirror of the empty-`name` case, which is already rejected below.
			if (params.path !== undefined && params.path.length === 0) {
				return fail("`path` was empty — pass an existing worktree path from `git worktree list`, or omit `path` to create a new worktree.");
			}

			let repoRoot: string;
			try {
				repoRoot = await git(["rev-parse", "--show-toplevel"], ctx.cwd);
			} catch {
				return fail("enter_worktree needs a git repository; this directory is not one.");
			}

			if (params.path) {
				const known = await listWorktreePaths(ctx.cwd);
				const target = known.find((p) => p === params.path);
				if (!target) return fail(`${params.path} is not a worktree of this repository. Known worktrees:\n${known.join("\n")}`);
				const next: WorktreeState = { path: target, createdByUs: false, originalCwd: ctx.cwd };
				applyState(next);
				return {
					content: [{ type: "text", text: `Switched into existing worktree ${target}. All work now happens there; exit_worktree returns to ${ctx.cwd}.` }],
					details: { worktreeState: next } satisfies WorktreeDetails,
				};
			}

			// Any active worktree session blocks creating another — not just ones we
			// created. A session entered via `path` has createdByUs:false, and
			// without gating on `state` alone a create-new call silently abandoned it.
			if (state) {
				return fail(`Already in a worktree session (${state.path}). exit_worktree first, or switch with \`path\` to another worktree.`);
			}

			const name = params.name ?? `wt-${randomBytes(3).toString("hex")}`;
			const nameError = validateWorktreeName(name);
			if (nameError) return fail(`Invalid worktree name "${name}": ${nameError}`);

			const worktreesDir = join(repoRoot, ".claude", "worktrees");
			mkdirSync(worktreesDir, { recursive: true });
			// Self-ignoring directory: worktrees never show up as untracked files.
			const ignorePath = join(worktreesDir, ".gitignore");
			if (!existsSync(ignorePath)) writeFileSync(ignorePath, "*\n");

			const path = join(worktreesDir, name);
			if (existsSync(path)) return fail(`Worktree ${path} already exists — pass it as \`path\` to switch into it.`);

			const branch = name.replace(/\//g, "-");
			let baseCommit: string;
			try {
				baseCommit = await git(["rev-parse", "HEAD"], ctx.cwd);
				await git(["worktree", "add", "-b", branch, path, "HEAD"], repoRoot);
			} catch (error) {
				return fail(`Could not create worktree: ${(error as Error).message}`);
			}

			const next: WorktreeState = { path, branch, baseCommit, createdByUs: true, originalCwd: ctx.cwd };
			applyState(next);
			return {
				content: [
					{
						type: "text",
						text: `Created worktree ${path} on branch ${branch} (from HEAD ${baseCommit.slice(0, 8)}). All commands and relative paths now run there; exit_worktree returns to ${ctx.cwd}.`,
					},
				],
				details: { worktreeState: next } satisfies WorktreeDetails,
			};
		},
	});

	pi.registerTool({
		name: "exit_worktree",
		label: "Exit Worktree",
		...ccToolRenderers("Exit Worktree"),
		description:
			'End the worktree session started by enter_worktree and return to the original directory. action: "keep" leaves the worktree and branch on disk; "remove" deletes both — refused (listing the changes) if there are uncommitted files or commits not on the original branch, unless discard_changes is true. No-op when no worktree session is active.',
		parameters: Type.Object({
			action: StringEnum(["keep", "remove"] as const, { description: '"keep" preserves the worktree on disk; "remove" deletes it and its branch' }),
			discard_changes: Type.Optional(Type.Boolean({ description: "Required true to remove a worktree with uncommitted files or unmerged commits" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state) {
				return {
					content: [{ type: "text", text: "No worktree session is active; nothing to exit." }],
					details: {} satisfies WorktreeDetails,
				};
			}
			const current = state;

			if (params.action === "keep") {
				applyState(undefined);
				return {
					content: [
						{
							type: "text",
							text: `Left worktree session; back in ${current.originalCwd}. The worktree remains at ${current.path}${current.branch ? ` (branch ${current.branch})` : ""} — re-enter it with enter_worktree {path}.`,
						},
					],
					details: { worktreeState: null } satisfies WorktreeDetails,
				};
			}

			if (!current.createdByUs) {
				return {
					content: [
						{ type: "text", text: `This worktree (${current.path}) was not created by enter_worktree in this session — exit with action: "keep" and remove it manually if intended.` },
					],
					details: {} satisfies WorktreeDetails,
					isError: true,
				};
			}

			if (!params.discard_changes) {
				const blockers: string[] = [];
				try {
					const dirty = await git(["status", "--porcelain"], current.path);
					if (dirty) blockers.push(`Uncommitted changes:\n${dirty}`);
					if (current.baseCommit && current.branch) {
						const ahead = await git(["rev-list", "--count", `${current.baseCommit}..${current.branch}`], current.path);
						if (ahead !== "0") blockers.push(`${ahead} commit(s) on ${current.branch} not on the original branch.`);
					}
				} catch {
					blockers.push("Could not verify the worktree is clean.");
				}
				if (blockers.length > 0) {
					return {
						content: [
							{
								type: "text",
								text: `Refusing to remove ${current.path}:\n\n${blockers.join("\n\n")}\n\nConfirm with the user, then re-invoke with discard_changes: true — or exit with action: "keep".`,
							},
						],
						details: {} satisfies WorktreeDetails,
						isError: true,
					};
				}
			}

			try {
				await git(["worktree", "remove", "--force", current.path], current.originalCwd);
				if (current.branch) await git(["branch", "-D", current.branch], current.originalCwd);
			} catch (error) {
				return {
					content: [{ type: "text", text: `Could not remove the worktree: ${(error as Error).message}` }],
					details: {} satisfies WorktreeDetails,
					isError: true,
				};
			}
			applyState(undefined);
			return {
				content: [{ type: "text", text: `Removed worktree ${current.path}${current.branch ? ` and branch ${current.branch}` : ""}; back in ${current.originalCwd}.` }],
				details: { worktreeState: null } satisfies WorktreeDetails,
			};
		},
	});

	for (const [name, keywords] of Object.entries({
		enter_worktree: ["worktree", "isolate", "branch", "checkout"],
		exit_worktree: ["worktree", "leave", "return", "cleanup"],
	})) {
		pi.events.emit(DEFER_CHANNEL, { name, keywords });
	}
}
