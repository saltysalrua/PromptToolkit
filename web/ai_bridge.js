import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

/**
 * Frontend side of the PromptToolkit AI bridge (see nodes/ai_bridge.py).
 *
 * - Listens for websocket events pushed by the backend:
 *     "pt_ai_set_prompt" {node_id, positive} -> update the node's widget
 *     "pt_ai_queue"                          -> press the Queue button
 * - Pushes PromptPanel widget values to the backend whenever they change,
 *   so the harness can always read the current prompt over HTTP.
 */

const PUSH_INTERVAL_MS = 1500;

/** node_id (str) -> last pushed positive text. */
const lastPushed = new Map();

function findNode(nodeId) {
	const id = Number(nodeId);
	return app.graph?._nodes?.find((n) => n.id === id) ?? null;
}

function getPositiveWidget(node) {
	return node?.widgets?.find((w) => w.name === "positive") ?? null;
}

function pushPrompt(node, force = false) {
	const w = getPositiveWidget(node);
	if (!w) return;
	const key = String(node.id);
	const value = w.value ?? "";
	if (!force && lastPushed.get(key) === value) return;
	lastPushed.set(key, value);
	api
		.fetchApi("/pt/ai/prompt/update", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ node_id: key, positive: value }),
		})
		.catch(() => {
			// Backend unreachable: drop the cache entry so we retry later.
			lastPushed.delete(key);
		});
}

app.registerExtension({
	name: "PromptToolkit.AIBridge",

	setup() {
		// Harness -> frontend: set a PromptPanel node's prompt text.
		api.addEventListener("pt_ai_set_prompt", (event) => {
			const { node_id, positive } = event.detail ?? {};
			const node = findNode(node_id);
			const w = getPositiveWidget(node);
			if (!w) {
				console.warn(
					`[PromptToolkit] pt_ai_set_prompt: node ${node_id} not found`,
				);
				return;
			}
			w.value = positive ?? "";
			w.callback?.(w.value);
			lastPushed.set(String(node_id), w.value);
			node.setDirtyCanvas?.(true, true);
		});

		// Harness -> frontend: queue the current graph once.
		api.addEventListener("pt_ai_queue", () => {
			app.queuePrompt(0, 1);
		});

		// Frontend -> backend: keep the registry in sync with the widgets.
		setInterval(() => {
			const nodes = app.graph?._nodes ?? [];
			for (const node of nodes) {
				if (node.type === "PromptPanel") pushPrompt(node);
			}
		}, PUSH_INTERVAL_MS);
	},
});
