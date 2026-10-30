import { Button, Switch, Textarea } from "@ryu/blocks/companion/controls";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@ryu/ui/components/input-group.tsx";
import { type ReactNode, type SubmitEvent, useState } from "react";
import { formatAtomic, toAtomic } from "./App-format.ts";
import { Icon } from "./App-icon.tsx";
import { savePolicy } from "./api.ts";
import type { PaymentPolicy } from "./types.ts";

export function PolicyPanel({
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

	const submit = (event: SubmitEvent) => {
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
			aria-labelledby="policy-title"
			className="policy-panel content-panel"
			id="panel-policy"
			role="tabpanel"
		>
			<div className="section-heading">
				<div>
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
							<InputGroup>
								<InputGroupAddon>$</InputGroupAddon>
								<InputGroupInput
									autoComplete="off"
									inputMode="decimal"
									name="maximum-per-request"
									onChange={(event) => setPerRequest(event.target.value)}
									required
									value={perRequest}
								/>
							</InputGroup>
						</label>
						<label>
							<span>Daily spend cap</span>
							<InputGroup>
								<InputGroupAddon>$</InputGroupAddon>
								<InputGroupInput
									autoComplete="off"
									inputMode="decimal"
									name="daily-spend-cap"
									onChange={(event) => setDaily(event.target.value)}
									required
									value={daily}
								/>
							</InputGroup>
						</label>
						<label>
							<span>Approval threshold</span>
							<InputGroup>
								<InputGroupAddon>$</InputGroupAddon>
								<InputGroupInput
									autoComplete="off"
									inputMode="decimal"
									name="approval-threshold"
									onChange={(event) => setThreshold(event.target.value)}
									required
									value={threshold}
								/>
							</InputGroup>
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
