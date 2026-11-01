import type { ClientOptions } from "./http.js";
import { LlmSessiondOperations } from "./operations.js";
import { subscribe, type WebSocketFactory } from "./ws.js";
import type { Subscription } from "./ws-subscription.js";

export type LlmSessiondClientOptions = ClientOptions & {
	webSocketFactory?: WebSocketFactory;
};

export class LlmSessiondClient extends LlmSessiondOperations {
	private readonly socketFactory?: WebSocketFactory;
	constructor(options: LlmSessiondClientOptions) {
		super(options);
		this.socketFactory = options.webSocketFactory;
	}
	subscribe(sessionId?: string): Subscription {
		return subscribe(
			this.baseUrl,
			sessionId,
			this.socketFactory,
			this.timeoutMs,
		);
	}
}
