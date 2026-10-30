import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { formatDateTime } from "@ryu/ui/lib/timezone.ts";
import type { ReactNode } from "react";

import { copyText, formatAtomic, short } from "./App-format.ts";
import { Icon } from "./App-icon.tsx";
import type { Receipt } from "./types.ts";

export function ReceiptDetail({ receipt }: { receipt: Receipt }): ReactNode {
	const tl = useLiteralMessages();
	return (
		<aside aria-label="Receipt detail" className="receipt-detail">
			<div className="receipt-seal">
				<Icon name="check" />
			</div>
			<h2>{formatAtomic(receipt.amountAtomic)} pathUSD</h2>
			<p className="muted">{formatDateTime(receipt.timestamp)}</p>
			<dl className="detail-list">
				<div>
					<dt>Receipt</dt>
					<dd>
						{receipt.id}
						<Button
							aria-label="Copy receipt ID"
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
					<dd>
						{tl("Tempo testnet · {chainId}", {
							chainId: String(receipt.chainId),
						})}
					</dd>
				</div>
			</dl>
		</aside>
	);
}
