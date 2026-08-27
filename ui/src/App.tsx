import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogTitle,
	Input,
	Switch,
	Textarea,
} from "@ryu/blocks/companion/controls";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import {
	type FormEvent,
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";

import {
	createWallet,
	fundWallet,
	getStatus,
	listReceipts,
	listServices,
	pay,
	prepareMcpPayment,
	preparePayment,
	savePolicy,
} from "./api.ts";
import type {
	PaymentPolicy,
	PreparedPayment,
	Receipt,
	Service,
	Status,
} from "./types.ts";

type Tab = "services" | "policy" | "receipts";
type IconName =
	| "arrow"
	| "check"
	| "copy"
	| "receipt"
	| "search"
	| "shield"
	| "wallet";

const PATH_USD_DECIMALS = 6;
const DEFAULT_PAID_URL = "https://mpp.dev/api/ping/paid";
const TABS: readonly Tab[] = ["services", "policy", "receipts"];
const TAB_LABELS: Record<Tab, string> = {
	policy: "Policy",
	receipts: "Receipts",
	services: "Services",
};

function Icon({ name }: { name: IconName }): ReactNode {
	const paths: Record<IconName, ReactNode> = {
		arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
		check: <path d="m5 12 4 4L19 6" />,
		copy: (
			<>
				<rect height="10" rx="2" width="10" x="9" y="9" />
				<path d="M15 9V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
			</>
		),
		receipt: (
			<>
				<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" />
				<path d="M9 8h6M9 12h6" />
			</>
		),
		search: (
			<>
				<circle cx="11" cy="11" r="6" />
				<path d="m16 16 4 4" />
			</>
		),
		shield: (
			<>
				<path d="M12 3 5 6v5c0 4.6 2.8 7.8 7 10 4.2-2.2 7-5.4 7-10V6l-7-3Z" />
				<path d="m9 12 2 2 4-5" />
			</>
		),
		wallet: (
			<>
				<path d="M4 7a2 2 0 0 1 2-2h12v14H6a2 2 0 0 1-2-2V7Z" />
				<path d="M15 10h5v4h-5a2 2 0 0 1 0-4Z" />
			</>
		),
	};
	return (
		<svg
			aria-hidden="true"
			className="icon"
			fill="none"
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
			strokeWidth="1.8"
			viewBox="0 0 24 24"
		>
			{paths[name]}
		</svg>
	);
}

function formatAtomic(value: string, decimals = PATH_USD_DECIMALS): string {
	const atomic = BigInt(value);
	const unit = 10n ** BigInt(decimals);
	const whole = atomic / unit;
	const fraction = (atomic % unit)
		.toString()
		.padStart(decimals, "0")
		.replace(/0+$/, "");
	return `${whole}${fraction ? `.${fraction}` : ""}`;
}

function toAtomic(value: string): string {
	if (!/^\d+(\.\d{0,6})?$/.test(value.trim())) {
		throw new Error("Use at most six decimal places.");
	}
	const [whole = "0", fraction = ""] = value.trim().split(".");
	return (
		BigInt(whole) * 1_000_000n +
		BigInt(fraction.padEnd(6, "0"))
	).toString();
}

function short(value: string, start = 8, end = 6): string {
	return value.length > start + end + 2
		? `${value.slice(0, start)}…${value.slice(-end)}`
		: value;
}

function messageFrom(error: unknown): string {
	return error instanceof Error ? error.message : "Something went wrong.";
}

function copyText(value: string): void {
	void navigator.clipboard?.writeText(value);
}

function resolveEndpoint(service: Service, path: string): string {
	try {
		return new URL(path, service.url).toString();
	} catch {
		return service.url;
	}
}

function ApprovalDialog({
	busy,
	onApprove,
	onClose,
	payment,
}: {
	busy: boolean;
	onApprove(): void;
	onClose(): void;
	payment: PreparedPayment;
}): ReactNode {
	const amount = BigInt(payment.challenge.amountAtomic);
	const available = BigInt(payment.budget.availableAtomic);
	const after = available > amount ? available - amount : 0n;
	return (
		<Dialog
			onOpenChange={(open) => {
				if (!(open || busy)) {
					onClose();
				}
			}}
			open
		>
			<DialogContent
				aria-describedby="approval-summary"
				aria-labelledby="approval-title"
				className="approval-dialog"
				showCloseButton={false}
			>
				<div className="approval-kicker">
					<Icon name="shield" /> Review payment
				</div>
				<DialogTitle id="approval-title">
					Approve {formatAtomic(payment.challenge.amountAtomic)} pathUSD?
				</DialogTitle>
				<DialogDescription className="approval-summary" id="approval-summary">
					Ryu will sign this exact Tempo testnet challenge once. Any change
					requires a new review.
				</DialogDescription>

				<div className="amount-lockup">
					<span className="amount-value">
						{formatAtomic(payment.challenge.amountAtomic)}
					</span>
					<span className="amount-unit">pathUSD</span>
				</div>

				<dl className="review-list">
					<div>
						<dt>To</dt>
						<dd title={payment.challenge.payee}>
							{short(payment.challenge.payee, 10, 8)}
						</dd>
					</div>
					<div>
						<dt>Origin</dt>
						<dd>{payment.challenge.origin}</dd>
					</div>
					<div>
						<dt>Network</dt>
						<dd>Tempo testnet · {payment.challenge.chainId}</dd>
					</div>
					<div>
						<dt>Purpose</dt>
						<dd>
							{payment.challenge.description ??
								(payment.request.transport === "mcp"
									? `MCP · ${payment.request.tool}`
									: `${payment.request.method} ${new URL(payment.request.url).pathname}`)}
						</dd>
					</div>
					<div>
						<dt>Challenge</dt>
						<dd title={payment.challenge.challengeHash}>
							{short(payment.challenge.challengeHash, 12, 8)}
						</dd>
					</div>
					<div>
						<dt>Expires</dt>
						<dd>{new Date(payment.expiresAt).toLocaleString()}</dd>
					</div>
				</dl>

				<div className="budget-delta">
					<div>
						<span>Available now</span>
						<strong>{formatAtomic(payment.budget.availableAtomic)}</strong>
					</div>
					<span aria-hidden="true">→</span>
					<div>
						<span>After payment</span>
						<strong>{formatAtomic(after.toString())}</strong>
					</div>
				</div>

				<DialogFooter className="dialog-actions">
					<Button disabled={busy} onClick={onClose} variant="secondary">
						Reject
					</Button>
					<Button
						aria-label={busy ? "Approving payment" : undefined}
						loading={busy}
						onClick={onApprove}
					>
						Approve &amp; pay
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function ReceiptDetail({ receipt }: { receipt: Receipt }): ReactNode {
	return (
		<aside aria-label="Receipt detail" className="receipt-detail">
			<div className="receipt-seal">
				<Icon name="check" />
			</div>
			<p className="eyebrow">Payment settled</p>
			<h2>{formatAtomic(receipt.amountAtomic)} pathUSD</h2>
			<p className="muted">{new Date(receipt.timestamp).toLocaleString()}</p>
			<dl className="detail-list">
				<div>
					<dt>Receipt</dt>
					<dd>
						{receipt.id}
						<Button
							aria-label="Copy receipt ID"
							className="icon-button"
							onClick={() => copyText(receipt.id)}
							size="icon-sm"
							variant="ghost"
						>
							<Icon name="copy" />
						</Button>
					</dd>
				</div>
				<div>
					<dt>Origin</dt>
					<dd>{receipt.origin}</dd>
				</div>
				<div>
					<dt>Recipient</dt>
					<dd title={receipt.payee}>{short(receipt.payee, 10, 8)}</dd>
				</div>
				<div>
					<dt>Reference</dt>
					<dd title={receipt.reference}>{short(receipt.reference, 10, 8)}</dd>
				</div>
				<div>
					<dt>Network</dt>
					<dd>Tempo testnet · {receipt.chainId}</dd>
				</div>
			</dl>
		</aside>
	);
}

export function App(): ReactNode {
	const [activeTab, setActiveTab] = useState<Tab>("services");
	const [status, setStatus] = useState<Status | null>(null);
	const [services, setServices] = useState<Service[]>([]);
	const [receipts, setReceipts] = useState<Receipt[]>([]);
	const [selectedReceipt, setSelectedReceipt] = useState<Receipt | null>(null);
	const [pending, setPending] = useState<PreparedPayment | null>(null);
	const [paidUrl, setPaidUrl] = useState(DEFAULT_PAID_URL);
	const [paidMethod, setPaidMethod] = useState("GET");
	const [requestMode, setRequestMode] = useState<"http" | "mcp">("http");
	const [mcpTool, setMcpTool] = useState("premium_tool");
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		const [nextStatus, nextServices, nextReceipts] = await Promise.all([
			getStatus(),
			listServices(),
			listReceipts(),
		]);
		setStatus(nextStatus);
		setServices(nextServices);
		setReceipts(nextReceipts);
	}, []);

	useEffect(() => {
		setBusy("loading");
		refresh()
			.catch((reason: unknown) => setError(messageFrom(reason)))
			.finally(() => setBusy(null));
	}, [refresh]);

	const run = useCallback(async (key: string, action: () => Promise<void>) => {
		setBusy(key);
		setError(null);
		setNotice(null);
		try {
			await action();
		} catch (reason) {
			setError(messageFrom(reason));
		} finally {
			setBusy(null);
		}
	}, []);

	const handlePrepare = useCallback(
		() =>
			run("prepare", async () => {
				const result =
					requestMode === "mcp"
						? await prepareMcpPayment({
								arguments: {},
								tool: mcpTool.trim(),
								url: paidUrl.trim(),
							})
						: await preparePayment({ method: paidMethod, url: paidUrl.trim() });
				if (result.kind === "ready") {
					setNotice(
						`Endpoint returned HTTP ${result.resource.status}; no payment was required.`
					);
					return;
				}
				if (!result.payment.requiresApproval) {
					const paid = await pay(result.payment.approvalToken);
					await refresh();
					setSelectedReceipt(paid.receipt);
					setActiveTab("receipts");
					setNotice("Payment settled under the active auto-pay policy.");
					return;
				}
				setPending(result.payment);
			}),
		[mcpTool, paidMethod, paidUrl, refresh, requestMode, run]
	);

	const handlePay = useCallback(() => {
		if (!pending) {
			return;
		}
		setBusy("pay");
		setError(null);
		setNotice(null);
		void pay(pending.approvalToken)
			.then(async (result) => {
				setPending(null);
				await refresh();
				setSelectedReceipt(result.receipt);
				setActiveTab("receipts");
				setNotice("Payment verified and receipt saved.");
			})
			.catch((reason: unknown) => {
				setPending(null);
				setError(
					`Payment did not settle. Prepare a new review. ${messageFrom(reason)}`
				);
			})
			.finally(() => {
				setBusy(null);
			});
	}, [pending, refresh]);

	const filteredServices = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (!needle) {
			return services;
		}
		return services.filter((service) =>
			[service.name, service.description, service.url, ...service.categories]
				.join(" ")
				.toLowerCase()
				.includes(needle)
		);
	}, [query, services]);

	const handleTabKeyDown = useCallback(
		(event: KeyboardEvent<HTMLButtonElement>, tab: Tab) => {
			const currentIndex = TABS.indexOf(tab);
			let nextIndex = currentIndex;
			if (event.key === "ArrowRight") {
				nextIndex = (currentIndex + 1) % TABS.length;
			} else if (event.key === "ArrowLeft") {
				nextIndex = (currentIndex - 1 + TABS.length) % TABS.length;
			} else if (event.key === "Home") {
				nextIndex = 0;
			} else if (event.key === "End") {
				nextIndex = TABS.length - 1;
			} else {
				return;
			}
			event.preventDefault();
			const nextTab = TABS[nextIndex];
			if (!nextTab) {
				return;
			}
			setActiveTab(nextTab);
			document.getElementById(`tab-${nextTab}`)?.focus();
		},
		[]
	);

	return (
		<main className="app-shell">
			<header className="topbar">
				<div className="brand-lockup">
					<div className="brand-mark">
						<Icon name="wallet" />
					</div>
					<div>
						<h1>Payments</h1>
						<p>Review paid HTTP and MCP requests.</p>
					</div>
				</div>
				<span className="network-badge">
					<span /> Tempo testnet
				</span>
			</header>

			{status && (
				<section aria-label="Payment status" className="status-rail">
					<div className="wallet-identity">
						<span className="status-label">Wallet</span>
						{status.wallet.configured ? (
							<strong title={status.wallet.address ?? ""}>
								{short(status.wallet.address ?? "")}
							</strong>
						) : (
							<strong>Not configured</strong>
						)}
					</div>
					<div>
						<span className="status-label">Balance</span>
						<strong>
							{formatAtomic(status.wallet.balanceAtomic)} <small>pathUSD</small>
						</strong>
					</div>
					<div>
						<span className="status-label">Spent today</span>
						<strong>
							{formatAtomic(status.budget.spentAtomic)}{" "}
							<small>/ {formatAtomic(status.budget.dailyCapAtomic)}</small>
						</strong>
					</div>
					<div>
						<span className="status-label">Pending</span>
						<strong>
							{formatAtomic(status.budget.pendingAtomic)} <small>pathUSD</small>
						</strong>
					</div>
					{!status.wallet.configured && (
						<Button
							disabled={busy !== null}
							onClick={() =>
								void run("wallet", async () => {
									await createWallet();
									await refresh();
								})
							}
							size="sm"
						>
							Create wallet
						</Button>
					)}
					{status.wallet.configured && status.wallet.balanceAtomic === "0" && (
						<Button
							disabled={busy !== null}
							onClick={() =>
								void run("fund", async () => {
									await fundWallet();
									await refresh();
								})
							}
							size="sm"
							variant="secondary"
						>
							Fund testnet
						</Button>
					)}
				</section>
			)}

			<div aria-label="Payments sections" className="tabs" role="tablist">
				{TABS.map((tab) => (
					<Button
						aria-controls={`panel-${tab}`}
						aria-selected={activeTab === tab}
						className={activeTab === tab ? "tab active" : "tab"}
						id={`tab-${tab}`}
						key={tab}
						onClick={() => setActiveTab(tab)}
						onKeyDown={(event) => handleTabKeyDown(event, tab)}
						role="tab"
						tabIndex={activeTab === tab ? 0 : -1}
						variant="ghost"
					>
						{TAB_LABELS[tab]}
						{tab === "receipts" && receipts.length > 0 ? (
							<span>{receipts.length}</span>
						) : null}
					</Button>
				))}
			</div>

			<div aria-live="polite" className="messages">
				{error && (
					<div className="message error">
						<strong>Payment needs attention.</strong>
						<span>{error}</span>
						<Button onClick={() => setError(null)} size="xs" variant="ghost">
							Dismiss
						</Button>
					</div>
				)}
				{notice && (
					<div className="message success">
						<Icon name="check" />
						{notice}
						<Button onClick={() => setNotice(null)} size="xs" variant="ghost">
							Dismiss
						</Button>
					</div>
				)}
			</div>

			{activeTab === "services" && (
				<section
					aria-labelledby="tab-services"
					className="content-panel"
					id="panel-services"
					role="tabpanel"
				>
					<div className="section-heading">
						<div>
							<p className="eyebrow">Service catalog</p>
							<h2 id="services-title">MPP services</h2>
							<p>
								Choose an endpoint, then review the exact charge before Ryu
								signs it.
							</p>
						</div>
						<a
							className="text-link"
							href="https://mpp.dev"
							rel="noopener noreferrer"
							target="_blank"
						>
							Protocol guide <Icon name="arrow" />
						</a>
					</div>
					<form
						className="request-bar"
						onSubmit={(event) => {
							event.preventDefault();
							void handlePrepare();
						}}
					>
						<label>
							<span>Protocol</span>
							<NativeSelect
								aria-label="Payment protocol transport"
								name="transport"
								onChange={(event) =>
									setRequestMode(event.target.value === "mcp" ? "mcp" : "http")
								}
								value={requestMode}
							>
								<NativeSelectOption value="http">HTTP</NativeSelectOption>
								<NativeSelectOption value="mcp">MCP</NativeSelectOption>
							</NativeSelect>
						</label>
						{requestMode === "http" ? (
							<label>
								<span>Method</span>
								<NativeSelect
									aria-label="HTTP method"
									name="method"
									onChange={(event) => setPaidMethod(event.target.value)}
									value={paidMethod}
								>
									<NativeSelectOption>GET</NativeSelectOption>
									<NativeSelectOption>POST</NativeSelectOption>
									<NativeSelectOption>PUT</NativeSelectOption>
									<NativeSelectOption>PATCH</NativeSelectOption>
									<NativeSelectOption>DELETE</NativeSelectOption>
								</NativeSelect>
							</label>
						) : (
							<label>
								<span>Tool</span>
								<Input
									aria-label="MCP tool name"
									autoComplete="off"
									name="tool"
									onChange={(event) => setMcpTool(event.target.value)}
									pattern="[A-Za-z0-9._:/-]+"
									required
									spellCheck={false}
									value={mcpTool}
								/>{" "}
							</label>
						)}
						<label className="request-url">
							<span>
								{requestMode === "mcp" ? "MCP server URL" : "Paid endpoint URL"}
							</span>
							<Input
								autoComplete="url"
								name="endpoint"
								onChange={(event) => setPaidUrl(event.target.value)}
								placeholder={
									requestMode === "mcp"
										? "https://service.example/mcp"
										: "https://service.example/paid"
								}
								required
								spellCheck={false}
								type="url"
								value={paidUrl}
							/>
						</label>
						<Button
							aria-label={busy === "prepare" ? "Reviewing payment" : undefined}
							disabled={busy !== null || !status?.wallet.configured}
							loading={busy === "prepare"}
							type="submit"
						>
							Review payment {busy === "prepare" ? null : <Icon name="arrow" />}
						</Button>
					</form>
					{!status?.wallet.configured && (
						<p className="inline-hint">
							<Icon name="shield" /> Create a wallet before preparing a paid
							request. Keys stay in Ryu&apos;s encrypted app custody.
						</p>
					)}

					<div className="catalog-toolbar">
						<label className="search-field">
							<Icon name="search" />
							<span className="sr-only">Search services</span>
							<Input
								autoComplete="off"
								name="service-search"
								onChange={(event) => setQuery(event.target.value)}
								placeholder="Search services…"
								type="search"
								value={query}
							/>
						</label>
						<span>{filteredServices.length} services</span>
					</div>
					<div className="service-list">
						{filteredServices.map((service) => (
							<article className="service-row" key={service.id}>
								<div aria-hidden="true" className="service-monogram">
									{service.name.slice(0, 1).toUpperCase()}
								</div>
								<div className="service-copy">
									<div className="service-title">
										<h3>{service.name}</h3>
										{service.status && <span>{service.status}</span>}
									</div>
									<p>{service.description || service.url}</p>
									<div className="service-meta">
										<span>{new URL(service.url).hostname}</span>
										{service.categories.slice(0, 3).map((category) => (
											<span key={category}>{category}</span>
										))}
									</div>
								</div>
								<div className="service-actions">
									{service.endpoints.slice(0, 2).map((endpoint) => (
										<Button
											className="endpoint-button"
											key={`${endpoint.method}-${endpoint.path}`}
											onClick={() => {
												setRequestMode("http");
												setPaidMethod(endpoint.method);
												setPaidUrl(resolveEndpoint(service, endpoint.path));
											}}
											size="sm"
											variant="outline"
										>
											<span>{endpoint.method}</span>
											{endpoint.price ?? endpoint.path}
											<Icon name="arrow" />
										</Button>
									))}
									{service.endpoints.length === 0 && (
										<Button
											className="endpoint-button"
											onClick={() => setPaidUrl(service.url)}
											size="sm"
											variant="outline"
										>
											Use service URL <Icon name="arrow" />
										</Button>
									)}
								</div>
							</article>
						))}
						{busy === "loading" && (
							<div className="empty-state">Loading the service catalog…</div>
						)}
						{busy !== "loading" && filteredServices.length === 0 && (
							<div className="empty-state">No services match that search.</div>
						)}
					</div>
				</section>
			)}

			{activeTab === "policy" && status && (
				<PolicyPanel
					busy={busy !== null}
					onSaved={(policy) => setStatus({ ...status, policy })}
					policy={status.policy}
					run={run}
				/>
			)}

			{activeTab === "receipts" && (
				<section
					aria-labelledby="tab-receipts"
					className="receipts-panel content-panel"
					id="panel-receipts"
					role="tabpanel"
				>
					<div className="section-heading">
						<div>
							<p className="eyebrow">Local ledger</p>
							<h2 id="receipts-title">Receipts</h2>
							<p>Settlement records without credentials or request bodies.</p>
						</div>
					</div>
					<div className="receipts-layout">
						<div className="receipt-table">
							{receipts.map((receipt) => (
								<Button
									aria-current={selectedReceipt?.id === receipt.id}
									className="receipt-row"
									key={receipt.id}
									onClick={() => setSelectedReceipt(receipt)}
									variant="ghost"
								>
									<span className="receipt-icon">
										<Icon name="receipt" />
									</span>
									<span>
										<strong>
											{formatAtomic(receipt.amountAtomic)} pathUSD
										</strong>
										<small>{receipt.origin}</small>
									</span>
									<span>
										<strong>
											{new Date(receipt.timestamp).toLocaleDateString()}
										</strong>
										<small>
											{new Date(receipt.timestamp).toLocaleTimeString([], {
												hour: "2-digit",
												minute: "2-digit",
											})}
										</small>
									</span>
									<Icon name="arrow" />
								</Button>
							))}
							{receipts.length === 0 && (
								<div className="empty-state">
									<Icon name="receipt" />
									<strong>No receipts yet</strong>
									<span>Your verified payments will appear here.</span>
								</div>
							)}
						</div>
						{selectedReceipt ? (
							<ReceiptDetail receipt={selectedReceipt} />
						) : receipts[0] ? (
							<ReceiptDetail receipt={receipts[0]} />
						) : null}
					</div>
				</section>
			)}

			{pending && (
				<ApprovalDialog
					busy={busy === "pay"}
					onApprove={handlePay}
					onClose={() => setPending(null)}
					payment={pending}
				/>
			)}
		</main>
	);
}

