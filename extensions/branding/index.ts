/**
 * branding extension — replaces pi's startup header.
 *
 * pi's own banner ("pi v0.83.0 … Ask it how to use or extend Pi") comes from its
 * `piConfig`, which resolves from pi's *own* installed package.json and so cannot
 * be changed by a dependent package. But `ctx.ui.setHeader()` replaces the header
 * component outright, which gets us the same result without a fork.
 *
 * A pi-tui `Component` is small enough to implement inline — `render(width)` plus
 * a no-op `invalidate()` (we have no cached layout to drop) — so this needs no
 * new dependency on pi-tui.
 *
 * Set `CC_NO_BANNER=1` to keep pi's original header.
 */

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	PERMISSION_STATUS_CHANNEL,
	permissionModeDisplay,
	type PermissionStatus,
	shortModelName,
} from "../permissions/modes.ts";
import { SUBAGENT_STATUS_CHANNEL, type SubagentStatus } from "../subagents/model-select.ts";
import { collectStartupSections, quietStartupEnabled, shouldDefaultHideThinking, type StartupSection } from "./startup.ts";
import { truncateLine } from "../lib/tui-render.ts";

export { truncateLine };

const NAME = "pincer";

interface ThemeLike {
	fg(color: string, text: string): string;
}

export interface BannerInput {
	version: string;
	model?: string;
	cwd: string;
	mode: string;
	/** Effective subagent/workflow default with its selection source. */
	subagents?: string;
	/** Compact resource sections, shown when pi's own listing is silenced. */
	sections?: StartupSection[];
}

/**
 * Pixel π — our own mark, not a copy of anyone's mascot (Anthropic's branding
 * guidelines prohibit Claude Code-mimicking art; see docs/handoff.md). Half-block
 * characters pack two pixel rows per text row, so the glyph fits the banner's
 * three lines. All lines are the same width so the text column beside it aligns.
 */
export const LOGO_LINES = [
	"▀██▀▀▀▀██▀",
	" ██    ██ ",
	" ██    ██▄",
];

/**
 * One curated hint line, not a keymap dump: only the controls someone cannot
 * discover on their own — the dials this package renames or hides state behind
 * (effort, permission mode, collapsed thinking/output) plus the two input
 * prefixes and the opt-in keyword nobody could guess. Everything else lives in
 * pi's own /hotkeys listing, which the line points at.
 */
const HINTS: [key: string, what: string][] = [
	// First so it survives narrow terminals: the pointer to everything else.
	["/hotkeys", "all keys"],
	// pi calls this dial "thinking" and reserves shift+tab for it; we present
	// it as Claude Code's "effort" so the key and /effort agree on the name.
	["shift+tab", "effort"],
	// Claude Code cycles permission modes on shift+tab; pi owns that key, and
	// ctrl+q is the one ctrl+letter both pi and terminals leave free.
	["ctrl+q", "permissions"],
	["ctrl+t", "thinking"],
	["ctrl+o", "expand output"],
	["/", "commands"],
	["!", "bash"],
	// A keyword rather than a binding — an opt-in feature nobody knows the
	// word for is invisible.
	["ultracode", "max effort"],
];

/**
 * Keep only whole leading items that fit the budget (measured unpainted, so
 * ANSI codes don't count), rather than letting truncateLine cut mid-word.
 * Always keeps at least one item; truncateLine remains the backstop.
 */
export function fitItems<T>(items: T[], plainLength: (item: T) => number, budget: number | undefined, sepLength = 3): T[] {
	if (budget === undefined) return items;
	const kept: T[] = [];
	let used = 0;
	for (const item of items) {
		const extra = (kept.length ? sepLength : 0) + plainLength(item);
		if (kept.length > 0 && used + extra > budget) break;
		kept.push(item);
		used += extra;
	}
	return kept;
}

/**
 * Sections compressed to one line: context files and themes are few and short,
 * so their names carry information; skills/workflows lists are long and get
 * truncated into noise, so past three items they collapse to a count.
 */
export function sectionSummary(sections: StartupSection[], paint: (color: string, text: string) => string): string {
	return sections
		.filter((s) => s.items.length > 0)
		.map((s) =>
			s.items.length <= 3
				? `${paint("muted", s.label)} ${paint("dim", s.items.join(", "))}`
				: `${paint("muted", s.label)} ${paint("dim", String(s.items.length))}`,
		)
		.join(paint("muted", " · "));
}

