import { LlmSessiondProtocolError } from "./errors.js";
import { eventPayloadSchemas, eventSchema } from "./event-schema.js";
import type { EventEnvelope, EventPayload } from "./types.js";

export function parseEvent(text: string): EventEnvelope {
	let raw: unknown;
	try {
		raw = JSON.parse(text) as unknown;
	} catch {
		throw new LlmSessiondProtocolError(
			"json",
			"WebSocket message was not valid JSON",
		);
	}
	const envelope = eventSchema.safeParse(raw);
	if (!envelope.success)
		throw new LlmSessiondProtocolError(
			"schema",
			"WebSocket event envelope did not match API v1",
		);
	const payload = eventPayloadSchemas[envelope.data.type].safeParse(
		envelope.data.data,
	);
	if (!payload.success)
		throw new LlmSessiondProtocolError(
			"schema",
			"WebSocket event data did not match API v1",
		);
	return {
		...envelope.data,
		data: payload.data as EventPayload,
	} as EventEnvelope;
}
