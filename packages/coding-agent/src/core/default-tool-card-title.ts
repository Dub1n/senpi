import type { Component, DensityCardKind, DensityCardStatus } from "@earendil-works/pi-tui";
import { type ToolCardIconOverrides, toolCardIconOverride } from "./tool-card-icons.ts";

export type DefaultToolCardIconQuery = {
	readonly kind?: DensityCardKind;
	readonly glyph?: string;
	readonly status?: DensityCardStatus;
};

type ResolveIcon = (query?: DefaultToolCardIconQuery) => string | undefined;
type DefaultToolCardPresentation = {
	readonly icon: ResolveIcon;
	readonly resultDetails: unknown;
};

// Only stock renderers opt in; the public ToolRenderContext and custom components are unchanged.
const presentations = new WeakMap<object, DefaultToolCardPresentation>();
const componentTitles = new WeakMap<Component, (overrides: ToolCardIconOverrides | undefined) => void>();

/** Let a stock component update just the title it owns when Default overrides change. */
export function registerDefaultToolCardTitle(
	component: Component,
	query: DefaultToolCardIconQuery,
	update: (icon: string | undefined) => void,
): void {
	let applied: string | undefined;
	componentTitles.set(component, (overrides) => {
		const icon = toolCardIconOverride(overrides, query.kind, query.glyph ?? "✓", query.status);
		if (applied === icon) return;
		applied = icon;
		update(icon);
	});
}

export function applyDefaultToolCardIconOverrides(
	component: Component | undefined,
	overrides: ToolCardIconOverrides | undefined,
): void {
	if (component !== undefined) componentTitles.get(component)?.(overrides);
}

export function setDefaultToolCardPresentation(context: object, presentation: DefaultToolCardPresentation): void {
	presentations.set(context, presentation);
}

export function defaultToolCardIcon(
	context: object | undefined,
	query?: DefaultToolCardIconQuery | ((resultDetails: unknown) => DefaultToolCardIconQuery),
): string | undefined {
	const presentation = context === undefined ? undefined : presentations.get(context);
	return presentation?.icon(typeof query === "function" ? query(presentation.resultDetails) : query);
}

export function prefixToolCardTitle(title: string, icon: string | undefined): string {
	return icon === undefined ? title : `${icon} ${title}`;
}

export function defaultToolCardTitle(
	title: string,
	context: object | undefined,
	query?: Parameters<typeof defaultToolCardIcon>[1],
): string {
	return prefixToolCardTitle(title, defaultToolCardIcon(context, query));
}
