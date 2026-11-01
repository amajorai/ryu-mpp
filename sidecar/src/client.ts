import { Challenge, Credential, Receipt } from "mppx";
import { Fetch, Mppx, tempo } from "mppx/client";
import {
	callMcpTool,
	type McpSession,
	validateMcpPaymentRequest,
} from "./mcp.ts";
import { createGovernedFetch, type GovernedMppFetch } from "./network.ts";
import { decidePayment } from "./policy.ts";
import {
	approvalTokenSchema,
	challengeAddressSchema,
} from "./request-schemas.ts";
import type { PaymentStore } from "./store.ts";
import {
	AppError,
	type McpPaymentRequestInput,
	type NormalizedChallenge,
	type PaidResource,
	type PaymentPreparation,
	type PaymentRequestInput,
	type PaymentResult,
	type PreparedPayment,
	TEMPO_TESTNET_CHAIN_ID,
} from "./types.ts";
import {
	normalizeChallenge,
	randomToken,
	safeResponseHeaders,
	sha256,
	validatePaymentRequest,
} from "./validation.ts";
import type { MppWallet } from "./wallet.ts";

const APPROVAL_TTL_MS = 5 * 60_000;

function mppxFetch(fetcher: GovernedMppFetch): typeof fetch {
	// SAFETY: mppx 0.15.0 only invokes the standard fetch call signature; its Bun-specific preconnect declaration is unused. Native SDK signing and retry tests verify this boundary.
	return fetcher as typeof fetch;
}

interface PendingHttpPayment {
	challenge: NormalizedChallenge;
	expiresAtMs: number;
	idempotencyKey: string;
	kind: "http";
	request: PaymentRequestInput;
	wireChallenge: Challenge.Challenge;
}

interface PendingMcpPayment {
	challenge: NormalizedChallenge;
	expiresAtMs: number;
	idempotencyKey: string;
	kind: "mcp";
	request: McpPaymentRequestInput;
	session: McpSession;
	wireChallenge: Challenge.Challenge;
}

type PendingPayment = PendingHttpPayment | PendingMcpPayment;

class ChallengeCaptured extends Error {
	readonly challenge: Challenge.Challenge;

	constructor(challenge: Challenge.Challenge) {
		super("Payment challenge captured for policy review.");
		this.name = "ChallengeCaptured";
		this.challenge = challenge;
	}
}

function jsonResource(result: unknown): PaidResource {
	return {
		body: JSON.stringify(result),
		contentType: "application/json",
		headers: {},
		status: 200,
	};
}

function challengeChangedError(): AppError {
	return new AppError(
		"challenge_changed",
		"Payment challenge changed after approval. Review the new challenge before paying.",
		409
	);
}

async function readResource(response: Response): Promise<PaidResource> {
	return {
		body: await response.text(),
		contentType: response.headers.get("content-type"),
		headers: safeResponseHeaders(response.headers),
		status: response.status,
	};
}

function requestInit(request: PaymentRequestInput): RequestInit {
	const init: RequestInit = { method: request.method };
	if (request.body !== undefined) {
		init.body = request.body;
	}
	if (request.headers !== undefined) {
		init.headers = request.headers;
	}
	return init;
}

function approvalExpiry(challenge: NormalizedChallenge): number {
	const localExpiry = Date.now() + APPROVAL_TTL_MS;
	if (!challenge.expiresAt) {
		return localExpiry;
	}
	return Math.min(localExpiry, Date.parse(challenge.expiresAt));
}

function deriveIdempotencyKey(
	request: PaymentRequestInput,
	challenge: NormalizedChallenge
): string {
	if (request.idempotencyKey) {
		return request.idempotencyKey;
	}
	return sha256(
		[
			challenge.challengeHash,
			request.method,
			request.url,
			request.body ? sha256(request.body) : "",
		].join("|")
	);
}

function deriveMcpIdempotencyKey(
	request: McpPaymentRequestInput,
	challenge: NormalizedChallenge
): string {
	if (request.idempotencyKey) {
		return request.idempotencyKey;
	}
	return sha256(
		[
			challenge.challengeHash,
			request.url,
			request.tool,
			sha256(JSON.stringify(request.arguments)),
		].join("|")
	);
}

