import {
	markCompanionAppRoot,
	subscribeCompanionTheme,
} from "@ryu/app-host/companion-theme";
import { RyuAppShell } from "@ryu/blocks/companion/app-ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import "./styles.css";

subscribeCompanionTheme();

const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing application root.");
}

markCompanionAppRoot(root);

createRoot(root).render(
	<StrictMode>
		<RyuAppShell>
			<App />
		</RyuAppShell>
	</StrictMode>
);
