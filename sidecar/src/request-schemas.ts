import { z } from "zod";
import { TEMPO_TESTNET_CHAIN_ID } from "./types.ts";

export const atomicAmountSchema = z.string().regex(/^(0|[1-9]\d*)$/);
export const paymentMethodSchema = z.enum([
	"DELETE",
	"GET",
	"HEAD",
	"PATCH",
	"POST",
	"PUT",
]);
const rawHeaderTextSchema = z.string().nullable().catch(null);
const paymentHeaderEntriesSchema = z
	.custom<object>(
		(value) =>
			z.record(z.string(), rawHeaderTextSchema).safeParse(value).success
	)
	.transform((value) =>
		Object.entries(value).map(([name, value]) => ({
			name,
			value: rawHeaderTextSchema.parse(value),
		}))
	);

/** Decode each raw field without changing the validator's ordered errors. */
export const paymentRequestCandidateSchema = z.object({
	method: z.string().catch(""),
	url: z.string().nullable().catch(null),
	body: z.string().optional().nullable().catch(null),
	headers: paymentHeaderEntriesSchema.optional().nullable().catch(null),
	idempotencyKey: z.string().optional().nullable().catch(null),
});
export const paymentIdempotencyKeySchema = z
	.string()
	.regex(/^[A-Za-z0-9._:-]{8,128}$/);
export const challengeCurrencySchema = z.string();
export const challengePayeeSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
export const tempoChallengeDetailsSchema = z.object({
	chainId: z.literal(TEMPO_TESTNET_CHAIN_ID).nullable().catch(null),
});

/** JSON serialization values, including native overflow and absent array entries. */
export type CanonicalPaymentValue =
	| null
	| undefined
	| boolean
	| number
	| string
	| CanonicalPaymentValue[]
	| CanonicalPaymentDocument;
export interface CanonicalPaymentDocument {
	[key: string]: CanonicalPaymentValue;
}
export const canonicalPaymentNumberSchema = z.custom<number>(
	(value) =>
		z.number().safeParse(value).success ||
		value === Number.POSITIVE_INFINITY ||
		value === Number.NEGATIVE_INFINITY ||
		Object.is(value, Number.NaN)
);
export const canonicalPaymentScalarSchema = z.union([
	z.null(),
	z.undefined(),
	z.boolean(),
	canonicalPaymentNumberSchema,
	z.string(),
]);
export const canonicalPaymentValueSchema: z.ZodType<CanonicalPaymentValue> =
	z.lazy(() =>
		z.union([
			canonicalPaymentScalarSchema,
			z.array(canonicalPaymentValueSchema),
			canonicalPaymentDocumentSchema,
		])
	);
export const canonicalPaymentDocumentSchema =
	z.custom<CanonicalPaymentDocument>((value) => {
		if (
			!z.record(z.string(), canonicalPaymentValueSchema).safeParse(value)
				.success
		) {
			return false;
		}
		const own = Object.getOwnPropertyDescriptor(value, "__proto__");
		return !own || canonicalPaymentValueSchema.safeParse(own.value).success;
	});

export const policyCandidateSchema = z.object({
	version: z.literal(1).nullable().catch(null),
	testnetOnly: z.literal(true).nullable().catch(null),
	enabledMethods: z
		.tuple([z.literal("tempo")])
		.nullable()
		.catch(null),
	allowedOrigins: z
		.array(z.string().nullable().catch(null))
		.max(64)
		.nullable()
		.catch(null),
	maxPerRequestAtomic: z.string().nullable().catch(null),
	dailySpendCapAtomic: z.string().nullable().catch(null),
	approvalThresholdAtomic: z.string().nullable().catch(null),
	autoPay: z.boolean().nullable().catch(null),
});

export const approvalTokenSchema = z.string().min(32).max(128);
export const challengeAddressSchema = z.custom<import("viem").Address>(
	(value) => challengePayeeSchema.safeParse(value).success
);

// Native text decoding guarantees the complete nested JSON value grammar.
const decodedPaymentValueSchema = z.custom<CanonicalPaymentValue>(
	(value) =>
		canonicalPaymentScalarSchema.safeParse(value).success ||
		Array.isArray(value) ||
		z.object({}).safeParse(value).success
);
export const nativePaymentJsonSourceSchema = z
	.string()
	.transform((source) => JSON.parse(source))
	.pipe(decodedPaymentValueSchema);
export const mppReplayMarkerSchema = z.object({
	type: z.literal("mppx:replay"),
	expires: canonicalPaymentNumberSchema,
});
