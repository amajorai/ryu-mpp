import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { AppRequestInput } from "../src/ryu.d.ts";
import type { PersistedPaymentState } from "../src/schemas.ts";
import type {
	PaymentPolicy,
	PreparedPayment,
	Receipt,
	Service,
} from "../src/types.ts";

const POLICY = {
	allowedOrigins: ["https://mpp.dev"],
	approvalThresholdAtomic: "500000",
	autoPay: false,
	dailySpendCapAtomic: "5000000",
	enabledMethods: ["tempo"],
	maxPerRequestAtomic: "1000000",
	testnetOnly: true,
	version: 1,
} satisfies PaymentPolicy;

const BUDGET = {
	availableAtomic: "2500000",
	dailyCapAtomic: "5000000",
	pendingAtomic: "0",
	spentAtomic: "0",
};

const RECEIPT: Receipt = {
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
};

const SECOND_RECEIPT = {
	...RECEIPT,
	amountAtomic: "500000",
	id: "receipt-2",
	origin: "https://docs.example",
	reference: "tempo-reference-2",
};

const PAID_CHALLENGE: PreparedPayment = {
	approvalToken: "approval-once-123",
	budget: BUDGET,
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
	requiresApproval: true,
};

const SERVICE = {
	categories: ["research"],
	description: "Find current billing and usage reports.",
	endpoints: [{ method: "POST", path: "/v1/search", price: "0.25" }],
	id: "service-1",
	name: "Report search",
	status: "online",
	url: "https://mpp.dev",
};

const URL_ONLY_SERVICE = {
	categories: ["weather"],
	description: "A service with no listed endpoints.",
	endpoints: [],
	id: "service-2",
	name: "Weather data",
	status: "online",
	url: "https://weather.example.test/api",
};

type ReceiptFixture = Receipt;
type ServiceFixture = Service;

type MppCall = AppRequestInput;

interface MppWindow {
	calls: MppCall[];
}
declare global {
	interface Window {
		__mppTestState?: MppWindow;
	}
}
const fixtureDirectory = mkdtempSync(path.join(tmpdir(), "ryu-mpp-fixture-"));
const fixtureBundle = path.join(fixtureDirectory, "schemas.js");
execFileSync("bun", [
	"build",
	path.join(import.meta.dirname, "fixture-schemas.ts"),
	"--target=browser",
	"--format=iife",
	`--outfile=${fixtureBundle}`,
]);
const fixtureSchemaScript = readFileSync(fixtureBundle, "utf8");

interface FixtureOptions {
	failures?: Record<string, number>;
	preparedPayment?: typeof PAID_CHALLENGE;
	readyPrepare?: boolean;
	receipts?: ReceiptFixture[];
	services?: ServiceFixture[];
	tab?: "policy" | "receipts" | "services";
	walletConfigured?: boolean;
	zeroBalance?: boolean;
}

