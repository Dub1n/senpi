export const width = 64;
export const densities = ["compact", "grouped"] as const;
export type Density = (typeof densities)[number];

// The unpainted spacer is empty; all rows inside the card occupy the full width.
function cardRows(...body: readonly string[]): readonly string[] {
	return ["", ...["", ...body, ""].map((row) => row.padEnd(width))];
}

// Compact retains the assistant's leading transcript spacer before the card.
function compactSearchRows(...body: readonly string[]): readonly string[] {
	return ["", ...cardRows(...body)];
}

export const todoGolden = {
	init: {
		folded: cardRows(" ╶─ + todo • init (1 phase, 2 tasks)"),
		expanded: cardRows(
			" ╭─ + todo • init (1 phase, 2 tasks)",
			" │ I. Verification",
			" │   [•] Verify the runtime",
			" │   [ ] Record the result",
			" ╰─",
		),
	},
	done: {
		folded: cardRows(" ╶─ ✓ todo • Verify the runtime"),
		expanded: cardRows(
			" ╭─ ✓ todo • Verify the runtime",
			" │ I. Verification",
			" │   [✓] Verify the runtime",
			" │   [•] Record the result",
			" ╰─",
		),
	},
	failure: {
		folded: cardRows(" ╶─ ✗ todo • Verify the runtime"),
		expanded: cardRows(" ╭─ ✗ todo • Verify the runtime", ' │ Errors: Task "Verify the runtime" not found', " ╰─"),
	},
} as const;

export const readGolden = {
	folded: cardRows(" ╶─ ✓ read • dev-window.mjs"),
	expanded: cardRows(" ╭─ ✓ read • scripts/dev-window.mjs:40-42", " │ ", " │     const ready = true;", " ╰─"),
} as const;

export const searchGolden = {
	completed: {
		compact: compactSearchRows(" ╶─ ✓ search chatgpt-subscription • web_search", "    status: completed"),
		grouped: cardRows(" ╶─ ✓ search chatgpt-subscription • web_search"),
	},
	failed: {
		compact: compactSearchRows(" ╶─ ✗ search chatgpt-subscription • web_search", "    status: failed"),
		grouped: cardRows(" ╶─ ✗ search chatgpt-subscription • web_search"),
	},
	unfamiliar: {
		compact: compactSearchRows(" ╶─ search chatgpt-subscription • web_search", "    status: awaiting_index"),
		grouped: cardRows(" ╶─ search chatgpt-subscription • web_search · awaiting_index"),
	},
	absent: {
		compact: compactSearchRows(" ╶─ search chatgpt-subscription • web_search"),
		grouped: cardRows(" ╶─ search chatgpt-subscription • web_search"),
	},
};

const expandedSearch = [
	" ╭─ ✓ search chatgpt-subscription • web_search",
	" │ status: completed",
	" │ queries:",
	' │ - "terminal rows"',
	' │ - "render padding"',
	" │ 1 source",
	" │ Terminal guide https://example.test/guide",
	" │   A guide to rendering rows.",
	" ╰─",
] as const;

export const expandedSearchGolden = {
	compact: compactSearchRows(...expandedSearch),
	grouped: cardRows(...expandedSearch),
} as const;
