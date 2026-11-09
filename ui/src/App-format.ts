import { activeLocale, translate as tl } from "@ryu/i18n/core";
import { localeSeparators, parseLocaleNumber } from "@ryu/i18n/parse-number";
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

/** `formatAtomic` in the user's notation ("0,5" in German), for prefilling an input. */
export function formatAtomicInput(
	value: string,
	locale = activeLocale()
): string {
	return formatAtomic(value).replace(".", localeSeparators(locale).decimal);
}

const DECIMAL_DIGIT = /\p{Nd}/u;

/** "٣" or "３" → "3": Unicode keeps each script's digits 0–9 in contiguous runs. */
function asciiDigit(char: string): string {
	const code = char.codePointAt(0) ?? 0;
	let start = code;
	while (start > 0 && DECIMAL_DIGIT.test(String.fromCodePoint(start - 1))) {
		start -= 1;
	}
	return String((code - start) % 10);
}

/** Split the typed digits at the decimal `parseLocaleNumber` found, keeping them exact. */
function splitDigits(
	value: string,
	locale: string
): [whole: string, fraction: string] | null {
	const amount = parseLocaleNumber(value, locale);
	const digits = Array.from(value.trim())
		.filter((char) => DECIMAL_DIGIT.test(char))
		.map(asciiDigit)
		.join("");
	if (!(amount >= 0 && digits)) {
		return null;
	}
	for (let places = 0; places <= digits.length; places += 1) {
		const whole = digits.slice(0, digits.length - places);
		const fraction = digits.slice(digits.length - places);
		if (Number(`${whole || "0"}.${fraction || "0"}`) === amount) {
			return [whole || "0", fraction];
		}
	}
	return null;
}

/** "0,5" in German or "0.5" in English → "500000", without a float round trip. */
export function toAtomic(value: string, locale = activeLocale()): string {
	const split = splitDigits(value, locale);
	if (!split) {
		throw new Error(
			tl("Enter an amount, such as {example}.", {
				example: formatAtomicInput("1500000", locale),
			})
		);
	}
	const [whole, fraction] = split;
	if (fraction.replace(/0+$/u, "").length > PATH_USD_DECIMALS) {
		throw new Error(tl("Use at most six decimal places."));
	}
	return (
		BigInt(whole) * 1_000_000n +
		BigInt(fraction.slice(0, PATH_USD_DECIMALS).padEnd(6, "0"))
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
