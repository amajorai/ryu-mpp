import type { ReactNode } from "react";

export type IconName =
	| "arrow"
	| "check"
	| "copy"
	| "receipt"
	| "search"
	| "shield"
	| "wallet";

export function Icon({ name }: { name: IconName }): ReactNode {
	const paths = {
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
	} satisfies Record<IconName, ReactNode>;
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
