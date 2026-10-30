import type { RyuJsonValue } from "@ryu/app-host/json-values";
import { z } from "zod";

/** Arguments forwarded unchanged to the selected MCP tool. */
export interface MppToolArguments {
	[key: string]: RyuJsonValue;
}

export const paymentPolicySchema = z.object({
	allowedOrigins: z.array(z.string()),
	approvalThresholdAtomic: z.string(),
	autoPay: z.boolean(),
	dailySpendCapAtomic: z.string(),
	enabledMethods: z.tuple([z.literal("tempo")]),
	maxPerRequestAtomic: z.string(),
	testnetOnly: z.literal(true),
	version: z.literal(1),
});
export const budgetSnapshotSchema = z.object({
	availableAtomic: z.string(),
	dailyCapAtomic: z.string(),
	pendingAtomic: z.string(),
	spentAtomic: z.string(),
});
export const walletStatusSchema = z.object({
	address: z.string().nullable(),
	balanceAtomic: z.string(),
	configured: z.boolean(),
	currency: z.string(),
	decimals: z.number(),
	network: z.string(),
});
export const statusSchema = z.object({
	budget: budgetSnapshotSchema,
	policy: paymentPolicySchema,
	wallet: walletStatusSchema,
});
export const serviceSchema = z.object({
	categories: z.array(z.string()),
	description: z.string(),
	endpoints: z.array(
		z.object({
			method: z.string(),
			path: z.string(),
			price: z.string().optional(),
		})
	),
	id: z.string(),
	name: z.string(),
	status: z.string().optional(),
	url: z.string(),
});
export const normalizedChallengeSchema = z.object({
	amountAtomic: z.string(),
	chainId: z.number(),
	challengeHash: z.string(),
	challengeId: z.string(),
	currency: z.string(),
	decimals: z.number(),
	description: z.string().optional(),
	digest: z.string().optional(),
	expiresAt: z.string().optional(),
	intent: z.string(),
	method: z.literal("tempo"),
	origin: z.string(),
	payee: z.string(),
	realm: z.string(),
});
export const preparedPaymentSchema = z.object({
	approvalToken: z.string(),
	budget: budgetSnapshotSchema,
	challenge: normalizedChallengeSchema,
	expiresAt: z.string(),
	request: z.union([
		z.object({
			method: z.string(),
			transport: z.literal("http"),
			url: z.string(),
		}),
		z.object({
			tool: z.string(),
			transport: z.literal("mcp"),
			url: z.string(),
		}),
	]),
	requiresApproval: z.boolean(),
});
export const receiptSchema = z.object({
	amountAtomic: z.string(),
	chainId: z.number(),
	challengeId: z.string(),
	currency: z.string(),
	id: z.string(),
	method: z.string(),
	origin: z.string(),
	payee: z.string(),
	reference: z.string(),
	status: z.literal("success"),
	timestamp: z.string(),
});
export interface PaymentHeaders {
	[key: string]: string;
}
export const paymentHeadersSchema = z.custom<PaymentHeaders>((value) => {
	if (!z.record(z.string(), z.string()).safeParse(value).success) {
		return false;
	}
	const own = Object.getOwnPropertyDescriptor(value, "__proto__");
	return !own || z.string().safeParse(own.value).success;
});
export const paidResourceSchema = z.object({
	body: z.string(),
	contentType: z.string().nullable(),
	headers: paymentHeadersSchema,
	status: z.number(),
});
export const preparationSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("payment_required"),
		payment: preparedPaymentSchema,
	}),
	z.object({ kind: z.literal("ready"), resource: paidResourceSchema }),
]);
export const paymentResultSchema = z.object({
	receipt: receiptSchema,
	resource: paidResourceSchema,
});
export const walletResponseSchema = z.object({ wallet: walletStatusSchema });
export const policyResponseSchema = z.object({ policy: paymentPolicySchema });
export const servicesResponseSchema = z.object({
	services: z.array(serviceSchema),
});
export const receiptsResponseSchema = z.object({
	receipts: z.array(receiptSchema),
});
export const persistedPaymentStateSchema = z.object({
	policy: paymentPolicySchema.optional(),
	wallet: walletStatusSchema.optional(),
	receipts: z.array(receiptSchema).optional(),
});

/** Validate the complete endpoint contract while retaining the host's object and metadata. */
export function preservePaymentResponse<T>(schema: z.ZodType<T>): z.ZodType<T> {
	return z.custom<T>((value) => schema.safeParse(value).success);
}

export interface HttpPrepareInput {
	method: string;
	url: string;
}
export interface McpPrepareInput {
	arguments: MppToolArguments;
	tool: string;
	url: string;
}
export type PaymentRequestBody =
	| z.output<typeof paymentPolicySchema>
	| HttpPrepareInput
	| McpPrepareInput
	| { approvalToken: string }
	| Record<string, never>;
export type PaymentBridgeResponse =
	| z.output<typeof statusSchema>
	| z.output<typeof walletResponseSchema>
	| z.output<typeof policyResponseSchema>
	| z.output<typeof servicesResponseSchema>
	| z.output<typeof receiptsResponseSchema>
	| z.output<typeof preparationSchema>
	| z.output<typeof paymentResultSchema>;
export type PersistedPaymentState = z.output<
	typeof persistedPaymentStateSchema
>;