function PolicyPanel({
	busy,
	onSaved,
	policy,
	run,
}: {
	busy: boolean;
	onSaved(policy: PaymentPolicy): void;
	policy: PaymentPolicy;
	run(key: string, action: () => Promise<void>): Promise<void>;
}): ReactNode {
	const [perRequest, setPerRequest] = useState(() =>
		formatAtomic(policy.maxPerRequestAtomic)
	);
	const [daily, setDaily] = useState(() =>
		formatAtomic(policy.dailySpendCapAtomic)
	);
	const [threshold, setThreshold] = useState(() =>
		formatAtomic(policy.approvalThresholdAtomic)
	);
	const [origins, setOrigins] = useState(() =>
		policy.allowedOrigins.join("\n")
	);
	const [autoPay, setAutoPay] = useState(policy.autoPay);

	const submit = (event: FormEvent) => {
		event.preventDefault();
		void run("policy", async () => {
			const allowedOrigins = origins
				.split(/\r?\n/)
				.map((origin) => origin.trim())
				.filter(Boolean);
			const next = await savePolicy({
				...policy,
				allowedOrigins,
				approvalThresholdAtomic: toAtomic(threshold),
				autoPay,
				dailySpendCapAtomic: toAtomic(daily),
				maxPerRequestAtomic: toAtomic(perRequest),
			});
			onSaved(next);
		});
	};

	return (
		<section
			aria-labelledby="tab-policy"
			className="policy-panel content-panel"
			id="panel-policy"
			role="tabpanel"
		>
			<div className="section-heading">
				<div>
					<p className="eyebrow">Guardrails</p>
					<h2 id="policy-title">Payment policy</h2>
					<p>Every limit is enforced again immediately before signing.</p>
				</div>
				<span className="policy-state">
					<Icon name="shield" /> Testnet only
				</span>
			</div>
			<form onSubmit={submit}>
				<fieldset>
					<legend>Spend limits</legend>
					<p>
						Amounts are pathUSD. Exact values are stored as integer atomic
						units.
					</p>
					<div className="field-grid">
						<label>
							<span>Maximum per request</span>
							<div className="money-input">
								<span>$</span>
								<Input
									autoComplete="off"
									inputMode="decimal"
									name="maximum-per-request"
									onChange={(event) => setPerRequest(event.target.value)}
									required
									value={perRequest}
								/>
							</div>
						</label>
						<label>
							<span>Daily spend cap</span>
							<div className="money-input">
								<span>$</span>
								<Input
									autoComplete="off"
									inputMode="decimal"
									name="daily-spend-cap"
									onChange={(event) => setDaily(event.target.value)}
									required
									value={daily}
								/>
							</div>
						</label>
						<label>
							<span>Approval threshold</span>
							<div className="money-input">
								<span>$</span>
								<Input
									autoComplete="off"
									inputMode="decimal"
									name="approval-threshold"
									onChange={(event) => setThreshold(event.target.value)}
									required
									value={threshold}
								/>
							</div>
							<small>Charges above this always need review.</small>
						</label>
					</div>
				</fieldset>
				<fieldset>
					<legend>Trusted origins</legend>
					<p>
						One normalized HTTPS origin per line. Redirects may never leave the
						original origin.
					</p>
					<label>
						<span className="sr-only">Allowed origins</span>
						<Textarea
							autoComplete="off"
							name="allowed-origins"
							onChange={(event) => setOrigins(event.target.value)}
							rows={5}
							spellCheck={false}
							value={origins}
						/>
					</label>
				</fieldset>
				<fieldset>
					<legend>Automation</legend>
					<label className="switch-row">
						<span>
							<strong>Auto-pay below threshold</strong>
							<small>
								Allow prepared requests inside every guardrail to settle without
								another modal. Agent tool calls still pass through Ryu’s action
								approval.
							</small>
						</span>
						<Switch
							aria-label="Auto-pay below threshold"
							checked={autoPay}
							onCheckedChange={setAutoPay}
						/>
					</label>
				</fieldset>
				<div className="form-actions">
					<span>Method: Tempo charge · Currency: pathUSD · Chain: 42431</span>
					<Button disabled={busy} type="submit">
						Save policy
					</Button>
				</div>
			</form>
		</section>
	);
}
