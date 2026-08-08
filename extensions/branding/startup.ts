/**
 * Compact startup sections for the banner: Context, Skills, Themes.
 *
 * pi's own startup listing has no per-section switch — hiding the noisy
 * [Extensions] block (20 internal module names) means `quietStartup: true`,
 * which hides everything. So when quiet startup is on, the banner shows its
 * own compact versions of the sections that ARE useful. pi's resourceLoader
 * is not exposed to extensions, so these are re-derived the same way our
 * other extensions derive them (claude-compat's skill dirs, pi's git-root
 * context walk); pi-only extras such as ~/.pi/agent/skills are included for
 * parity.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { findGitRoot } from "../lib/git.ts";
import { discoverPlugins } from "../lib/plugins.ts";

export interface StartupSection {
	label: string;
	items: string[];
}

/** CLAUDE.md / CLAUDE.local.md / AGENTS.md from cwd up to the git root (or just cwd outside a repo). */
export function contextFileNames(cwd: string): string[] {
	const stop = findGitRoot(cwd) ?? cwd;
	const found: string[] = [];
	let dir = cwd;
	while (true) {
		for (const name of ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"]) {
			const path = join(dir, name);
			if (existsSync(path)) found.push(relative(cwd, path) || name);
		}
		if (dir === stop) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return found;
}

/**
 * Skills across the same sources our extensions feed to pi: project/user
 * Claude Code dirs, pi's own user dir, and installed plugins. An entry counts
 * when <dir>/<name>/SKILL.md exists — existsSync follows symlinked skill
 * directories, which readdir's isDirectory() would miss.
 */
export function skillNames(cwd: string, home: string): string[] {
	const dirs = [
		join(cwd, ".claude", "skills"),
		join(home, ".claude", "skills"),
		join(home, ".pi", "agent", "skills"),
	];
	const names = new Set<string>();
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		try {
			for (const entry of readdirSync(dir)) {
				if (existsSync(join(dir, entry, "SKILL.md"))) names.add(entry);
			}
		} catch {
			// Unreadable dir: skip, same as pi would.
		}
	}
	for (const skill of discoverPlugins(join(home, ".claude")).skills) {
		names.add(skill.name);
	}
	return [...names].sort((a, b) => a.localeCompare(b));
}

/** Saved workflow names from the Claude Code layout dirs (project shadows user). */
export function workflowNames(cwd: string, home: string): string[] {
	const names = new Set<string>();
	for (const dir of [join(cwd, ".claude", "workflows"), join(home, ".claude", "workflows")]) {
		if (!existsSync(dir)) continue;
		try {
			for (const entry of readdirSync(dir)) {
				if (entry.endsWith(".js") || entry.endsWith(".mjs")) names.add(entry.replace(/\.(js|mjs)$/, ""));
			}
		} catch {
			// Unreadable dir: skip, same as pi would.
		}
	}
	return [...names].sort((a, b) => a.localeCompare(b));
}

/** Theme names bundled with this package. */
export function themeNames(packageThemesDir: string): string[] {
	try {
		return readdirSync(packageThemesDir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => basename(f, ".json"))
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}

/**
 * Whether pincer should default thinking blocks to collapsed (the Claude Code
 * look: a one-line label, expanded on demand). Only when the user has never
 * chosen: a `hideThinkingBlock` key in pi's global settings — written by
 * ctrl+t, /settings, or a previous run of this default — is their decision and
 * is never overridden. An unreadable settings file means "don't touch it".
 */
export function shouldDefaultHideThinking(settingsRaw: string | undefined): boolean {
	if (settingsRaw === undefined) return true;
	try {
		const settings = JSON.parse(settingsRaw);
		return !(settings && typeof settings === "object" && "hideThinkingBlock" in settings);
	} catch {
		return false;
	}
}

/** True when pi's own startup listing is silenced, so ours should render instead. */
export function quietStartupEnabled(piSettingsPath: string): boolean {
	try {
		const settings = JSON.parse(readFileSync(piSettingsPath, "utf8"));
		return settings?.quietStartup === true;
	} catch {
		return false;
	}
}

export function collectStartupSections(cwd: string, home: string, packageThemesDir: string): StartupSection[] {
	const sections: StartupSection[] = [
		{ label: "context", items: contextFileNames(cwd) },
		{ label: "skills", items: skillNames(cwd, home) },
		{ label: "workflows", items: workflowNames(cwd, home) },
		{ label: "themes", items: themeNames(packageThemesDir) },
	];
	return sections.filter((s) => s.items.length > 0);
}
