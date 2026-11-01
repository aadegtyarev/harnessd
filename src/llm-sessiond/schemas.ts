import { z } from "zod";

export const sessionStatusSchema = z.enum([
	"starting",
	"running",
	"stopped",
	"failed",
	"uncertain",
]);
export const failureSchema = z.strictObject({
	code: z.enum([
		"PI_STARTUP_FAILED",
		"PI_RESUME_FAILED",
		"PI_PROCESS_EXITED",
		"PI_MALFORMED_JSON",
	]),
	at: z.string().datetime(),
});
export const sessionSchema = z.strictObject({
	id: z.string().uuid(),
	name: z.string().optional(),
	harnessId: z.literal("pi"),
	cwd: z.string(),
	status: sessionStatusSchema,
	nativeSessionId: z.string().optional(),
	failure: failureSchema.optional(),
});
export const healthSchema = z.strictObject({
	apiVersion: z.literal("v1"),
	status: z.literal("ready"),
	version: z.string(),
});
export const harnessesSchema = z.strictObject({
	harnesses: z.array(
		z.strictObject({
			id: z.string(),
			label: z.string(),
			capabilities: z.array(z.string()),
		}),
	),
});
export const sessionsSchema = z.strictObject({
	sessions: z.array(sessionSchema),
});
export const sessionResponseSchema = z.strictObject({ session: sessionSchema });
export const inputResponseSchema = z.strictObject({
	inputId: z.string().uuid(),
});
export const apiErrorSchema = z.strictObject({
	error: z.strictObject({
		code: z.enum([
			"INVALID_CWD",
			"INVALID_JSON",
			"INVALID_PATH",
			"VALIDATION_ERROR",
			"NOT_FOUND",
			"INPUT_BUSY",
			"INPUT_UNCERTAIN",
			"INPUT_FAILED",
			"INPUT_NOT_CURRENT",
			"CANCEL_FAILED",
			"SESSION_NOT_RUNNING",
			"SESSION_NOT_RESUMABLE",
			"RESUME_FAILED",
			"LIMIT_EXCEEDED",
			"INTERNAL_ERROR",
		]),
		message: z.string(),
	}),
});
