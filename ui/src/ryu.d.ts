export interface AppRequestInput {
	body?: unknown;
	method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
	path: string;
}

export interface RyuBridge {
	app: { request(input: AppRequestInput): Promise<unknown> };
	context: Record<string, unknown> | null;
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
