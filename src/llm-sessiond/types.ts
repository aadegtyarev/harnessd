import type { z } from "zod";
import type { eventPayloadSchemas, eventSchema } from "./event-schema.js";
import type {
	failureSchema,
	harnessesSchema,
	healthSchema,
	inputResponseSchema,
	sessionSchema,
	sessionsSchema,
} from "./schemas.js";

export type SessionSummary = z.infer<typeof sessionSchema>;
export type HealthResponse = z.infer<typeof healthSchema>;
export type HarnessesResponse = z.infer<typeof harnessesSchema>;
export type SessionsResponse = z.infer<typeof sessionsSchema>;
export type SessionResponse = { session: SessionSummary };
export type InputResponse = z.infer<typeof inputResponseSchema>;
export type SessionCreate = { harnessId: "pi"; cwd: string; name?: string };
export type SessionInput = {
	text: string;
	images?: { mimeType: string; data: string }[];
};
export type SessionFailure = z.infer<typeof failureSchema>;
export type EventEnvelope = z.infer<typeof eventSchema> & {
	data: EventPayload;
};
export type EventPayload = {
	[K in keyof typeof eventPayloadSchemas]: z.infer<
		(typeof eventPayloadSchemas)[K]
	>;
}[keyof typeof eventPayloadSchemas];
