import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogTitle,
} from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { formatDateTime } from "@ryu/ui/lib/timezone.ts";
import type { ReactNode } from "react";

import { formatAtomic, short } from "./App-format.ts";
import type { PreparedPayment } from "./types.ts";

export function ApprovalDialog({
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
	const tl = useLiteralMessages();
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
				<DialogTitle id="approval-title">
					{tl("Approve {amount} pathUSD?", {
						amount: formatAtomic(payment.challenge.amountAtomic),
					})}
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
						<dd>
							{tl("Tempo testnet · {chainId}", {
								chainId: String(payment.challenge.chainId),
							})}
						</dd>
					</div>
					<div>
						<dt>Purpose</dt>
						<dd>
							{payment.challenge.description ??
								(payment.request.transport === "mcp"
									? tl("MCP · {tool}", { tool: payment.request.tool })
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
						<dd>{formatDateTime(payment.expiresAt)}</dd>
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
