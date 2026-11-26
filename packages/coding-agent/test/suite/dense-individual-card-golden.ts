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
		compact: compactSearchRows(' ╶─ ✓ search • 1 source · "terminal rows"', "    status: completed"),
		grouped: cardRows(' ╶─ ✓ search • 1 source · "terminal rows"'),
	},
	failed: {
		compact: compactSearchRows(' ╶─ ✗ search • 1 source · "terminal rows"', "    status: failed"),
		grouped: cardRows(' ╶─ ✗ search • 1 source · "terminal rows"'),
	},
	unfamiliar: {
		compact: compactSearchRows(' ╶─ search • 1 source · "terminal rows"', "    status: awaiting_index"),
		grouped: cardRows(' ╶─ search • 1 source · "terminal rows" · awaiting_index'),
	},
	absent: {
		compact: compactSearchRows(' ╶─ search • 1 source · "terminal rows"'),
		grouped: cardRows(' ╶─ search • 1 source · "terminal rows"'),
	},
};

const expandedSearch = [
	' ╭─ ✓ search • 1 source · "terminal rows"',
	" │ chatgpt-subscription",
	" │ status: completed",
	' │ query: "render padding"',
	" │ Terminal guide https://example.test/guide",
	" │   A guide to rendering rows.",
	" ╰─",
] as const;

export const expandedSearchGolden = {
	compact: compactSearchRows(...expandedSearch),
	grouped: cardRows(...expandedSearch),
} as const;
