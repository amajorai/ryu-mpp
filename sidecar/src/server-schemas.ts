import type { StoreSealHealth } from "@ryu/sidecar-runtime/content-seal";
import { z } from "zod";
import type { CanonicalPaymentDocument } from "./request-schemas.ts";
import type {
	BudgetSnapshot,
	PaymentPolicy,
	PaymentPreparation,
	PaymentResult,
	ReceiptProjection,
	ServiceCatalogItem,
	WalletStatus,
} from "./types.ts";
import { AppError } from "./types.ts";

// Native JSON decoding establishes every nested value's serialization grammar.
// The private output check requires a root object without re-traversing unrelated metadata.
const decodedPaymentObjectSchema = z.custom<CanonicalPaymentDocument>(
	(value) => z.object({}).safeParse(value).success
);
export const paymentJsonSourceSchema = z
	.string()
	.transform((source) => JSON.parse(source))
	.pipe(decodedPaymentObjectSchema);
export const mppFailureSchema = z.instanceof(AppError);
export const serviceSearchQuerySchema = z
	.string()
	.transform((value) => value.trim().toLowerCase().slice(0, 256))
	.catch("");
export const receiptLimitSchema = z.number().catch(50);
export const receiptIdSchema = z.string();

export type MppServerResponse =
	| { ok: true; protocol: "MPP"; version: 1 }
	| { error: string | { code: string; message: string } }
	| {
			budget: BudgetSnapshot;
			policy: PaymentPolicy;
			sealing?: StoreSealHealth;
			wallet: WalletStatus;
	  }
	| { wallet: WalletStatus }
	| { policy: PaymentPolicy }
	| { cached: boolean; services: ServiceCatalogItem[] }
	| { receipts: ReceiptProjection[] }
	| { receipt: ReceiptProjection }
	| PaymentPreparation
	| PaymentResult;