export class MppPaymentClient {
	readonly #fetch: GovernedMppFetch;
	readonly #pending = new Map<string, PendingPayment>();
	readonly #store: PaymentStore;
	readonly #wallet: MppWallet;

	constructor(
		store: PaymentStore,
		wallet: MppWallet,
		governedFetch?: GovernedMppFetch
	) {
		this.#store = store;
		this.#wallet = wallet;
		this.#fetch =
			governedFetch ?? createGovernedFetch(() => this.#store.getPolicy());
	}

	async prepare(
		rawInput: Parameters<typeof validatePaymentRequest>[0]
	): Promise<PaymentPreparation> {
		const request = validatePaymentRequest(rawInput);
		const inspectFetch = Fetch.from({
			fetch: mppxFetch(this.#fetch),
			maxPaymentRetries: 1,
			methods: [tempo.charge({ expectedChainId: TEMPO_TESTNET_CHAIN_ID })],
			onChallenge(challenge) {
				throw new ChallengeCaptured(challenge);
			},
		});

		try {
			const response = await inspectFetch(request.url, requestInit(request));
			return { kind: "ready", resource: await readResource(response) };
		} catch (error) {
			if (!(error instanceof ChallengeCaptured)) {
				throw error;
			}
			const challenge = normalizeChallenge(error.challenge, request.url);
			return this.#stagePayment(
				challenge,
				{ method: request.method, transport: "http", url: request.url },
				(expiresAtMs) => ({
					challenge,
					expiresAtMs,
					idempotencyKey: deriveIdempotencyKey(request, challenge),
					kind: "http",
					request,
					wireChallenge: error.challenge,
				})
			);
		}
	}

	async prepareMcp(
		rawInput: Parameters<typeof validateMcpPaymentRequest>[0]
	): Promise<PaymentPreparation> {
		const request = validateMcpPaymentRequest(rawInput);
		const outcome = await callMcpTool(this.#fetch, request);
		if (outcome.kind === "result") {
			return { kind: "ready", resource: jsonResource(outcome.result) };
		}

		const challenge = normalizeChallenge(outcome.challenge, request.url);
		return this.#stagePayment(
			challenge,
			{ tool: request.tool, transport: "mcp", url: request.url },
			(expiresAtMs) => ({
				challenge,
				expiresAtMs,
				idempotencyKey: deriveMcpIdempotencyKey(request, challenge),
				kind: "mcp",
				request,
				session: outcome.session,
				wireChallenge: outcome.challenge,
			})
		);
	}

	async pay(
		rawApprovalToken: Parameters<typeof approvalTokenSchema.parse>[0]
	): Promise<PaymentResult> {
		const approval = approvalTokenSchema.safeParse(rawApprovalToken);
		if (!approval.success) {
			throw new AppError(
				"invalid_approval_token",
				"Approval token is invalid."
			);
		}
		const tokenHash = sha256(approval.data);
		const pending = this.#pending.get(tokenHash);
		this.#pending.delete(tokenHash);
		if (!pending) {
			throw new AppError(
				"approval_not_found",
				"Approval is missing, expired, or already used.",
				409
			);
		}
		if (pending.expiresAtMs <= Date.now()) {
			throw new AppError(
				"approval_expired",
				"Approval expired before the payment was signed.",
				409
			);
		}

		const priorReceipt = this.#store.findReceiptByChallenge(
			pending.challenge.challengeHash
		);
		if (priorReceipt) {
			throw new AppError(
				"already_paid",
				`Payment was already settled as ${priorReceipt.id}.`,
				409
			);
		}

		const account = await this.#wallet.getAccount();
		let reservationId: string | null = null;
		// Once a signed credential has been handed to the remote service the money
		// may already be gone, whatever the response says. From that point a failure
		// must keep its reservation counted against the daily cap instead of freeing
		// it, or a service that takes payment and then errors could drain past it.
		let credentialSent = false;
		const paymentClient = Mppx.create({
			fetch: mppxFetch(this.#fetch),
			maxPaymentRetries: 1,
			methods: [
				tempo.charge({
					account,
					expectedChainId: TEMPO_TESTNET_CHAIN_ID,
					expectedRecipients: [
						challengeAddressSchema.parse(pending.challenge.payee),
					],
				}),
			],
			polyfill: false,
		});

		try {
			const policy = this.#store.getPolicy();
			const decision = decidePayment(
				policy,
				pending.challenge,
				this.#store.getBudget(policy)
			);
			if (decision.kind === "blocked") {
				throw new AppError("payment_blocked", decision.reason, 403);
			}
			const reservation = this.#store.reserve(
				pending.challenge,
				pending.idempotencyKey,
				policy
			);
			reservationId = reservation.id;
			// Tempo push mode can broadcast during credential creation, before this
			// method returns. Reserve durably before entering the payment SDK.
			this.#store.markSubmitted(reservationId);
			const credential = await paymentClient.createCredential(
				new Response(null, {
					headers: {
						"www-authenticate": Challenge.serialize(pending.wireChallenge),
					},
					status: 402,
				})
			);
			credentialSent = true;
			if (pending.kind === "mcp") {
				const outcome = await callMcpTool(
					this.#fetch,
					pending.request,
					Credential.deserialize(credential),
					pending.session
				);
				if (outcome.kind === "payment_required") {
					const current = normalizeChallenge(
						outcome.challenge,
						pending.request.url
					);
					if (current.challengeHash !== pending.challenge.challengeHash) {
						throw challengeChangedError();
					}
					throw new AppError(
						"payment_failed",
						"MCP server did not accept the approved payment.",
						409
					);
				}
				if (!outcome.receipt) {
					throw new AppError(
						"missing_receipt",
						"Paid MCP result did not include a receipt.",
						502
					);
				}
				const receipt = this.#store.commit(reservationId, pending.challenge, {
					method: outcome.receipt.method,
					reference: outcome.receipt.reference,
					status: "success",
					timestamp: outcome.receipt.timestamp,
				});
				return { receipt, resource: jsonResource(outcome.result) };
			}

