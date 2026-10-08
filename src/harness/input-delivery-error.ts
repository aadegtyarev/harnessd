import type { InputId } from "../core/types.js";

export class UncertainInputDeliveryError extends Error {
	readonly code = "UNCERTAIN_INPUT_DELIVERY";
	constructor(
		readonly inputId: InputId,
		options?: ErrorOptions,
	) {
		super("Input delivery is uncertain", options);
		this.name = "UncertainInputDeliveryError";
	}
}
