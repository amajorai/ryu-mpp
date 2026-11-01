import { createHash, randomBytes } from "node:crypto";
import { Challenge as ChallengeCodec } from "mppx";
import type { CanonicalPaymentValue } from "./request-schemas.ts";
import {
	atomicAmountSchema,
	canonicalPaymentDocumentSchema,
	canonicalPaymentScalarSchema,
	challengeCurrencySchema,
	challengePayeeSchema,
	paymentIdempotencyKeySchema,
	paymentMethodSchema,
	paymentRequestCandidateSchema,
	tempoChallengeDetailsSchema,
} from "./request-schemas.ts";

import {
	AppError,
	type NormalizedChallenge,
	PATH_USD_ADDRESS,
	PATH_USD_DECIMALS,
	type PaidResource,
	type PaymentRequestInput,
	TEMPO_TESTNET_CHAIN_ID,
} from "./types.ts";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_HEADER_VALUE_BYTES = 8 * 1024;
const ALLOWED_HEADERS = new Set(["accept", "content-type", "if-none-match"]);

export function parseAtomicAmount(
	value: Parameters<typeof atomicAmountSchema.parse>[0],
	field: string
): bigint {
	const amount = atomicAmountSchema.safeParse(value);
	if (!amount.success) {
		throw new AppError(
			"invalid_amount",
			`${field} must be a non-negative integer string.`
		);
	}
	return BigInt(amount.data);
}

export function formatAtomicAmount(
	value: string,
	decimals = PATH_USD_DECIMALS
): string {
	const atomic = parseAtomicAmount(value, "amount");
	const unit = 10n ** BigInt(decimals);
	const whole = atomic / unit;
	const fraction = (atomic % unit)
		.toString()
		.padStart(decimals, "0")
		.replace(/0+$/, "");
	return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
}

export function canonicalJson(
	value: CanonicalPaymentValue
): string | undefined {
	if (canonicalPaymentScalarSchema.safeParse(value).success) {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	}
	const record = canonicalPaymentDocumentSchema.parse(value);
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

export function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function randomToken(): string {
	return randomBytes(32).toString("base64url");
}

export function normalizeOrigin(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new AppError(
			"invalid_origin",
			"Origin must be a valid absolute URL."
		);
	}
	const insecureLoopbackAllowed =
		process.env.RYU_MPP_ALLOW_INSECURE_LOOPBACK === "1" &&
		url.protocol === "http:" &&
		(url.hostname === "127.0.0.1" ||
			url.hostname === "[::1]" ||
			url.hostname === "localhost");
	if (url.protocol !== "https:" && !insecureLoopbackAllowed) {
		throw new AppError(
			"insecure_origin",
			"Only HTTPS payment origins are allowed."
		);
	}
	if (url.username || url.password) {
		throw new AppError("invalid_origin", "Origins cannot contain credentials.");
	}
	return url.origin;
}

