import type { Service } from "./types.ts";

export type Tab = "services" | "policy" | "receipts";

export const PATH_USD_DECIMALS = 6;
export const DEFAULT_PAID_URL = "https://mpp.dev/api/ping/paid";

export function initialTab(): Tab {
	const requested = globalThis.window ? window.ryu?.context?.tab : undefined;
	return requested === "policy" || requested === "receipts"
		? requested
		: "services";
}

export function formatAtomic(
	value: string,
	decimals = PATH_USD_DECIMALS
): string {
	const atomic = BigInt(value);
	const unit = 10n ** BigInt(decimals);
	const whole = atomic / unit;
	const fraction = (atomic % unit)
		.toString()
		.padStart(decimals, "0")
		.replace(/0+$/, "");
	return `${whole}${fraction ? `.${fraction}` : ""}`;
}

export function toAtomic(value: string): string {
	if (!/^\d+(\.\d{0,6})?$/.test(value.trim())) {
		throw new Error("Use at most six decimal places.");
	}
	const [whole = "0", fraction = ""] = value.trim().split(".");
	return (
		BigInt(whole) * 1_000_000n +
		BigInt(fraction.padEnd(6, "0"))
	).toString();
}

export function short(value: string, start = 8, end = 6): string {
	return value.length > start + end + 2
		? `${value.slice(0, start)}…${value.slice(-end)}`
		: value;
}

export function messageFrom(cause: unknown): string {
	return cause instanceof Error ? cause.message : "Something went wrong.";
}

export function copyText(value: string): void {
	void navigator.clipboard?.writeText(value);
}

export function resolveEndpoint(service: Service, path: string): string {
	try {
		return new URL(path, service.url).toString();
	} catch {
		return service.url;
	}
}
