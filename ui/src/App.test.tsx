import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import type { AppRequestInput } from "./ryu.d.ts";
import { paymentPolicySchema } from "./schemas.ts";
import type {
	PaymentPolicy,
	PreparedPayment,
	Receipt,
	Service,
	Status,
} from "./types.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { App } = await import("./App.tsx");

type RequestHandler = (
	input: AppRequestInput
) => Promise<import("./schemas.ts").PaymentBridgeResponse>;
interface MountedApp {
	container: HTMLDivElement;
	root: Root;
}

const mountedApps: MountedApp[] = [];

const policy = (): PaymentPolicy => ({
	allowedOrigins: ["https://mpp.dev"],
	approvalThresholdAtomic: "500000",
	autoPay: false,
	dailySpendCapAtomic: "5000000",
	enabledMethods: ["tempo"],
	maxPerRequestAtomic: "1000000",
	testnetOnly: true,
	version: 1,
});

const status = (configured = true): Status => ({
	budget: {
		availableAtomic: "2500000",
		dailyCapAtomic: "5000000",
		pendingAtomic: "0",
		spentAtomic: "0",
	},
	policy: policy(),
	wallet: {
		address: configured ? "0xwallet1234567890" : null,
		balanceAtomic: "2500000",
		configured,
		currency: "pathUSD",
		decimals: 6,
		network: "tempo-testnet",
	},
});

const preparedPayment = (requiresApproval: boolean): PreparedPayment => ({
	approvalToken: "approval-once-123",
	budget: {
		availableAtomic: "2500000",
		dailyCapAtomic: "5000000",
		pendingAtomic: "0",
		spentAtomic: "0",
	},
	challenge: {
		amountAtomic: "250000",
		chainId: 42_431,
		challengeHash: "challenge-hash-123456",
		challengeId: "challenge-1",
		currency: "pathUSD",
		decimals: 6,
		description: "One paid request",
		intent: "charge",
		method: "tempo",
		origin: "https://mpp.dev",
		payee: "0xpayee1234567890",
		realm: "tempo-testnet",
	},
	expiresAt: "2026-10-01T00:00:00.000Z",
	request: {
		method: "GET",
		transport: "http",
		url: "https://mpp.dev/api/ping/paid",
	},
	requiresApproval,
});

const receipt = (): Receipt => ({
	amountAtomic: "250000",
	chainId: 42_431,
	challengeId: "challenge-1",
	currency: "pathUSD",
	id: "receipt-1",
	method: "tempo",
	origin: "https://mpp.dev",
	payee: "0xpayee1234567890",
	reference: "tempo-reference-1",
	status: "success",
	timestamp: "2026-09-24T00:00:00.000Z",
});

const service = (): Service => ({
	categories: ["research"],
	description: "Find current billing and usage reports.",
	endpoints: [{ method: "POST", path: "/v1/search", price: "0.25" }],
	id: "service-1",
	name: "Report search",
	status: "online",
	url: "https://mpp.dev",
});

function installBridge(request: RequestHandler, tab?: string): void {
	window.ryu = {
		app: { request },
		context: tab ? { tab } : null,
	};
}

