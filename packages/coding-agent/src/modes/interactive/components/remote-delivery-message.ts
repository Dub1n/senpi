import type { TextContent } from "@earendil-works/pi-ai";
import {
	Box,
	type DensityCardText,
	type DensityCardView,
	Markdown,
	sanitizeTerminalLabel,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { prefixToolCardTitle, registerDefaultToolCardTitle } from "../../../core/default-tool-card-title.ts";
import {
	isSessionControlDeliveryDetails,
	type MessageRenderer,
	SESSION_CONTROL_DELIVERY_TYPE,
	type SessionControlRemoteOrigin,
	type SessionControlSender,
	sessionControlRemoteOriginOf,
	sessionControlSenderOf,
} from "../../../core/extensions/types.ts";
import { sharedMarkdownTheme, theme as interactiveTheme } from "../theme/theme.ts";
import type { CustomMessage } from "../../../core/messages.ts";

const INCOMING_GLYPH = "←";

/**
 * A message another session delivered renders as its own block - never as the user's own input, so
 * a reader always sees which text came from outside this terminal. A delivery that names its sender
 * shows one label line ("Sent by another agent · <name>") over the message as it was written; one
 * that does not keeps the generic heading over the text the model read. A delivery an RPC connection admitted for a
 * remote device leads with the device the engine stamped, before the sender that device's caller claimed.
 */
export const renderRemoteDelivery: MessageRenderer = (message, _options, theme) => {
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	const sender = sessionControlSenderOf(message.details);
	const isAgentDelivery = message.customType === SESSION_CONTROL_DELIVERY_TYPE && sender?.kind === "agent";
	const addTitle = (paint: (icon: string | undefined) => string): void => {
		const heading = new Text(paint(undefined), 0, 0);
		box.addChild(heading);
		if (isAgentDelivery) {
			registerDefaultToolCardTitle(box, { kind: "incoming-message", glyph: INCOMING_GLYPH }, (icon) =>
				heading.setText(paint(icon)),
			);
		}
	};
	const origin = sessionControlRemoteOriginOf(message.details);
	const shown = sender === undefined && origin === undefined ? undefined : displayTextOf(message.details);
	if (shown !== undefined) {
		if (origin !== undefined) {
			addTitle((icon) => theme.fg("dim", prefixToolCardTitle(originLabel(origin), icon)));
			if (sender !== undefined) box.addChild(new Text(theme.fg("dim", senderLabel(sender)), 0, 0));
		} else if (sender !== undefined) {
			addTitle((icon) => theme.fg("dim", prefixToolCardTitle(senderLabel(sender), icon)));
		}
		box.addChild(new Spacer(1));
		box.addChild(
			new Markdown(shown, 0, 0, sharedMarkdownTheme(), { color: (line) => theme.fg("customMessageText", line) }),
		);
		return box;
	}
	addTitle((icon) => {
		const label = theme.fg("customMessageLabel", theme.bold(prefixToolCardTitle("remote message", icon)));
		return `${label}${theme.fg("dim", ` · delivery ${deliveryIdOf(message.details)}`)}`;
	});
	box.addChild(new Spacer(1));
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter((part): part is TextContent => part.type === "text")
					.map((part) => part.text)
					.join("\n");
	box.addChild(
		new Markdown(text, 0, 0, sharedMarkdownTheme(), { color: (line) => theme.fg("customMessageText", line) }),
	);
	return box;
};

export function senderLabel(sender: SessionControlSender): string {
	switch (sender.kind) {
		case "agent":
			return sender.name === undefined || sender.name.trim() === ""
				? "Sent by another agent"
				: `Sent by another agent · ${sender.name}`;
		case "command_line":
			return "Sent from the command line";
		case "external":
			return sender.author === undefined || sender.author.trim() === ""
				? `Sent from ${sender.platform}`
				: `Sent from ${sender.platform} · ${sender.author}`;
	}
}

/** Project only a typed agent delivery; other delivery origins keep their original rendering. */
export function agentDeliveryDensityCard(
	message: CustomMessage<unknown>,
	earlierModel?: string,
): DensityCardView | undefined {
	if (message.customType !== SESSION_CONTROL_DELIVERY_TYPE) return undefined;
	const sender = sessionControlSenderOf(message.details);
	if (sender?.kind !== "agent") return undefined;
	const origin = sessionControlRemoteOriginOf(message.details);
	const sessionId = sanitizeTerminalLabel(sender.session_id);
	const senderName = sanitizeTerminalLabel(sender.name ?? "") || `id: ${sessionId}`;
	const details: DensityCardText[] = [
		[{ text: senderName, role: "text" }],
		...(earlierModel ? [[{ text: sanitizeTerminalLabel(earlierModel), role: "dim" as const }]] : []),
		...(origin ? [[{ text: sanitizeTerminalLabel(originLabel(origin)), role: "text" as const }]] : []),
	];
	const body =
		displayTextOf(message.details) ??
		(typeof message.content === "string"
			? message.content
			: message.content
					.filter((part): part is TextContent => part.type === "text")
					.map((part) => part.text)
					.join("\n"));
	return {
		format: "structured",
		kind: "incoming-message",
		heading: { details },
		statusGlyph: INCOMING_GLYPH,
		body: [
			{ type: "text", lines: [`id: ${sessionId}`] },
			{
				type: "rich",
				render: (width) =>
					new Markdown(body, 0, 0, sharedMarkdownTheme(), {
						color: (line) => interactiveTheme.style(line, { fg: "dim", italic: true }),
					}).render(width),
			},
		],
		sections: [],
	};
}

function originLabel(origin: SessionControlRemoteOrigin): string {
	return `Relayed from device ${origin.deviceName ?? origin.deviceId}`;
}

export function builtInMessageRenderer(customType: string): MessageRenderer | undefined {
	return customType === SESSION_CONTROL_DELIVERY_TYPE ? renderRemoteDelivery : undefined;
}

function displayTextOf(details: unknown): string | undefined {
	return isSessionControlDeliveryDetails(details) && typeof details.display_text === "string"
		? details.display_text
		: undefined;
}

function deliveryIdOf(details: unknown): string {
	if (typeof details !== "object" || details === null || !("delivery_id" in details)) return "unknown";
	return typeof details.delivery_id === "string" ? details.delivery_id : "unknown";
}
