import { afterEach, describe, expect, test } from "bun:test";
import { Challenge, Credential } from "mppx";

import { createPaidEndpoint, type PaidEndpoint } from "./paid-endpoint.ts";
import { PaymentStore } from "./store.ts";
import { PATH_USD_ADDRESS } from "./types.ts";
import { MemorySecretVault, MppWallet } from "./wallet.ts";

const DEMO_URL = "http://mpp.test/api/mpp/paid/demo";
const PAYMENT_REQUIRED = "https://paymentauth.org/problems/payment-required";
const INVALID_CHALLENGE = "https://paymentauth.org/problems/invalid-challenge";

const stores: PaymentStore[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) {
		store.close();
	}
});

async function makeEndpoint(): Promise<{
	endpoint: PaidEndpoint;
	wallet: MppWallet;
}> {
	// Unroutable RPC: none of these paths may reach the network.
	const wallet = new MppWallet(new MemorySecretVault(), "http://127.0.0.1:9");
	await wallet.create();
	const store = new PaymentStore(":memory:");
	stores.push(store);
	return { endpoint: await createPaidEndpoint(wallet, store), wallet };
}

async function problemType(response: Response): Promise<string> {
	const body = (await response.json()) as { type?: unknown };
	return String(body.type);
}

/** A syntactically valid credential whose echoed challenge was altered. */
function forgedCredential(issued: Response): string {
	const challenge = Challenge.fromResponse(issued);
	return Credential.serialize({
		challenge: {
			...challenge,
			request: { ...challenge.request, amount: "1" },
		},
		payload: { type: "hash", hash: `0x${"ab".repeat(32)}` },
	});
}

describe("paid demo endpoint", () => {
	test("refuses to start without a configured wallet", async () => {
		const wallet = new MppWallet(new MemorySecretVault(), "http://127.0.0.1:9");
		const store = new PaymentStore(":memory:");
		stores.push(store);
		await expect(createPaidEndpoint(wallet, store)).rejects.toMatchObject({
			code: "wallet_not_configured",
			status: 409,
		});
	});

	test("answers an unpaid request with a 402 challenge for the wallet", async () => {
		const { endpoint, wallet } = await makeEndpoint();
		const response = await endpoint(new Request(DEMO_URL));
		expect(response.status).toBe(402);
		expect(response.headers.get("www-authenticate")).toStartWith("Payment ");
		expect(await problemType(response.clone())).toBe(PAYMENT_REQUIRED);

		const challenge = Challenge.fromResponse(response);
		const account = await wallet.getAccount();
		expect(challenge.method).toBe("tempo");
		expect(challenge.intent).toBe("charge");
		expect(challenge.realm).toBe("Ryu MPP demo");
		expect(challenge.request).toMatchObject({
			amount: "10000",
			currency: PATH_USD_ADDRESS,
			recipient: account.address,
		});
		// The challenge is bound to this server's persisted secret.
		expect(
			Challenge.verify(challenge, { secretKey: await wallet.getServerSecret() })
		).toBe(true);
	});

	test("verifies a payment credential carried in the forwarded header", async () => {
		const { endpoint } = await makeEndpoint();
		const issued = await endpoint(new Request(DEMO_URL));
		const response = await endpoint(
			new Request(DEMO_URL, {
				headers: { "x-ryu-forwarded-authorization": forgedCredential(issued) },
			})
		);
		expect(response.status).toBe(402);
		expect(await problemType(response)).toBe(INVALID_CHALLENGE);
	});

	test("ignores a direct authorization header (Core's bearer hop)", async () => {
		const { endpoint } = await makeEndpoint();
		const issued = await endpoint(new Request(DEMO_URL));
		// The same forged credential sent directly is stripped, so the caller
		// just gets a fresh challenge rather than credential verification.
		const response = await endpoint(
			new Request(DEMO_URL, {
				headers: { authorization: forgedCredential(issued) },
			})
		);
		expect(response.status).toBe(402);
		expect(await problemType(response)).toBe(PAYMENT_REQUIRED);
	});

	test("rejects a challenge issued by another Ryu server", async () => {
		const first = await makeEndpoint();
		const second = await makeEndpoint();
		const issuedElsewhere = await second.endpoint(new Request(DEMO_URL));
		const challenge = Challenge.fromResponse(issuedElsewhere);
		const credential = Credential.serialize({
			challenge,
			payload: { type: "hash", hash: `0x${"cd".repeat(32)}` },
		});
		const response = await first.endpoint(
			new Request(DEMO_URL, {
				headers: { "x-ryu-forwarded-authorization": credential },
			})
		);
		expect(response.status).toBe(402);
		expect(await problemType(response)).toBe(INVALID_CHALLENGE);
	});
});