async function mountApp(): Promise<HTMLDivElement> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mountedApps.push({ container, root });
	await act(async () => {
		root.render(<App />);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return container;
}

function findButton(container: HTMLElement, name: string): HTMLButtonElement {
	const button = [...container.querySelectorAll("button")].find((candidate) =>
		candidate.textContent?.includes(name)
	);
	if (!(button instanceof HTMLButtonElement)) {
		throw new Error(`Could not find button: ${name}`);
	}
	return button;
}

async function clickButton(
	container: HTMLElement,
	name: string
): Promise<void> {
	await act(async () => {
		findButton(container, name).click();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

async function setField(
	container: HTMLElement,
	selector: string,
	value: string
): Promise<void> {
	const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
		selector
	);
	if (!field) {
		throw new Error(`Could not find field: ${selector}`);
	}
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(
			Object.getPrototypeOf(field),
			"value"
		)?.set;
		if (setter) {
			setter.call(field, value);
		} else {
			field.value = value;
		}
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

afterEach(async () => {
	for (const { container, root } of mountedApps.splice(0)) {
		await act(async () => root.unmount());
		container.remove();
	}
	Reflect.set(window, "ryu", undefined);
});

describe("Payments Companion controls", () => {
	test("saves policy limits in atomic units and persists trusted origins", async () => {
		const calls: AppRequestInput[] = [];
		installBridge(async (input) => {
			calls.push(input);
			if (input.path === "/status") {
				return status();
			}
			if (input.path === "/services") {
				return { services: [] };
			}
			if (input.path === "/receipts") {
				return { receipts: [] };
			}
			if (input.path === "/policy" && input.method === "PUT") {
				return { policy: paymentPolicySchema.parse(input.body) };
			}
			throw new Error(
				`Unexpected Payments request: ${input.method} ${input.path}`
			);
		}, "policy");

		const container = await mountApp();
		expect(container.textContent).toContain("Payment policy");
		await setField(container, '[name="maximum-per-request"]', "2.5");
		await setField(container, '[name="daily-spend-cap"]', "10");
		await setField(container, '[name="approval-threshold"]', "0.75");
		await setField(
			container,
			'[name="allowed-origins"]',
			" https://mpp.dev  \nhttps://docs.example\n"
		);
		const autoPay = container.querySelector<HTMLButtonElement>(
			'[role="switch"][aria-label="Auto-pay below threshold"]'
		);
		if (!autoPay) {
			throw new Error("Auto-pay switch was not rendered");
		}
		await act(async () => {
			autoPay.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: " " })
			);
			autoPay.dispatchEvent(
				new KeyboardEvent("keyup", { bubbles: true, key: " " })
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(autoPay.getAttribute("aria-checked")).toBe("true");
		await clickButton(container, "Save policy");

		const saved = calls.find(
			(call) => call.path === "/policy" && call.method === "PUT"
		);
		expect(saved?.body).toEqual({
			...policy(),
			allowedOrigins: ["https://mpp.dev", "https://docs.example"],
			approvalThresholdAtomic: "750000",
			autoPay: true,
			dailySpendCapAtomic: "10000000",
			maxPerRequestAtomic: "2500000",
		});
	});

	test("requires a wallet, then explicit review before paying and saving a receipt", async () => {
		const calls: AppRequestInput[] = [];
		let currentStatus = status(false);
		let savedReceipt: Receipt | null = null;
		installBridge(async (input) => {
			calls.push(input);
			if (input.path === "/status") {
				return currentStatus;
			}
			if (input.path === "/services") {
				return { services: [] };
			}
			if (input.path === "/receipts") {
				return { receipts: savedReceipt ? [savedReceipt] : [] };
			}
			if (input.path === "/wallet/create") {
				currentStatus = status(true);
				return { wallet: currentStatus.wallet };
			}
			if (input.path === "/payments/prepare") {
				return { kind: "payment_required", payment: preparedPayment(true) };
			}
			if (input.path === "/payments/pay") {
				savedReceipt = receipt();
				return {
					receipt: savedReceipt,
					resource: {
						body: "settled",
						contentType: "text/plain",
						headers: {},
						status: 200,
					},
				};
			}
			throw new Error(
				`Unexpected Payments request: ${input.method} ${input.path}`
			);
		});

		const container = await mountApp();
		expect(container.textContent).toContain("Not configured");
		expect(findButton(container, "Review payment").disabled).toBe(true);
		await clickButton(container, "Create wallet");
		expect(findButton(container, "Review payment").disabled).toBe(false);
		await clickButton(container, "Review payment");
		expect(document.body.textContent).toContain("Approve 0.25 pathUSD?");
		expect(calls.some((call) => call.path === "/payments/pay")).toBe(false);
		await clickButton(document.body, "Approve & pay");
		expect(calls.find((call) => call.path === "/payments/pay")?.body).toEqual({
			approvalToken: "approval-once-123",
		});
		expect(container.textContent).toContain(
			"Payment verified and receipt saved."
		);
		expect(container.textContent).toContain("tempo-reference-1");
	});

	test("settles without a modal only when the host marks the request auto-approved", async () => {
		const calls: AppRequestInput[] = [];
		let savedReceipt: Receipt | null = null;
		installBridge(async (input) => {
			calls.push(input);
			if (input.path === "/status") {
				return status();
			}
			if (input.path === "/services") {
				return { services: [] };
			}
			if (input.path === "/receipts") {
				return { receipts: savedReceipt ? [savedReceipt] : [] };
			}
			if (input.path === "/payments/prepare") {
				return { kind: "payment_required", payment: preparedPayment(false) };
			}
			if (input.path === "/payments/pay") {
				savedReceipt = receipt();
				return {
					receipt: savedReceipt,
					resource: {
						body: "settled",
						contentType: "text/plain",
						headers: {},
						status: 200,
					},
				};
			}
			throw new Error(
				`Unexpected Payments request: ${input.method} ${input.path}`
			);
		});

		const container = await mountApp();
		await clickButton(container, "Review payment");
		expect(container.textContent).not.toContain("Approve 0.25 pathUSD?");
		expect(calls.some((call) => call.path === "/payments/pay")).toBe(true);
		expect(container.textContent).toContain(
			"Payment settled under the active auto-pay policy."
		);
	});

	test("searches the service catalog and fills the selected HTTP endpoint", async () => {
		installBridge(async (input) => {
			if (input.path === "/status") {
				return status();
			}
			if (input.path === "/services") {
				return { services: [service()] };
			}
			if (input.path === "/receipts") {
				return { receipts: [] };
			}
			throw new Error(
				`Unexpected Payments request: ${input.method} ${input.path}`
			);
		});

		const container = await mountApp();
		expect(container.textContent).toContain("Report search");
		await setField(container, '[name="service-search"]', "billing");
		expect(container.textContent).toContain("Report search");
		await setField(container, '[name="service-search"]', "weather");
		expect(container.textContent).toContain("No services match that search.");
		await setField(container, '[name="service-search"]', "billing");
		await clickButton(container, "0.25");

		expect(
			container.querySelector<HTMLInputElement>('[name="endpoint"]')?.value
		).toBe("https://mpp.dev/v1/search");
		expect(
			container.querySelector<HTMLSelectElement>('[name="method"]')?.value
		).toBe("POST");
	});

	test("routes MCP requests through the separate prepare contract", async () => {
		const calls: AppRequestInput[] = [];
		installBridge(async (input) => {
			calls.push(input);
			if (input.path === "/status") {
				return status();
			}
			if (input.path === "/services") {
				return { services: [] };
			}
			if (input.path === "/receipts") {
				return { receipts: [] };
			}
			if (input.path === "/payments/prepare-mcp") {
				return {
					kind: "ready",
					resource: {
						body: "ok",
						contentType: "text/plain",
						headers: {},
						status: 200,
					},
				};
			}
			throw new Error(
				`Unexpected Payments request: ${input.method} ${input.path}`
			);
		});

		const container = await mountApp();
		const transport = container.querySelector<HTMLSelectElement>(
			'[aria-label="Payment protocol transport"]'
		);
		if (!transport) {
			throw new Error("Payment protocol selector was not rendered");
		}
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(
				Object.getPrototypeOf(transport),
				"value"
			)?.set;
			if (setter) {
				setter.call(transport, "mcp");
			} else {
				transport.value = "mcp";
			}
			transport.dispatchEvent(new Event("change", { bubbles: true }));
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(container.textContent).toContain("MCP server URL");
		await setField(container, '[aria-label="MCP tool name"]', "reports.search");
		await setField(container, '[name="endpoint"]', "https://mpp.dev/mcp");
		await clickButton(container, "Review payment");

		expect(container.textContent).toContain("Endpoint returned HTTP 200");
		expect(
			calls.find((call) => call.path === "/payments/prepare-mcp")?.body
		).toEqual({
			arguments: {},
			tool: "reports.search",
			url: "https://mpp.dev/mcp",
		});
	});

	test("receipt history selects a single persisted settlement for its details", async () => {
		const first = receipt();
		const second = {
			...receipt(),
			amountAtomic: "500000",
			id: "receipt-2",
			origin: "https://docs.example",
			reference: "tempo-reference-2",
		};
		installBridge(async (input) => {
			if (input.path === "/status") {
				return status();
			}
			if (input.path === "/services") {
				return { services: [] };
			}
			if (input.path === "/receipts") {
				return { receipts: [first, second] };
			}
			throw new Error(
				`Unexpected Payments request: ${input.method} ${input.path}`
			);
		}, "receipts");

		const container = await mountApp();
		expect(container.textContent).toContain("tempo-reference-1");
		await clickButton(container, "docs.example");
		expect(container.textContent).toContain("tempo-reference-2");
		expect(container.textContent).not.toContain("tempo-reference-1");
	});
});
