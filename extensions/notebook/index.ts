/**
 * notebook extension — Claude Code's NotebookEdit, deferred behind tool_search
 * (most sessions never touch a notebook, so its schema stays out of the prompt
 * until needed).
 */

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFER_CHANNEL } from "../lib/deferred.ts";
import { ccToolRenderers } from "../lib/tui-render.ts";
import { applyEdit, type EditMode, parseNotebook } from "./notebook.ts";

export default function notebookExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "notebook_edit",
		label: "Notebook Edit",
		...ccToolRenderers("Notebook Edit"),
		description:
			"Edit a Jupyter notebook (.ipynb): replace a cell's source, insert a new cell, or delete a cell. Cells are addressed by their `id`; read the notebook first to get ids. Editing a code cell clears its outputs.",
		parameters: Type.Object({
			path: Type.String({ description: "Absolute or workspace-relative path to the .ipynb file" }),
			edit_mode: StringEnum(["replace", "insert", "delete"] as const),
			cell_id: Type.Optional(
				Type.String({
					description:
						"Target cell id. Required for replace and delete; for insert the new cell goes after it (omit to insert at the top).",
				}),
			),
			new_source: Type.Optional(Type.String({ description: "New cell source. Required unless deleting." })),
			cell_type: Type.Optional(
				StringEnum(["code", "markdown"] as const, {
					description: "Cell type. Required when inserting; when replacing, changes the cell's type.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const path = isAbsolute(params.path) ? params.path : resolve(ctx.cwd, params.path);
			try {
				const notebook = parseNotebook(readFileSync(path, "utf-8"));
				const { notebook: updated, summary } = applyEdit(
					notebook,
					{
						cellId: params.cell_id,
						newSource: params.new_source,
						cellType: params.cell_type as "code" | "markdown" | undefined,
						editMode: params.edit_mode as EditMode,
					},
					() => randomUUID().slice(0, 8),
				);
				writeFileSync(path, `${JSON.stringify(updated, null, 1)}\n`);
				return {
					content: [{ type: "text", text: `${summary} in ${params.path} (${updated.cells.length} cells).` }],
					details: { path, cellCount: updated.cells.length },
				};
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				const hint =
					code === "ENOENT"
						? " — no such file; check the path points to an existing .ipynb"
						: error instanceof SyntaxError
							? " — the file is not valid notebook JSON"
							: "";
				return {
					content: [{ type: "text", text: `Notebook edit failed: ${(error as Error).message}${hint}` }],
					details: {},
					isError: true,
				};
			}
		},
	});

	pi.events.emit(DEFER_CHANNEL, { name: "notebook_edit", keywords: ["notebook", "jupyter", "ipynb", "cell"] });
}
