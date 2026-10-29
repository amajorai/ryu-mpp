import type { PersistedPaymentState } from "../src/schemas.ts";
import {
	paymentPolicySchema,
	persistedPaymentStateSchema,
	preservePaymentResponse,
} from "../src/schemas.ts";
import type { PaymentPolicy } from "../src/types.ts";

declare global {
	interface Window {
		__mppFixtureSchemas?: {
			readSaved(source: string): PersistedPaymentState;
			policy: typeof paymentPolicySchema.parse;
		};
	}
}

window.__mppFixtureSchemas = {
	readSaved(source) {
		return preservePaymentResponse(persistedPaymentStateSchema).parse(
			JSON.parse(source)
		);
	},
	policy(value): PaymentPolicy {
		return preservePaymentResponse(paymentPolicySchema).parse(value);
	},
};
