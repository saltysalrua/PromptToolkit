import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

/**
 * Frontend side of the PromptToolkit AI bridge (see nodes/ai_bridge.py).
 *
 * - Listens for websocket events pushed by the backend:
 *     "pt_ai_set_prompt" {node_id, positive} -> update the node's widget
 *     "pt_ai_set_resolution" {node_id, state} -> update Resolution Master
 *     "pt_ai_queue"                          -> press the Queue button
 * - Pushes PromptPanel / ResolutionMasterPT widget values to the backend
 *   whenever they change, so the harness can read them over HTTP.
 */

const PUSH_INTERVAL_MS = 1500;

/** node_id (str) -> last pushed positive text. */
const lastPushed = new Map();

/** node_id (str) -> last pushed resolution state JSON. */
const lastPushedResolution = new Map();

function findNode(nodeId) {
	const id = Number(nodeId);
	return app.graph?._nodes?.find((n) => n.id === id) ?? null;
}

function getPositiveWidget(node) {
	return node?.widgets?.find((w) => w.name === "positive") ?? null;
}

function getResolutionState(node) {
	const grab = (name) =>
		node?.widgets?.find((w) => w.name === name)?.value ?? null;
	return {
		width: grab("width"),
		height: grab("height"),
		batch_size: grab("batch_size"),
		mode: grab("mode"),
		latent_type: grab("latent_type"),
		auto_detect: grab("auto_detect"),
		rescale_mode: grab("rescale_mode"),
		rescale_value: grab("rescale_value"),
	};
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

function pushResolution(node, force = false) {
	if (!node) return;
	const key = String(node.id);
	const state = getResolutionState(node);
	const json = JSON.stringify(state);
	if (!force && lastPushedResolution.get(key) === json) return;
	lastPushedResolution.set(key, json);
	api
		.fetchApi("/pt/ai/resolution/update", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ node_id: key, state }),
		})
		.catch(() => {
			// Backend unreachable: drop the cache entry so we retry later.
			lastPushedResolution.delete(key);
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

		// Harness -> frontend: set a ResolutionMasterPT node's widgets.
		api.addEventListener("pt_ai_set_resolution", (event) => {
			const { node_id, state } = event.detail ?? {};
			const node = findNode(node_id);
			if (!node || node.type !== "ResolutionMasterPT") {
				console.warn(
					`[PromptToolkit] pt_ai_set_resolution: node ${node_id} not found`,
				);
				return;
			}
			if (typeof node._ptResolutionApply === "function") {
				// Preferred path: the Resolution Master UI applies the patch and
				// recomputes the rescale factor (see web/resolution_master.js).
				node._ptResolutionApply(state ?? {});
			} else {
				// Fallback: write the widgets directly (no rescale recompute).
				for (const [name, value] of Object.entries(state ?? {})) {
					const w = node.widgets?.find((x) => x.name === name);
					if (w) {
						w.value = value;
						w.callback?.(w.value);
					}
				}
			}
			// Force a fresh push so the backend registry reflects the real
			// widget values (including the recomputed rescale factor).
			lastPushedResolution.delete(String(node_id));
			node.setDirtyCanvas?.(true, true);
		});

		// Harness -> frontend: queue the current graph once.
		//
		// When multiple ComfyUI browser tabs are open, EVERY tab receives
		// this broadcast; without a guard each one queues its own (possibly
		// stale) graph. So: the focused tab queues immediately, unfocused
		// tabs wait a beat and back off if another tab already claimed the
		// queue (cross-tab claim via localStorage).
		api.addEventListener("pt_ai_queue", () => {
			const tryQueue = () => {
				let last = 0;
				try {
					last = Number(localStorage.getItem("pt_ai_last_queue") || 0);
				} catch {
					/* localStorage unavailable: just queue */
				}
				if (Date.now() - last < 5000) return; // another tab claimed it
				try {
					localStorage.setItem("pt_ai_last_queue", String(Date.now()));
				} catch {
					/* ignore */
				}
				app.queuePrompt(0, 1);
			};
			if (document.hasFocus()) tryQueue();
			else setTimeout(tryQueue, 150 + Math.random() * 150);
		});

		// Frontend -> backend: keep the registry in sync with the widgets.
		setInterval(() => {
			const nodes = app.graph?._nodes ?? [];
			for (const node of nodes) {
				if (node.type === "PromptPanel") pushPrompt(node);
				else if (node.type === "ResolutionMasterPT") pushResolution(node);
			}
		}, PUSH_INTERVAL_MS);
	},
});