			const init = requestInit(pending.request);
			const headers = new Headers(init.headers);
			headers.set("authorization", credential);
			const response = await this.#fetch(pending.request.url, {
				...init,
				headers,
			});
			if (response.status === 402) {
				const currentChallenge = Challenge.fromResponseList(response)[0];
				if (currentChallenge) {
					const current = normalizeChallenge(
						currentChallenge,
						pending.request.url
					);
					if (current.challengeHash !== pending.challenge.challengeHash) {
						throw challengeChangedError();
					}
				}
			}
			if (!response.ok) {
				throw new AppError(
					"payment_failed",
					`Paid request returned HTTP ${response.status}.`,
					response.status >= 500 ? 502 : 409
				);
			}
			const protocolReceipt = Receipt.fromResponse(response);
			const receipt = this.#store.commit(reservationId, pending.challenge, {
				method: protocolReceipt.method,
				reference: protocolReceipt.reference,
				status: "success",
				timestamp: protocolReceipt.timestamp,
			});
			return { receipt, resource: await readResource(response) };
		} catch (error) {
			if (reservationId && !credentialSent) {
				this.#store.release(reservationId);
			}
			throw error;
		}
	}

	/**
	 * Apply the spending policy to a captured challenge and, unless it is blocked
	 * or already expired, park the payment behind a single-use approval token.
	 */
	#stagePayment(
		challenge: NormalizedChallenge,
		request: PreparedPayment["request"],
		pendingPayment: (expiresAtMs: number) => PendingPayment
	): PaymentPreparation {
		const policy = this.#store.getPolicy();
		const decision = decidePayment(
			policy,
			challenge,
			this.#store.getBudget(policy)
		);
		if (decision.kind === "blocked") {
			throw new AppError("payment_blocked", decision.reason, 403);
		}
		const approvalToken = randomToken();
		const expiresAtMs = approvalExpiry(challenge);
		if (expiresAtMs <= Date.now()) {
			throw new AppError(
				"challenge_expired",
				"The payment challenge has expired.",
				409
			);
		}
		this.#prunePending();
		this.#pending.set(sha256(approvalToken), pendingPayment(expiresAtMs));
		return {
			kind: "payment_required",
			payment: {
				approvalToken,
				budget: decision.budget,
				challenge,
				expiresAt: new Date(expiresAtMs).toISOString(),
				request,
				requiresApproval: decision.kind === "approval_required",
			},
		};
	}

	#prunePending(): void {
		const now = Date.now();
		for (const [tokenHash, pending] of this.#pending) {
			if (pending.expiresAtMs <= now) {
				this.#pending.delete(tokenHash);
			}
		}
	}
}
