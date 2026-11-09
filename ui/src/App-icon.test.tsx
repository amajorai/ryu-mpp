import { describe, expect, test } from "bun:test";
import { DIRECTIONAL_ICON_CLASS } from "@ryu/ui/components/directional-icon.tsx";
import { renderToStaticMarkup } from "react-dom/server";
import { Icon } from "./App-icon.tsx";

// The forward arrow points toward the inline end, so under dir="rtl" it
// mirrors with the layout; symmetric glyphs never mirror.
describe("Icon direction", () => {
	test("the arrow carries the directional mirror class", () => {
		const html = renderToStaticMarkup(<Icon name="arrow" />);
		expect(html).toContain(`class="icon ${DIRECTIONAL_ICON_CLASS}"`);
	});

	test("non-directional glyphs do not mirror", () => {
		for (const name of ["check", "copy", "search", "wallet"] as const) {
			const html = renderToStaticMarkup(<Icon name={name} />);
			expect(html).toContain('class="icon"');
			expect(html).not.toContain(DIRECTIONAL_ICON_CLASS);
		}
	});
});
