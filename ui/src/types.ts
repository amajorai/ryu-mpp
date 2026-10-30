import type { z } from "zod";
import type {
	budgetSnapshotSchema,
	normalizedChallengeSchema,
	paidResourceSchema,
	paymentPolicySchema,
	paymentResultSchema,
	preparationSchema,
	preparedPaymentSchema,
	receiptSchema,
	serviceSchema,
	statusSchema,
	walletStatusSchema,
} from "./schemas.ts";

export type PaymentPolicy = z.output<typeof paymentPolicySchema>;
export type BudgetSnapshot = z.output<typeof budgetSnapshotSchema>;
export type WalletStatus = z.output<typeof walletStatusSchema>;
export type Status = z.output<typeof statusSchema>;
export type Service = z.output<typeof serviceSchema>;
export type NormalizedChallenge = z.output<typeof normalizedChallengeSchema>;
export type PreparedPayment = z.output<typeof preparedPaymentSchema>;
export type Receipt = z.output<typeof receiptSchema>;
export type PaidResource = z.output<typeof paidResourceSchema>;
export type Preparation = z.output<typeof preparationSchema>;
export type PaymentResult = z.output<typeof paymentResultSchema>;
