import { policyCandidateSchema } from "./request-schemas.ts";
import type {
	BudgetSnapshot,
	NormalizedChallenge,
	PaymentPolicy,
	PolicyDecision,
} from "./types.ts";
import { parseAtomicAmount } from "./validation.ts";

export const DEFAULT_POLICY: PaymentPolicy = {
	allowedOrigins: ["https://mpp.dev"],
	approvalThresholdAtomic: "0",
	autoPay: false,
	dailySpendCapAtomic: "5000000",
	enabledMethods: ["tempo"],
	maxPerRequestAtomic: "1000000",
	testnetOnly: true,
	version: 1,
};

export function validatePolicy(
	input: Parameters<typeof policyCandidateSchema.parse>[0]
): PaymentPolicy {
	const parsed = policyCandidateSchema.safeParse(input);
	if (!parsed.success) {
		throw new TypeError("Payment policy must be an object.");
	}
	const candidate = parsed.data;
	if (candidate.version !== 1 || candidate.testnetOnly !== true) {
		throw new TypeError("Only version 1 testnet-only policies are supported.");
	}
	if (candidate.enabledMethods === null) {
		throw new TypeError("Tempo must be the only enabled payment method.");
	}
	if (candidate.allowedOrigins === null) {
		throw new TypeError(
			"Allowed origins must be an array of at most 64 HTTPS origins."
		);
	}
	const allowedOrigins = candidate.allowedOrigins.map((origin) => {
		if (origin === null) {
			throw new TypeError("Allowed origins must be strings.");
		}
		const url = new URL(origin);
		if (url.protocol !== "https:" || url.origin !== origin) {
			throw new TypeError("Allowed origins must be normalized HTTPS origins.");
		}
		return origin;
	});
	const maxPerRequestAtomic = parseAtomicAmount(
		candidate.maxPerRequestAtomic,
		"maxPerRequestAtomic"
	).toString();
	const dailySpendCapAtomic = parseAtomicAmount(
		candidate.dailySpendCapAtomic,
		"dailySpendCapAtomic"
	).toString();
	const approvalThresholdAtomic = parseAtomicAmount(
		candidate.approvalThresholdAtomic,
		"approvalThresholdAtomic"
	).toString();
	if (BigInt(maxPerRequestAtomic) > BigInt(dailySpendCapAtomic)) {
		throw new TypeError("Per-request cap cannot exceed the daily cap.");
	}
	if (BigInt(approvalThresholdAtomic) > BigInt(maxPerRequestAtomic)) {
		throw new TypeError(
			"Approval threshold cannot exceed the per-request cap."
		);
	}
	if (candidate.autoPay === null) {
		throw new TypeError("autoPay must be a boolean.");
	}
	return {
		allowedOrigins: [...new Set(allowedOrigins)],
		approvalThresholdAtomic,
		autoPay: candidate.autoPay,
		dailySpendCapAtomic,
		enabledMethods: ["tempo"],
		maxPerRequestAtomic,
		testnetOnly: true,
		version: 1,
	};
}

export function decidePayment(
	policy: PaymentPolicy,
	challenge: NormalizedChallenge,
	budget: BudgetSnapshot
): PolicyDecision {
	const amount = BigInt(challenge.amountAtomic);
	if (!policy.allowedOrigins.includes(challenge.origin)) {
		return {
			budget,
			kind: "blocked",
			reason: "Origin is not on the payment allowlist.",
		};
	}
	if (!policy.enabledMethods.includes(challenge.method)) {
		return { budget, kind: "blocked", reason: "Payment method is disabled." };
	}
	if (amount > BigInt(policy.maxPerRequestAtomic)) {
		return {
			budget,
			kind: "blocked",
			reason: "Payment exceeds the per-request cap.",
		};
	}
	if (amount > BigInt(budget.availableAtomic)) {
		return {
			budget,
			kind: "blocked",
			reason: "Payment exceeds the remaining daily budget.",
		};
	}
	if (!policy.autoPay || amount > BigInt(policy.approvalThresholdAtomic)) {
		return {
			budget,
			kind: "approval_required",
			reason: "Explicit approval is required.",
		};
	}
	return { budget, kind: "allowed" };
}
