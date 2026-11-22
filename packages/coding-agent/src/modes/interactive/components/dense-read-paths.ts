import { basename, dirname, sep } from "node:path";
import { sanitizeTerminalLabel } from "@earendil-works/pi-tui";

/** Give each folded read the shortest path suffix that distinguishes it from other files in the run. */
export function denseReadPathLabels(members: readonly { readonly path: string; readonly skill?: string }[]): string[] {
	// A registered skill name is an opaque label (it can contain a slash), not another path to shorten.
	const components = members.map(({ path, skill }) => {
		if (skill === undefined) return path.split(sep);
		const directory = dirname(path);
		return [...(basename(directory) === skill ? dirname(directory) : directory).split(sep), skill];
	});
	const suffixes = new Map<string, Set<string>>();
	for (const [index, parts] of components.entries()) {
		const { path } = members[index];
		for (let length = 1; length <= parts.length; length++) {
			const suffix = parts.slice(-length).join(sep);
			const owners = suffixes.get(suffix);
			if (owners) owners.add(path);
			else suffixes.set(suffix, new Set([path]));
		}
	}
	return components.map((parts) => {
		for (let length = 1; length < parts.length; length++) {
			const suffix = parts.slice(-length).join(sep);
			if (suffixes.get(suffix)?.size === 1) return sanitizeTerminalLabel(suffix);
		}
		return sanitizeTerminalLabel(parts.join(sep));
	});
}
