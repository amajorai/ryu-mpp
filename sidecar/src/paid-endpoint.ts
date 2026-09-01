import { Mppx, tempo } from "mppx/server";
import type { PaymentStore } from "./store.ts";
import { PATH_USD_ADDRESS } from "./types.ts";
import type { MppWallet } from "./wallet.ts";

const FORWARDED_AUTHORIZATION = "x-ryu-forwarded-authorization";

export type PaidEndpoint = (request: Request) => Promise<Response>;

export async function createPaidEndpoint(
	wallet: MppWallet,
	store: PaymentStore
): Promise<PaidEndpoint> {
	const account = await wallet.getAccount();
	const secretKey = await wallet.getServerSecret();
	const payments = Mppx.create({
		methods: [
			tempo.charge({
				currency: PATH_USD_ADDRESS,
				decimals: 6,
				recipient: account.address,
				store: store.mppxStore(),
				storeKeyPrefix: "paid-demo:",
				testnet: true,
			}),
		],
		realm: process.env.RYU_MPP_PUBLIC_REALM ?? "Ryu MPP demo",
		secretKey,
	});

	return async (request: Request): Promise<Response> => {
		const headers = new Headers(request.headers);
		const forwardedAuthorization = headers.get(FORWARDED_AUTHORIZATION);
		headers.delete(FORWARDED_AUTHORIZATION);
		if (forwardedAuthorization) {
			headers.set("authorization", forwardedAuthorization);
		} else {
			headers.delete("authorization");
		}

		const paymentRequest = new Request(request.url, {
			headers,
			method: request.method,
		});
		const result = await payments.charge({
			amount: "0.01",
			description: "Ryu MPP interoperability receipt",
			scope: "GET /api/mpp/paid/demo",
		})(paymentRequest);
		if (result.status === 402) {
			return result.challenge;
		}
		return result.withReceipt(
			Response.json(
				{
					data: {
						message: "Payment verified by Ryu.",
						network: "Tempo testnet",
						resource: "mpp-interoperability-demo",
					},
				},
				{ headers: { "cache-control": "no-store" } }
			)
		);
	};
}
