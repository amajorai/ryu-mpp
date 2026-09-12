export interface PaymentPolicy {
	allowedOrigins: string[];
	approvalThresholdAtomic: string;
	autoPay: boolean;
	dailySpendCapAtomic: string;
	enabledMethods: ["tempo"];
	maxPerRequestAtomic: string;
	testnetOnly: true;
	version: 1;
}

export interface BudgetSnapshot {
	availableAtomic: string;
	dailyCapAtomic: string;
	pendingAtomic: string;
	spentAtomic: string;
}

export interface WalletStatus {
	address: string | null;
	balanceAtomic: string;
	configured: boolean;
	currency: string;
	decimals: number;
	network: string;
}

export interface Status {
	budget: BudgetSnapshot;
	policy: PaymentPolicy;
	wallet: WalletStatus;
}

export interface Service {
	categories: string[];
	description: string;
	endpoints: Array<{ method: string; path: string; price?: string }>;
	id: string;
	name: string;
	status?: string;
	url: string;
}

export interface NormalizedChallenge {
	amountAtomic: string;
	chainId: number;
	challengeHash: string;
	challengeId: string;
	currency: string;
	decimals: number;
	description?: string;
	digest?: string;
	expiresAt?: string;
	intent: string;
	method: "tempo";
	origin: string;
	payee: string;
	realm: string;
}

export interface PreparedPayment {
	approvalToken: string;
	budget: BudgetSnapshot;
	challenge: NormalizedChallenge;
	expiresAt: string;
	request:
		| { method: string; transport: "http"; url: string }
		| { tool: string; transport: "mcp"; url: string };
	requiresApproval: boolean;
}

export interface Receipt {
	amountAtomic: string;
	chainId: number;
	challengeId: string;
	currency: string;
	id: string;
	method: string;
	origin: string;
	payee: string;
	reference: string;
	status: "success";
	timestamp: string;
}

export interface PaidResource {
	body: string;
	contentType: string | null;
	headers: Record<string, string>;
	status: number;
}

export type Preparation =
	| { kind: "payment_required"; payment: PreparedPayment }
	| { kind: "ready"; resource: PaidResource };

export interface PaymentResult {
	receipt: Receipt;
	resource: PaidResource;
}
