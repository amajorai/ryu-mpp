import { Button, Input } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Tabs, TabsList, TabsTrigger } from "@ryu/ui/components/tabs.tsx";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { ApprovalDialog } from "./App-approval-dialog.tsx";
import {
	DEFAULT_PAID_URL,
	initialTab,
	messageFrom,
	resolveEndpoint,
	type Tab,
} from "./App-format.ts";
import { Icon } from "./App-icon.tsx";
import { PolicyPanel } from "./App-policy-panel.tsx";
import { ReceiptsPanel } from "./App-receipts-panel.tsx";
import { StatusRail } from "./App-status-rail.tsx";
import {
	getStatus,
	listReceipts,
	listServices,
	pay,
	prepareMcpPayment,
	preparePayment,
} from "./api.ts";
import type { PreparedPayment, Receipt, Service, Status } from "./types.ts";

export function App(): ReactNode {
	const tl = useLiteralMessages();
	const [activeTab, setActiveTab] = useState<Tab>(initialTab);
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
			.catch((reason) => setError(messageFrom(reason)))
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
						tl("Endpoint returned HTTP {status}; no payment was required.", {
							status: String(result.resource.status),
						})
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
		[mcpTool, paidMethod, paidUrl, refresh, requestMode, run, tl]
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
			.catch((reason) => {
				setPending(null);
				setError(
					tl("Payment did not settle. Prepare a new review. {reason}", {
						reason: messageFrom(reason),
					})
				);
			})
			.finally(() => {
				setBusy(null);
			});
	}, [pending, refresh, tl]);

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
				<StatusRail busy={busy} refresh={refresh} run={run} status={status} />
			)}

			<div className="view-tabs">
				<Tabs
					onValueChange={(value) => {
						if (
							value === "services" ||
							value === "policy" ||
							value === "receipts"
						) {
							setActiveTab(value);
						}
					}}
					value={activeTab}
				>
					<TabsList
						activateOnFocus
						aria-label="Payment views"
						manageLayout={false}
						persistLayout={false}
						variant="line"
					>
						<TabsTrigger value="services">Services</TabsTrigger>
						<TabsTrigger value="policy">Policy</TabsTrigger>
						<TabsTrigger value="receipts">Receipts</TabsTrigger>
					</TabsList>
				</Tabs>
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
					aria-labelledby="services-title"
					className="content-panel"
					id="panel-services"
					role="tabpanel"
				>
					<div className="section-heading">
						<div>
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
						<label>
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
							{tl("Review payment")}{" "}
							{busy === "prepare" ? null : <Icon name="arrow" />}
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
						<span>
							{tl(
								"{count, plural, one {{shown} services} other {{shown} services}}",
								{
									count: filteredServices.length,
									shown: String(filteredServices.length),
								}
							)}
						</span>
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
				<ReceiptsPanel
					receipts={receipts}
					selectedReceipt={selectedReceipt}
					setSelectedReceipt={setSelectedReceipt}
				/>
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
