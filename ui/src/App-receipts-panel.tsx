import { Button } from "@ryu/blocks/companion/controls";
import { formatDate, formatTime } from "@ryu/ui/lib/timezone.ts";
import type { ReactNode } from "react";

import { formatAtomic } from "./App-format.ts";
import { Icon } from "./App-icon.tsx";
import { ReceiptDetail } from "./App-receipt-detail.tsx";
import type { Receipt } from "./types.ts";

export function ReceiptsPanel({
	receipts,
	selectedReceipt,
	setSelectedReceipt,
}: {
	receipts: Receipt[];
	selectedReceipt: Receipt | null;
	setSelectedReceipt(receipt: Receipt): void;
}): ReactNode {
	return (
		<section
			aria-labelledby="receipts-title"
			className="content-panel"
			id="panel-receipts"
			role="tabpanel"
		>
			<div className="section-heading">
				<div>
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
								<strong>{formatAtomic(receipt.amountAtomic)} pathUSD</strong>
								<small>{receipt.origin}</small>
							</span>
							<span>
								<strong>{formatDate(receipt.timestamp)}</strong>
								<small>
									{formatTime(receipt.timestamp, {
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
	);
}
