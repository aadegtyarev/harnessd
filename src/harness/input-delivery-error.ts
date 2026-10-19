import type { InputFailure, InputId } from "../core/types.js";

/** English detail of a user-canceled input (journal/fallback text; presentation uses the reason code). */
export const INPUT_CANCELED_DETAIL = "Input canceled";

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

/**
 * Definite non-delivery: Pi rejected the input, or harnessd never sent it (a held
 * input that timed out, was cancelled, or outlived Pi). The input event stream has
 * already reported the failure with the same safe detail and reason code.
 */
export class InputNotDeliveredError extends Error {
	readonly code = "INPUT_NOT_DELIVERED";
	constructor(
		readonly inputId: InputId,
		detail: string,
		readonly failure: InputFailure,
	) {
		super(detail);
		this.name = "InputNotDeliveredError";
	}
}