export function validatePaymentRequest(
	input: Parameters<typeof paymentRequestCandidateSchema.parse>[0]
): PaymentRequestInput {
	const parsed = paymentRequestCandidateSchema.safeParse(input);
	if (!parsed.success) {
		throw new AppError("invalid_request", "Payment request must be an object.");
	}
	const candidate = parsed.data;
	const method = paymentMethodSchema.safeParse(candidate.method.toUpperCase());
	if (!method.success) {
		throw new AppError("invalid_method", "Unsupported HTTP method.");
	}

	if (candidate.url === null || candidate.url.length > 4096) {
		throw new AppError("invalid_url", "A valid payment URL is required.");
	}
	let url: URL;
	try {
		url = new URL(candidate.url);
	} catch {
		throw new AppError("invalid_url", "A valid payment URL is required.");
	}
	normalizeOrigin(url.origin);
	if (url.hash || url.username || url.password) {
		throw new AppError(
			"invalid_url",
			"Payment URLs cannot contain fragments or credentials."
		);
	}

	let body: string | undefined;
	if (candidate.body !== undefined) {
		if (candidate.body === null) {
			throw new AppError("invalid_body", "Request body must be a string.");
		}
		if (new TextEncoder().encode(candidate.body).byteLength > MAX_BODY_BYTES) {
			throw new AppError(
				"body_too_large",
				"Request body exceeds 256 KiB.",
				413
			);
		}
		body = candidate.body;
	}

	let headers: Record<string, string> | undefined;
	if (candidate.headers !== undefined) {
		if (candidate.headers === null) {
			throw new AppError("invalid_headers", "Headers must be a string map.");
		}
		headers = {};
		for (const { name: rawName, value: rawValue } of candidate.headers) {
			const name = rawName.toLowerCase();
			if (!ALLOWED_HEADERS.has(name)) {
				throw new AppError(
					"header_not_allowed",
					`Header ${rawName} is not allowed.`
				);
			}
			if (rawValue === null || rawValue.length > MAX_HEADER_VALUE_BYTES) {
				throw new AppError("invalid_header", `Header ${rawName} is invalid.`);
			}
			if (/\r|\n/.test(rawValue)) {
				throw new AppError(
					"invalid_header",
					`Header ${rawName} contains forbidden characters.`
				);
			}
			headers[name] = rawValue;
		}
	}

	const idempotencyKey = candidate.idempotencyKey;
	if (
		idempotencyKey !== undefined &&
		!paymentIdempotencyKeySchema.safeParse(idempotencyKey).success
	) {
		throw new AppError(
			"invalid_idempotency_key",
			"Idempotency key format is invalid."
		);
	}

	const result: Omit<PaymentRequestInput, "method" | "url"> = {};
	if (body !== undefined) {
		result.body = body;
	}
	if (headers !== undefined) {
		result.headers = headers;
	}
	if (idempotencyKey !== undefined && idempotencyKey !== null) {
		result.idempotencyKey = idempotencyKey;
	}
	return { ...result, method: method.data, url: url.toString() };
}

export function normalizeChallenge(
	challenge: ChallengeCodec.Challenge,
	url: string
): NormalizedChallenge {
	if (challenge.method !== "tempo" || challenge.intent !== "charge") {
		throw new AppError(
			"unsupported_payment_method",
			"Only Tempo charge challenges are supported."
		);
	}
	const request = challenge.request;
	const amountAtomic = parseAtomicAmount(
		request.amount,
		"challenge amount"
	).toString();
	const currency = challengeCurrencySchema.safeParse(request.currency);
	if (!currency.success || currency.data.toLowerCase() !== PATH_USD_ADDRESS) {
		throw new AppError(
			"unsupported_currency",
			"Only pathUSD on Tempo testnet is supported."
		);
	}
	const payee = challengePayeeSchema.safeParse(request.recipient);
	if (!payee.success) {
		throw new AppError("invalid_payee", "Challenge payee is invalid.");
	}
	const details = tempoChallengeDetailsSchema.safeParse(request.methodDetails);
	if (!details.success) {
		throw new AppError(
			"invalid_challenge",
			"Tempo challenge is missing method details."
		);
	}
	const chainId = details.data.chainId;
	if (chainId !== TEMPO_TESTNET_CHAIN_ID) {
		throw new AppError(
			"unsupported_network",
			"Only Tempo testnet payments are supported."
		);
	}
	if (challenge.expires && Date.parse(challenge.expires) <= Date.now()) {
		throw new AppError(
			"challenge_expired",
			"The payment challenge has expired.",
			409
		);
	}
	const origin = new URL(url).origin;
	const challengeHash = sha256(ChallengeCodec.serialize(challenge));
	const result: Omit<
		NormalizedChallenge,
		"intent" | "method" | "origin" | "payee" | "realm"
	> = {
		amountAtomic,
		chainId,
		challengeHash,
		challengeId: challenge.id,
		currency: currency.data.toLowerCase(),
		decimals: PATH_USD_DECIMALS,
	};
	if (challenge.description) {
		result.description = challenge.description;
	}
	if (challenge.digest) {
		result.digest = challenge.digest;
	}
	if (challenge.expires) {
		result.expiresAt = challenge.expires;
	}
	return {
		...result,
		intent: challenge.intent,
		method: "tempo",
		origin,
		payee: payee.data.toLowerCase(),
		realm: challenge.realm,
	};
}

export function safeResponseHeaders(headers: Headers): PaidResource["headers"] {
	const safe = new Set([
		"content-language",
		"content-type",
		"etag",
		"last-modified",
	]);
	const output: Record<string, string> = {};
	for (const [name, value] of headers.entries()) {
		if (safe.has(name.toLowerCase())) {
			output[name.toLowerCase()] = value;
		}
	}
	return output;
}
