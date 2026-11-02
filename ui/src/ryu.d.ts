import type { PaymentBridgeResponse, PaymentRequestBody } from "./schemas.ts";

export interface AppRequestInput {
	body?: PaymentRequestBody;
	method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
	path: string;
}

export interface RyuBridge {
	app: { request(input: AppRequestInput): Promise<PaymentBridgeResponse> };
	context: { tab?: string } | null;
	shell?: {
		subscribeTheme?(options: {
			onChange(tokens: Record<string, string>): void;
		}): { dispose(): void };
	};
	ui?: { openExternal?(input: { url: string }): Promise<void> };
}

declare global {
	interface Window {
		ryu?: RyuBridge;
	}
}