async function installBridge(page: Page, options: FixtureOptions = {}) {
	await page.addInitScript({ content: fixtureSchemaScript });
	await page.addInitScript(
		(seed: {
			budget: typeof BUDGET;
			failures: Record<string, number>;
			policy: typeof POLICY;
			preparedPayment: typeof PAID_CHALLENGE;
			readyPrepare: boolean;
			receipt: typeof RECEIPT;
			receipts: ReceiptFixture[];
			services: ServiceFixture[];
			storageKey: string;
			tab: FixtureOptions["tab"];
			walletConfigured: boolean;
			zeroBalance: boolean;
		}) => {
			const seededKey = `${seed.storageKey}.seeded`;
			if (sessionStorage.getItem(seededKey) !== "1") {
				localStorage.removeItem(seed.storageKey);
				sessionStorage.setItem(seededKey, "1");
			}
			const readSaved = () => {
				try {
					const raw = localStorage.getItem(seed.storageKey);
					return raw ? (window.__mppFixtureSchemas?.readSaved(raw) ?? {}) : {};
				} catch {
					return {};
				}
			};
			const writeSaved = (patch: PersistedPaymentState) => {
				localStorage.setItem(
					seed.storageKey,
					JSON.stringify({ ...readSaved(), ...patch })
				);
			};
			const calls: MppCall[] = [];
			const failures = { ...seed.failures };
			const wallet = {
				address: seed.walletConfigured ? "0xwallet1234567890" : null,
				balanceAtomic: seed.zeroBalance ? "0" : "2500000",
				configured: seed.walletConfigured,
				currency: "pathUSD",
				decimals: 6,
				network: "tempo-testnet",
			};
			const app = {
				request: async (input: MppCall) => {
					calls.push(structuredClone(input));
					const key = `${input.method} ${input.path}`;
					if ((failures[key] ?? 0) > 0) {
						failures[key] = (failures[key] ?? 0) - 1;
						throw new Error("Fixture request failed once; retry is safe.");
					}
					if (input.path === "/status" && input.method === "GET") {
						const saved = readSaved();
						return {
							budget: seed.budget,
							policy: saved.policy ?? seed.policy,
							wallet: saved.wallet ?? wallet,
						};
					}
					if (input.path === "/services" && input.method === "GET") {
						return { services: seed.services };
					}
					if (input.path === "/receipts" && input.method === "GET") {
						return { receipts: readSaved().receipts ?? seed.receipts };
					}
					if (input.path === "/wallet/create" && input.method === "POST") {
						const nextWallet = {
							...wallet,
							address: "0xcreated1234567890",
							configured: true,
						};
						writeSaved({ wallet: nextWallet });
						return { wallet: nextWallet };
					}
					if (input.path === "/wallet/fund" && input.method === "POST") {
						const nextWallet = {
							...wallet,
							address: "0xcreated1234567890",
							balanceAtomic: "2500000",
							configured: true,
						};
						writeSaved({ wallet: nextWallet });
						return { wallet: nextWallet };
					}
					if (input.path === "/policy" && input.method === "PUT") {
						const policy = window.__mppFixtureSchemas?.policy(input.body);
						if (!policy) {
							throw new Error("MPP fixture policy parser unavailable");
						}
						writeSaved({ policy });
						return { policy };
					}
					if (input.path === "/payments/prepare" && input.method === "POST") {
						if (seed.readyPrepare) {
							return {
								kind: "ready",
								resource: {
									body: "local HTTP fixture response",
									contentType: "text/plain",
									headers: {},
									status: 200,
								},
							};
						}
						return {
							kind: "payment_required",
							payment: seed.preparedPayment,
						};
					}
					if (
						input.path === "/payments/prepare-mcp" &&
						input.method === "POST"
					) {
						return {
							kind: "ready",
							resource: {
								body: "local MCP fixture response",
								contentType: "text/plain",
								headers: {},
								status: 200,
							},
						};
					}
					if (input.path === "/payments/pay" && input.method === "POST") {
						const saved = readSaved();
						const nextReceipts = [
							seed.receipt,
							...(saved.receipts ?? seed.receipts),
						];
						writeSaved({ receipts: nextReceipts });
						return {
							receipt: seed.receipt,
							resource: {
								body: "local settlement fixture",
								contentType: "text/plain",
								headers: {},
								status: 200,
							},
						};
					}
					throw new Error(`Unexpected local payment call: ${key}`);
				},
			};
			Object.assign(window, {
				__mppTestState: { calls },
				ryu: { app, context: seed.tab ? { tab: seed.tab } : null },
			});
		},
		{
			budget: BUDGET,
			failures: options.failures ?? {},
			policy: POLICY,
			preparedPayment: options.preparedPayment ?? PAID_CHALLENGE,
			readyPrepare: options.readyPrepare ?? false,
			receipt: RECEIPT,
			receipts: options.receipts ?? [],
			services: options.services ?? [],
			storageKey: "ryu.mpp.test-state.v1",
			tab: options.tab,
			walletConfigured: options.walletConfigured ?? true,
			zeroBalance: options.zeroBalance ?? false,
		}
	);
}

async function callsFor(page: Page): Promise<MppCall[]> {
	return page.evaluate(() => {
		return window.__mppTestState?.calls ?? [];
	});
}

async function screenshotPath(
	testInfo: { outputPath(name: string): string },
	name: string
): Promise<string> {
	const configured = process.env.RYU_APPS_STORE_PROOF_DIR;
	const destination = configured
		? path.join(configured, name)
		: testInfo.outputPath(name);
	await mkdir(path.dirname(destination), { recursive: true });
	return destination;
}

test("creates and funds a wallet through the local bridge", async ({
	page,
}, testInfo) => {
	await installBridge(page, { walletConfigured: false, zeroBalance: true });
	await page.goto("/");
	await expect(page.getByText("Not configured")).toBeVisible();
	await page.getByRole("button", { name: "Create wallet" }).click();
	await expect(page.getByText("0xcreate…567890")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Fund testnet" })
	).toBeVisible();
	await page.getByRole("button", { name: "Fund testnet" }).click();
	await expect(
		page.getByRole("region", { name: "Payment status" })
	).toContainText("2.5");
	expect(
		(await callsFor(page)).filter((call) => call.path.startsWith("/wallet/"))
	).toEqual([
		{ method: "POST", path: "/wallet/create", body: {} },
		{ method: "POST", path: "/wallet/fund", body: {} },
	]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: await screenshotPath(testInfo, "mpp-wallet-funded-testnet.png"),
	});
});

