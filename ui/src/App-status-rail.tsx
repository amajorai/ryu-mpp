import { Button } from "@ryu/blocks/companion/controls";
import type { ReactNode } from "react";
import { formatAtomic, short } from "./App-format.ts";
import { createWallet, fundWallet } from "./api.ts";
import type { Status } from "./types.ts";

export function StatusRail({
	busy,
	refresh,
	run,
	status,
}: {
	busy: string | null;
	refresh(): Promise<void>;
	run(key: string, action: () => Promise<void>): Promise<void>;
	status: Status;
}): ReactNode {
	return (
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
	);
}