/** Kept pure so the layout is unit-testable without a terminal. */
export function bannerLines(
	input: BannerInput,
	paint: (color: string, text: string) => string,
	width?: number,
): string[] {
	const logoWidth = Math.max(...LOGO_LINES.map((art) => [...art].length));
	const title = `${paint("accent", NAME)} ${paint("dim", `v${input.version}`)}`;
	const subtitle = paint("dim", "the Claude Code experience, on the pi harness");
	// Narrow terminals drop whole trailing hints (the /hotkeys pointer is
	// first, so it always survives) instead of cutting one mid-word.
	const hints = fitItems(HINTS, ([key, what]) => key.length + 1 + what.length, width === undefined ? undefined : width - logoWidth - 2)
		.map(([key, what]) => `${paint("accent", key)} ${paint("muted", what)}`)
		.join(paint("muted", " · "));

	const context = [
		input.model ? `${paint("muted", "model")} ${input.model}` : undefined,
		`${paint("muted", "mode")} ${input.mode}`,
		input.subagents ? `${paint("muted", "subagents")} ${input.subagents}` : undefined,
	]
		.filter(Boolean)
		.join(paint("muted", " · "));

	const sections = sectionSummary(input.sections ?? [], paint);

	const text = [`${title}  ${subtitle}`, context, hints, ...(sections ? [sections] : [])];
	const blankArt = " ".repeat(logoWidth);
	const assembled = text.map((line, i) => `${paint("accent", LOGO_LINES[i] ?? blankArt)}  ${line}`);
	return width === undefined ? assembled : assembled.map((line) => truncateLine(line, width));
}

/** Collapsed-thinking placeholder — pi paints it in thinkingText + italic. */
const THINKING_LABEL = "✻ Thinking… (ctrl+t to expand)";

/**
 * Default thinking blocks to collapsed, once, respecting any user choice.
 * pi caches settings in memory at startup, so a write here lands from the
 * *next* session; the current one keeps whatever the file said at launch
 * (ctrl+t still works immediately and persists the user's own preference).
 */
function applyThinkingDefault(): void {
	try {
		const agentDir = getAgentDir();
		const settingsPath = join(agentDir, "settings.json");
		const raw = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : undefined;
		if (shouldDefaultHideThinking(raw)) {
			SettingsManager.create(process.cwd(), agentDir).setHideThinkingBlock(true);
		}
	} catch {
		// Presentation-only default — never let a settings hiccup break startup.
	}
}

export default function brandingExtension(pi: ExtensionAPI) {
	applyThinkingDefault();
	// The label applies in every session; CC_NO_BANNER only disables the header.
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setHiddenThinkingLabel(THINKING_LABEL);
	});

	if (process.env.CC_NO_BANNER === "1") return;

	/**
	 * Mode and classifier arrive over the bus from the permissions extension
	 * (jiti isolates module state, so this cannot be a shared variable). The
	 * banner re-renders on every update, so cycling modes or the classifier
	 * pinning mid-session keeps the header truthful instead of frozen at
	 * whatever was true at startup.
	 */
	let permissionStatus: PermissionStatus | undefined;
	let subagentStatus: SubagentStatus | undefined;
	let currentModelId: string | undefined;
	let requestHeaderRender: (() => void) | undefined;
	// The model line goes stale the same way the mode line did once the header
	// re-renders live, so it follows ctrl+p / /model changes too.
	pi.on("model_select", (event) => {
		currentModelId = event.model?.id ?? currentModelId;
		requestHeaderRender?.();
	});
	pi.events.on(PERMISSION_STATUS_CHANNEL, (data) => {
		permissionStatus = data as PermissionStatus;
		requestHeaderRender?.();
	});
	pi.events.on(SUBAGENT_STATUS_CHANNEL, (data) => {
		subagentStatus = data as SubagentStatus;
		requestHeaderRender?.();
	});

	pi.on("session_start", (_event, ctx) => {
		// Only the TUI has a header to replace; rpc/print modes have no chrome.
		if (!ctx.hasUI || ctx.mode !== "tui") return;

		const version = process.env.CC_VERSION ?? "0.1.0";
		currentModelId = ctx.model ? `${ctx.model.id}` : currentModelId;

		// With pi's own listing silenced, the banner carries compact sections
		// instead (minus the internal [Extensions] noise).
		const home = os.homedir();
		const sections = quietStartupEnabled(join(home, ".pi", "agent", "settings.json"))
			? collectStartupSections(ctx.cwd, home, join(dirname(fileURLToPath(import.meta.url)), "..", "..", "themes"))
			: undefined;

		ctx.ui.setTitle(NAME);
		ctx.ui.setHeader((tui: unknown, theme: unknown) => {
			const paint = (color: string, text: string) => {
				const themed = theme as ThemeLike | undefined;
				try {
					return themed?.fg ? themed.fg(color, text) : text;
				} catch {
					return text;
				}
			};
			requestHeaderRender = () => {
				(tui as { requestRender?: () => void } | undefined)?.requestRender?.();
			};
			return {
				// Rendered per paint rather than precomputed, so the mode line
				// follows ctrl+q cycles and the classifier pinning.
				render: (width: number) => [
					"",
					...bannerLines(
						{
							version,
							model: currentModelId,
							cwd: ctx.cwd,
							mode: permissionModeDisplay(permissionStatus ?? { mode: "default", paused: false }),
							subagents: subagentStatus?.model
								? `${shortModelName(subagentStatus.model)}${subagentStatus.via ? ` (${subagentStatus.via})` : ""}`
								: undefined,
							sections,
						},
						paint,
						width,
					),
					"",
				],
				// Nothing is cached, so there is nothing to invalidate.
				invalidate: () => {},
			};
		});
	});
}