test("saves policy values as atomic units and retains the draft across a failed write", async ({
	page,
}, testInfo) => {
	await installBridge(page, {
		failures: { "PUT /policy": 1 },
		tab: "policy",
	});
	await page.goto("/");
	await page.getByLabel("Maximum per request").fill("2.5");
	await page.getByLabel("Daily spend cap").fill("10");
	await page.getByLabel("Approval threshold").fill("0.75");
	await page
		.getByLabel("Allowed origins")
		.fill(" https://mpp.dev  \nhttps://docs.example\n");
	await page.getByRole("switch", { name: "Auto-pay below threshold" }).click();
	await page.getByRole("button", { name: "Save policy" }).click();
	await expect(
		page.getByText("Fixture request failed once; retry is safe.")
	).toBeVisible();
	await expect(page.getByLabel("Maximum per request")).toHaveValue("2.5");
	await page.getByRole("button", { name: "Save policy" }).click();
	const writes = (await callsFor(page)).filter(
		(call) => call.path === "/policy" && call.method === "PUT"
	);
	const expectedPolicy = {
		...POLICY,
		allowedOrigins: ["https://mpp.dev", "https://docs.example"],
		approvalThresholdAtomic: "750000",
		autoPay: true,
		dailySpendCapAtomic: "10000000",
		maxPerRequestAtomic: "2500000",
	};
	expect(writes).toEqual([
		{ body: expectedPolicy, method: "PUT", path: "/policy" },
		{ body: expectedPolicy, method: "PUT", path: "/policy" },
	]);
	await page.reload();
	await page.getByRole("tab", { name: "Policy" }).click();
	await expect(page.getByLabel("Maximum per request")).toHaveValue("2.5");
	await expect(page.getByLabel("Daily spend cap")).toHaveValue("10");
	await expect(page.getByLabel("Allowed origins")).toHaveValue(
		"https://mpp.dev\nhttps://docs.example"
	);
	await expect(
		page.getByRole("switch", { name: "Auto-pay below threshold" })
	).toHaveAttribute("aria-checked", "true");
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: await screenshotPath(testInfo, "mpp-policy-saved-after-reload.png"),
	});
});

test("rejects a payment without paying, then retries a failed settlement and saves a receipt", async ({
	page,
	context,
}, testInfo) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await installBridge(page, {
		failures: { "POST /payments/pay": 1 },
		receipts: [SECOND_RECEIPT],
	});
	await page.goto("/");
	await page.getByRole("button", { name: "Review payment" }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toContainText("Approve 0.25 pathUSD?");
	await expect(dialog).toContainText(
		"Ryu will sign this exact Tempo testnet challenge once."
	);
	await expect(dialog).toContainText("Tempo testnet · 42431");
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	expect(
		(await callsFor(page)).filter((call) => call.path === "/payments/pay")
	).toEqual([]);
	await page.getByRole("button", { name: "Review payment" }).click();
	await dialog.getByRole("button", { name: "Reject" }).click();
	await expect(dialog).toBeHidden();
	expect(
		(await callsFor(page)).filter((call) => call.path === "/payments/pay")
	).toEqual([]);

	await page.getByRole("button", { name: "Review payment" }).click();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "Approve & pay" })
		.click();
	await expect(
		page.getByText("Payment did not settle. Prepare a new review.")
	).toBeVisible();
	await page.getByRole("button", { name: "Dismiss" }).click();
	await page.getByRole("button", { name: "Review payment" }).click();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "Approve & pay" })
		.click();
	await expect(
		page.getByText("Payment verified and receipt saved.")
	).toBeVisible();
	await expect(page.getByRole("heading", { name: "Receipts" })).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "0.25 pathUSD" })
	).toBeVisible();
	expect(
		(await callsFor(page)).filter((call) => call.path === "/payments/pay")
	).toEqual([
		{
			body: { approvalToken: "approval-once-123" },
			method: "POST",
			path: "/payments/pay",
		},
		{
			body: { approvalToken: "approval-once-123" },
			method: "POST",
			path: "/payments/pay",
		},
	]);
	await page
		.getByRole("button", { name: /0\.5 pathUSD.*docs\.example/ })
		.click();
	await expect(
		page.getByRole("heading", { name: "0.5 pathUSD" })
	).toBeVisible();
	await page.getByRole("button", { name: /0\.25 pathUSD.*mpp\.dev/ }).click();
	await expect(
		page.getByRole("heading", { name: "0.25 pathUSD" })
	).toBeVisible();
	await page.getByRole("button", { name: "Copy receipt ID" }).click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe("receipt-1");
	await expect(page.getByRole("tab", { name: "Services" })).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: await screenshotPath(testInfo, "mpp-payment-receipt-copied.png"),
	});
});

