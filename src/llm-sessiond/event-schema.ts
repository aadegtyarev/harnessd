import { z } from "zod";

const status = z.enum([
	"starting",
	"running",
	"stopped",
	"failed",
	"uncertain",
]);
const failure = z.strictObject({
	code: z.enum([
		"PI_STARTUP_FAILED",
		"PI_RESUME_FAILED",
		"PI_PROCESS_EXITED",
		"PI_MALFORMED_JSON",
	]),
	at: z.string().datetime(),
});
const activity = z.union([
	z.strictObject({ type: z.literal("agent_start") }),
	z.strictObject({ type: z.literal("agent_end") }),
	z.strictObject({ type: z.literal("agent_settled") }),
	z.strictObject({ type: z.literal("compaction_start") }),
	z.strictObject({ type: z.literal("compaction_end") }),
	z.strictObject({ type: z.literal("assistant_message_end") }),
	z.strictObject({ type: z.literal("thinking"), active: z.boolean() }),
	z.strictObject({
		type: z.literal("tool_start"),
		toolCallId: z.string(),
		toolName: z.string().optional(),
	}),
	z.strictObject({
		type: z.literal("tool_end"),
		toolCallId: z.string(),
		toolName: z.string().optional(),
		failed: z.boolean().optional(),
	}),
]);
export const eventSchema = z.strictObject({
	apiVersion: z.literal("v1"),
	eventId: z.number().int().positive(),
	sessionId: z.string().uuid(),
	at: z.string().datetime(),
	type: z.enum([
		"session.status",
		"input.state",
		"assistant.delta",
		"activity",
		"notification",
		"session.error",
		"turn.completed",
	]),
	data: z.unknown(),
});
export const eventPayloadSchemas = {
	"session.status": z.strictObject({ status, failure: failure.optional() }),
	"input.state": z.strictObject({
		inputId: z.string().uuid(),
		state: z.enum(["pending", "accepted", "completed", "failed", "uncertain"]),
		reason: z.string().optional(),
	}),
	"assistant.delta": z.strictObject({ text: z.string() }),
	activity,
	notification: z.strictObject({ text: z.string() }),
	"session.error": z.strictObject({ code: z.string() }),
	"turn.completed": z.strictObject({}),
};
