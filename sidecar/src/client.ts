import { Challenge, Credential, Receipt } from "mppx";
import { Fetch, Mppx, tempo } from "mppx/client";
import {
	callMcpTool,
	type McpSession,
	validateMcpPaymentRequest,
} from "./mcp.ts";
import { createGovernedFetch } from "./network.ts";
import { decidePayment } from "./policy.ts";
import type { PaymentStore } from "./store.ts";
import {
	AppError,
	type McpPaymentRequestInput,
	type NormalizedChallenge,
	type PaidResource,
	type PaymentPreparation,
	type PaymentRequestInput,
	type PaymentResult,
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

async function readResource(response: Response): Promise<PaidResource> {
	return {
		body: await response.text(),
		contentType: response.headers.get("content-type"),
		headers: safeResponseHeaders(response.headers),
		status: response.status,
	};
}

function requestInit(request: PaymentRequestInput): RequestInit {
	return {
		...(request.body === undefined ? {} : { body: request.body }),
		...(request.headers === undefined ? {} : { headers: request.headers }),
		method: request.method,
	};
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
	readonly #fetch: typeof fetch;
	readonly #pending = new Map<string, PendingPayment>();
	readonly #store: PaymentStore;
	readonly #wallet: MppWallet;

	constructor(
		store: PaymentStore,
		wallet: MppWallet,
		governedFetch?: typeof fetch
	) {
		this.#store = store;
		this.#wallet = wallet;
		this.#fetch =
			governedFetch ?? createGovernedFetch(() => this.#store.getPolicy());
	}

	async prepare(rawInput: unknown): Promise<PaymentPreparation> {
		const request = validatePaymentRequest(rawInput);
		const inspectFetch = Fetch.from({
			fetch: this.#fetch,
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
			this.#pending.set(sha256(approvalToken), {
				challenge,
				expiresAtMs,
				idempotencyKey: deriveIdempotencyKey(request, challenge),
				kind: "http",
				request,
				wireChallenge: error.challenge,
			});
			return {
				kind: "payment_required",
				payment: {
					approvalToken,
					budget: decision.budget,
					challenge,
					expiresAt: new Date(expiresAtMs).toISOString(),
					request: {
						method: request.method,
						transport: "http",
						url: request.url,
					},
					requiresApproval: decision.kind === "approval_required",
				},
			};
		}
	}

	async prepareMcp(rawInput: unknown): Promise<PaymentPreparation> {
		const request = validateMcpPaymentRequest(rawInput);
		const outcome = await callMcpTool(this.#fetch, request);
		if (outcome.kind === "result") {
			return {
				kind: "ready",
				resource: {
					body: JSON.stringify(outcome.result),
					contentType: "application/json",
					headers: {},
					status: 200,
				},
			};
		}

		const challenge = normalizeChallenge(outcome.challenge, request.url);
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
		this.#pending.set(sha256(approvalToken), {
			challenge,
			expiresAtMs,
			idempotencyKey: deriveMcpIdempotencyKey(request, challenge),
			kind: "mcp",
			request,
			session: outcome.session,
			wireChallenge: outcome.challenge,
		});
		return {
			kind: "payment_required",
			payment: {
				approvalToken,
				budget: decision.budget,
				challenge,
				expiresAt: new Date(expiresAtMs).toISOString(),
				request: { tool: request.tool, transport: "mcp", url: request.url },
				requiresApproval: decision.kind === "approval_required",
			},
		};
	}

	async pay(approvalToken: unknown): Promise<PaymentResult> {
		if (
			typeof approvalToken !== "string" ||
			approvalToken.length < 32 ||
			approvalToken.length > 128
		) {
			throw new AppError(
				"invalid_approval_token",
				"Approval token is invalid."
			);
		}
		const tokenHash = sha256(approvalToken);
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
		const paymentClient = Mppx.create({
			fetch: this.#fetch,
			maxPaymentRetries: 1,
			methods: [
				tempo.charge({
					account,
					expectedChainId: TEMPO_TESTNET_CHAIN_ID,
					expectedRecipients: [pending.challenge.payee as `0x${string}`],
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
			const credential = await paymentClient.createCredential(
				new Response(null, {
					headers: {
						"www-authenticate": Challenge.serialize(pending.wireChallenge),
					},
					status: 402,
				})
			);
			if (pending.kind === "mcp") {
				const outcome = await callMcpTool(
					this.#fetch,
					pending.request,
					Credential.deserialize(credential) as unknown as Record<
						string,
						unknown
					>,
					pending.session
				);
				if (outcome.kind === "payment_required") {
					const current = normalizeChallenge(
						outcome.challenge,
						pending.request.url
					);
					if (current.challengeHash !== pending.challenge.challengeHash) {
						throw new AppError(
							"challenge_changed",
							"Payment challenge changed after approval. Review the new challenge before paying.",
							409
						);
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
				return {
					receipt,
					resource: {
						body: JSON.stringify(outcome.result),
						contentType: "application/json",
						headers: {},
						status: 200,
					},
				};
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
						throw new AppError(
							"challenge_changed",
							"Payment challenge changed after approval. Review the new challenge before paying.",
							409
						);
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
			if (reservationId) {
				this.#store.release(reservationId);
			}
			throw error;
		}
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