test("searches services, fills HTTP endpoints, and uses the MCP prepare contract", async ({
	page,
}) => {
	await installBridge(page, {
		readyPrepare: true,
		services: [SERVICE, URL_ONLY_SERVICE],
	});
	await page.goto("/");
	await expect(page.getByRole("tab", { name: "Services" })).toHaveAttribute(
		"aria-selected",
		"true"
	);
	await page.getByRole("tab", { name: "Policy" }).click();
	await expect(
		page.getByRole("heading", { name: "Payment policy" })
	).toBeVisible();
	await page.getByRole("tab", { name: "Receipts" }).click();
	await expect(page.getByText("No receipts yet")).toBeVisible();
	await page.getByRole("tab", { name: "Services" }).click();
	const protocolGuide = page.getByRole("link", { name: "Protocol guide" });
	await expect(protocolGuide).toHaveAttribute("href", "https://mpp.dev");
	await expect(protocolGuide).toHaveAttribute("target", "_blank");
	await expect(protocolGuide).toHaveAttribute("rel", /noopener/);
	await page.getByPlaceholder("Search services…").fill("not found");
	await expect(page.getByText("No services match that search.")).toBeVisible();
	await page.getByPlaceholder("Search services…").fill("billing");
	await expect(
		page.getByRole("heading", { name: "Report search" })
	).toBeVisible();
	await page.getByRole("button", { name: /POST.*0.25/ }).click();
	await expect(page.getByLabel("Paid endpoint URL")).toHaveValue(
		"https://mpp.dev/v1/search"
	);
	await page.getByLabel("Paid endpoint URL").fill("https://mpp.dev/v2/search");
	await page.getByLabel("HTTP method").selectOption("PATCH");
	await page.getByRole("button", { name: "Review payment" }).click();
	await expect(
		page.getByText("Endpoint returned HTTP 200; no payment was required.")
	).toBeVisible();
	await page.getByRole("button", { name: "Dismiss" }).click();
	await expect(
		page.getByText("Endpoint returned HTTP 200; no payment was required.")
	).toBeHidden();
	await page.getByPlaceholder("Search services…").fill("weather");
	await page.getByRole("button", { name: "Use service URL" }).click();
	await expect(page.getByLabel("Paid endpoint URL")).toHaveValue(
		"https://weather.example.test/api"
	);
	expect(
		(await callsFor(page)).find((call) => call.path === "/payments/prepare")
	).toEqual({
		body: { method: "PATCH", url: "https://mpp.dev/v2/search" },
		method: "POST",
		path: "/payments/prepare",
	});
	await page.getByLabel("Payment protocol transport").selectOption("mcp");
	await page.getByLabel("MCP tool name").fill("reports.search");
	await page.getByLabel("MCP server URL").fill("https://mpp.dev/mcp");
	await page.getByRole("button", { name: "Review payment" }).click();
	await expect(
		page.getByText("Endpoint returned HTTP 200; no payment was required.")
	).toBeVisible();
	expect(
		(await callsFor(page)).find((call) => call.path === "/payments/prepare-mcp")
	).toEqual({
		body: { arguments: {}, tool: "reports.search", url: "https://mpp.dev/mcp" },
		method: "POST",
		path: "/payments/prepare-mcp",
	});
});

test("opens the Protocol guide in a new tab without making a payment request", async ({
	page,
	context,
}, testInfo) => {
	const externalRequests: string[] = [];
	await context.route(
		(url) => url.hostname === "mpp.dev",
		async (route) => {
			externalRequests.push(route.request().url());
			await route.fulfill({
				body: "<!doctype html><title>Local MPP guide fixture</title><h1>Guide fixture</h1>",
				contentType: "text/html",
				status: 200,
			});
		}
	);
	await installBridge(page, { services: [SERVICE] });
	await page.goto("/");

	const guideLink = page.getByRole("link", { name: "Protocol guide" });
	await expect(
		page.getByRole("heading", { name: "Report search" })
	).toBeVisible();
	await expect(guideLink).toHaveAttribute("href", "https://mpp.dev");
	await expect(guideLink).toHaveAttribute("target", "_blank");
	await expect(guideLink).toHaveAttribute("rel", "noopener noreferrer");
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: await screenshotPath(testInfo, "mpp-protocol-guide-link.png"),
	});

	const guideTabReady = context.waitForEvent("page");
	await guideLink.click();
	const guideTab = await guideTabReady;
	await expect(guideTab).toHaveURL("https://mpp.dev/");
	await expect(guideTab).toHaveTitle("Local MPP guide fixture");
	expect(externalRequests).toEqual(["https://mpp.dev/"]);
	expect(
		(await callsFor(page)).some((call) => call.path === "/payments/pay")
	).toBe(false);
	await guideTab.close();
});
