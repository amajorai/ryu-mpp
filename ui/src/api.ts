import type { z } from "zod";
import type { McpPrepareInput, PaymentRequestBody } from "./schemas.ts";
import {
	paymentResultSchema,
	policyResponseSchema,
	preparationSchema,
	preservePaymentResponse,
	receiptsResponseSchema,
	servicesResponseSchema,
	statusSchema,
	walletResponseSchema,
} from "./schemas.ts";
import type {
	PaymentPolicy,
	PaymentResult,
	Preparation,
	Receipt,
	Service,
	Status,
	WalletStatus,
} from "./types.ts";

function bridge() {
	if (!window.ryu?.app?.request) {
		throw new Error("This Ryu build does not provide the app HTTP bridge.");
	}
	return window.ryu.app;
}

async function request<T>(
	schema: z.ZodType<T>,
	method: "GET" | "POST" | "PUT",
	path: string,
	body?: PaymentRequestBody
): Promise<T> {
	const input: import("./ryu.d.ts").AppRequestInput = { method, path };
	if (body !== undefined) {
		input.body = body;
	}
	return preservePaymentResponse(schema).parse(await bridge().request(input));
}

export const getStatus = (): Promise<Status> =>
	request(statusSchema, "GET", "/status");
export const createWallet = async (): Promise<WalletStatus> =>
	(await request(walletResponseSchema, "POST", "/wallet/create", {})).wallet;
export const fundWallet = async (): Promise<WalletStatus> =>
	(await request(walletResponseSchema, "POST", "/wallet/fund", {})).wallet;
export const savePolicy = async (
	policy: PaymentPolicy
): Promise<PaymentPolicy> =>
	(await request(policyResponseSchema, "PUT", "/policy", policy)).policy;
export const listServices = async (): Promise<Service[]> =>
	(await request(servicesResponseSchema, "GET", "/services")).services;
export const listReceipts = async (): Promise<Receipt[]> =>
	(await request(receiptsResponseSchema, "GET", "/receipts")).receipts;
export const preparePayment = (input: {
	method: string;
	url: string;
}): Promise<Preparation> =>
	request(preparationSchema, "POST", "/payments/prepare", input);
export const prepareMcpPayment = (
	input: McpPrepareInput
): Promise<Preparation> =>
	request(preparationSchema, "POST", "/payments/prepare-mcp", input);
export const pay = (approvalToken: string): Promise<PaymentResult> =>
	request(paymentResultSchema, "POST", "/payments/pay", { approvalToken });
