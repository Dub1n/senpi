import { getCapabilities, setCapabilities, type ImageProtocol } from "@earendil-works/pi-tui";
import type { explorationSurface } from "./exploration-surface-harness.ts";

type ReadImageSurface = Awaited<ReturnType<typeof explorationSurface>>;

export const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

/** Set deterministic image support for one UI test and return its capability cleanup. */
export function withImageProtocol(images: ImageProtocol): () => void {
	const previous = getCapabilities();
	setCapabilities({ ...previous, images, kittyUnicodePlaceholders: false });
	return () => setCapabilities(previous);
}

/** Append a completed Read result containing the core image note and its image payload. */
export async function runReadImage(
	surface: ReadImageSurface,
	input: { readonly id: string; readonly path: string; readonly isError?: boolean },
): Promise<void> {
	await surface.event({
		type: "tool_execution_start",
		toolCallId: input.id,
		toolName: "read",
		args: { path: input.path },
	});
	await surface.event({
		type: "tool_execution_end",
		toolCallId: input.id,
		toolName: "read",
		result: {
			content: [
				{ type: "text", text: "Read image file [image/png]" },
				{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
			],
		},
		isError: input.isError ?? false,
	});
}
