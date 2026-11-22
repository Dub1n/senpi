/** Independently authored Grouped eval rows at the widths the replay contract covers. */
export const evalDensityGolden = {
	wide: {
		width: 80,
		folded: " ╶─ ✓ Review the changed eval density renderer through session replay",
		expanded: [
			" ╭─ ✓ Review the changed eval density renderer through session replay",
			" │ eval js · 1 call · 1.82 calls/s · (bun 1.4.4, /opt/bun/bin/omo) · <1s",
			" │ print(result.text);",
			" ├─ output",
			" │ M viewer.ts",
			" ├─ commands",
			" │ $ git status --short",
			" │ ✓ <1s",
			" │ M viewer.ts",
			" ╰─",
		],
	},
	narrow: {
		width: 44,
		folded: " ╶─ ✓ Review the changed eval density ren…",
		expanded: [
			" ╭─ ✓ Review the changed eval density rende…",
			" │ eval js · 1 call · 1.82 calls/s · (bun",
			" │ 1.4.4, /opt/bun/bin/omo) · <1s",
			" │ print(result.text);",
			" ├─ output",
			" │ M viewer.ts",
			" ├─ commands",
			" │ $ git status --short",
			" │ ✓ <1s",
			" │ M viewer.ts",
			" ╰─",
		],
	},
} as const;
