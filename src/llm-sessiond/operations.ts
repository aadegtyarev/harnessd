import { LlmSessiondHttpOperations } from "./http-operations.js";
import {
	harnessesSchema,
	healthSchema,
	inputResponseSchema,
	sessionResponseSchema,
	sessionsSchema,
} from "./schemas.js";
import type {
	HarnessesResponse,
	HealthResponse,
	InputResponse,
	SessionCreate,
	SessionInput,
	SessionResponse,
	SessionsResponse,
} from "./types.js";

export class LlmSessiondOperations extends LlmSessiondHttpOperations {
	health(): Promise<HealthResponse> {
		return this.get("/health", healthSchema);
	}
	harnesses(): Promise<HarnessesResponse> {
		return this.get("/harnesses", harnessesSchema);
	}
	listSessions(): Promise<SessionsResponse> {
		return this.get("/sessions", sessionsSchema);
	}
	getSession(id: string): Promise<SessionResponse> {
		return this.get(
			`/sessions/${encodeURIComponent(id)}`,
			sessionResponseSchema,
		);
	}
	createSession(input: SessionCreate): Promise<SessionResponse> {
		return this.post("/sessions", input, 201, sessionResponseSchema);
	}
	submitInput(id: string, input: SessionInput): Promise<InputResponse> {
		return this.post(
			`/sessions/${encodeURIComponent(id)}/inputs`,
			input,
			202,
			inputResponseSchema,
		);
	}
	cancelInput(id: string, inputId: string): Promise<void> {
		return this.postVoid(`/sessions/${encodeURIComponent(id)}/cancel`, {
			inputId,
		});
	}
	stopSession(id: string): Promise<void> {
		return this.postVoid(`/sessions/${encodeURIComponent(id)}/stop`, {});
	}
	resumeSession(id: string): Promise<void> {
		return this.postVoid(`/sessions/${encodeURIComponent(id)}/resume`, {});
	}
}
