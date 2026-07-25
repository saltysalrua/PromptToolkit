import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * ComfyUI AI-bridge tools.
 *
 * Talks to the PromptToolkit custom node's HTTP bridge (nodes/ai_bridge.py)
 * running inside the local ComfyUI server. No MCP, no extra processes —
 * just HTTP to 127.0.0.1:8188.
 *
 * Tools:
 *   comfyui_get_prompt        Read the current prompt text of PromptPanel nodes
 *   comfyui_set_prompt        Write a new positive prompt into a PromptPanel node
 *   comfyui_get_resolution    Read the state of Resolution Master nodes
 *   comfyui_set_resolution    Set width/height/batch size of a Resolution Master node
 *   comfyui_queue             Queue the current graph (optionally wait for the image)
 *   comfyui_get_latest_image  List the newest images from AI Image Output nodes
 */

const BASE_URL = (process.env.COMFYUI_URL ?? "http://127.0.0.1:8188").replace(
	/\/+$/,
	"",
);

async function api<T = unknown>(
	path: string,
	options?: RequestInit,
): Promise<T> {
	const res = await fetch(BASE_URL + path, options);
	const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	if (!res.ok) {
		throw new Error(
			`ComfyUI bridge ${path} -> HTTP ${res.status}: ${JSON.stringify(body)}`,
		);
	}
	return body as T;
}

async function apiPost<T = unknown>(path: string, payload?: unknown): Promise<T> {
	return api<T>(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload ?? {}),
	});
}

interface ImageEntry {
	node_id: string | null;
	filename: string;
	subfolder: string;
	type: string;
	abs_path: string;
	/** Lanczos-downscaled JPEG for review (may be null on old entries). */
	preview_path?: string | null;
	time: number;
}

interface ResolutionState {
	width: number | null;
	height: number | null;
	batch_size: number | null;
	mode: string | null;
	latent_type: string | null;
	auto_detect: boolean | null;
	rescale_mode: string | null;
	/** Computed upscale factor (after applying rescale_mode). */
	rescale_value: number | null;
}

function formatResolution(nodeId: string, s: ResolutionState): string {
	const lines = [
		`Node ${nodeId}: ${s.width}×${s.height} (batch ${s.batch_size ?? "?"})`,
		`  mode=${s.mode ?? "?"} latent_type=${s.latent_type ?? "?"}`,
		`  rescale=${s.rescale_mode ?? "?"} factor=${
			typeof s.rescale_value === "number" ? s.rescale_value.toFixed(3) : "?"
		}`,
	];
	if (s.auto_detect) lines.push("  auto_detect=on (input image overrides)");
	return lines.join("\n");
}

/** Round to the nearest multiple of 8 and clamp into [8, 32768]. */
function snapDim(v: number): number {
	return Math.min(Math.max(Math.round(v / 8) * 8, 8), 32768);
}

function formatImages(images: ImageEntry[]): string {
	if (images.length === 0) {
		return "No images published yet. Run a graph containing an 'AI Image Output' node first.";
	}
	return images
		.map(
			(img, i) =>
				`${i}: ${img.preview_path ?? img.abs_path}\n   full-res: ${img.abs_path}\n   node=${img.node_id ?? "?"} time=${new Date(
					img.time * 1000,
				).toLocaleTimeString()}`,
		)
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "comfyui_get_prompt",
		label: "ComfyUI Get Prompt",
		description:
			"Read the current positive prompt text of PromptPanel nodes in the running ComfyUI. " +
			"Without node_id returns all registered nodes as {node_id: text}.",
		promptSnippet: "Read the current ComfyUI PromptPanel prompt text",
		parameters: Type.Object({
			node_id: Type.Optional(
				Type.String({ description: "PromptPanel node id; omit to list all" }),
			),
		}),
		async execute(_id, params) {
			if (params.node_id) {
				const data = await api<{ node_id: string; positive: string }>(
					`/pt/ai/prompt/${encodeURIComponent(params.node_id)}`,
				);
				return {
					content: [
						{
							type: "text",
							text: `Node ${data.node_id} positive prompt:\n${data.positive}`,
						},
					],
					details: data,
				};
			}
			const data = await api<{ prompts: Record<string, string> }>(
				"/pt/ai/prompt",
			);
			const entries = Object.entries(data.prompts);
			const text =
				entries.length === 0
					? "No prompts registered yet. The frontend syncs PromptPanel values every ~1.5s — make sure a browser tab with the graph is open (or the node has executed once)."
					: entries
							.map(([id, t]) => `Node ${id}:\n${t || "(empty)"}`)
							.join("\n\n");
			return { content: [{ type: "text", text }], details: data };
		},
	});

	pi.registerTool({
		name: "comfyui_set_prompt",
		label: "ComfyUI Set Prompt",
		description:
			"Set the positive prompt text of a PromptPanel node in the running ComfyUI. " +
			"The on-screen widget updates live via websocket.",
		promptSnippet: "Write a new prompt into a ComfyUI PromptPanel node",
		parameters: Type.Object({
			node_id: Type.String({ description: "PromptPanel node id" }),
			positive: Type.String({ description: "New positive prompt text" }),
		}),
		async execute(_id, params) {
			await apiPost("/pt/ai/prompt/set", {
				node_id: params.node_id,
				positive: params.positive,
			});
			return {
				content: [
					{
						type: "text",
						text: `Prompt set on node ${params.node_id} (${params.positive.length} chars).`,
					},
				],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "comfyui_get_resolution",
		label: "ComfyUI Get Resolution",
		description:
			"Read the current state (width, height, batch size, latent type, rescale factor) " +
			"of Resolution Master nodes in the running ComfyUI. " +
			"Without node_id returns all registered nodes.",
		promptSnippet: "Read the current ComfyUI Resolution Master state",
		parameters: Type.Object({
			node_id: Type.Optional(
				Type.String({
					description: "Resolution Master node id; omit to list all",
				}),
			),
		}),
		async execute(_id, params) {
			if (params.node_id) {
				const data = await api<{ node_id: string; state: ResolutionState }>(
					`/pt/ai/resolution/${encodeURIComponent(params.node_id)}`,
				);
				return {
					content: [
						{ type: "text", text: formatResolution(data.node_id, data.state) },
					],
					details: data,
				};
			}
			const data = await api<{
				resolutions: Record<string, ResolutionState>;
			}>("/pt/ai/resolution");
			const entries = Object.entries(data.resolutions);
			const text =
				entries.length === 0
					? "No Resolution Master nodes registered yet. The frontend syncs " +
						"widget values every ~1.5s — make sure a browser tab with the " +
						"graph is open (or the node has executed once)."
					: entries.map(([id, s]) => formatResolution(id, s)).join("\n\n");
			return { content: [{ type: "text", text }], details: data };
		},
	});

	pi.registerTool({
		name: "comfyui_set_resolution",
		label: "ComfyUI Set Resolution",
		description:
			"Set width/height (and optionally batch size, latent type, rescale) of a " +
			"Resolution Master node in the running ComfyUI. width/height are snapped " +
			"to a multiple of 8. The on-screen node updates live via websocket. " +
			"rescale_value semantics depend on rescale_mode: manual = the factor " +
			"itself (e.g. 2 for 2x); resolution = target P of a 16:9 frame " +
			"(e.g. 1080); megapixels = target MP (e.g. 2.0).",
		promptSnippet: "Set the resolution of a ComfyUI Resolution Master node",
		parameters: Type.Object({
			node_id: Type.String({ description: "Resolution Master node id" }),
			width: Type.Optional(
				Type.Number({ description: "Image width in px (snapped to multiple of 8)" }),
			),
			height: Type.Optional(
				Type.Number({ description: "Image height in px (snapped to multiple of 8)" }),
			),
			batch_size: Type.Optional(
				Type.Number({ description: "Latent batch size (1-4096)" }),
			),
			latent_type: Type.Optional(
				Type.Union([Type.Literal("latent_4x8"), Type.Literal("latent_128x16")], {
					description: "latent_4x8 = SD1.5/SDXL/Flux; latent_128x16 = Flux 2",
				}),
			),
			rescale_mode: Type.Optional(
				Type.Union(
					[
						Type.Literal("manual"),
						Type.Literal("resolution"),
						Type.Literal("megapixels"),
					],
					{ description: "How rescale_value is interpreted" },
				),
			),
			rescale_value: Type.Optional(
				Type.Number({
					description:
						"manual: factor itself; resolution: target P (e.g. 1080); " +
						"megapixels: target MP (e.g. 2.0)",
				}),
			),
		}),
		async execute(_id, params) {
			const payload: Record<string, unknown> = { node_id: params.node_id };
			if (params.width != null) payload.width = snapDim(params.width);
			if (params.height != null) payload.height = snapDim(params.height);
			if (params.batch_size != null)
				payload.batch_size = Math.min(
					Math.max(Math.round(params.batch_size), 1),
					4096,
				);
			if (params.latent_type != null) payload.latent_type = params.latent_type;
			if (params.rescale_mode != null)
				payload.rescale_mode = params.rescale_mode;
			if (params.rescale_value != null)
				payload.rescale_value = params.rescale_value;

			const res = await apiPost<{ state: ResolutionState }>(
				"/pt/ai/resolution/set",
				payload,
			);
			return {
				content: [
					{
						type: "text",
						text: `Resolution set:\n${formatResolution(params.node_id, res.state)}`,
					},
				],
				details: res,
			};
		},
	});

	pi.registerTool({
		name: "comfyui_queue",
		label: "ComfyUI Queue",
		description:
			"Queue the current ComfyUI graph once (requires the ComfyUI browser tab to be open). " +
			"With wait=true (default) polls until a new AI Image Output image appears and returns it.",
		promptSnippet: "Queue the current ComfyUI graph and fetch the result",
		parameters: Type.Object({
			wait: Type.Optional(
				Type.Boolean({
					description: "Wait for a new generated image (default true)",
				}),
			),
			timeout_secs: Type.Optional(
				Type.Number({ description: "Max wait seconds (default 300)" }),
			),
		}),
		async execute(_id, params, signal, onUpdate) {
			const wait = params.wait ?? true;
			const timeoutMs = (params.timeout_secs ?? 300) * 1000;

			let before = 0;
			if (wait) {
				const latest = await api<{ images: ImageEntry[] }>(
					"/pt/ai/image/latest?limit=1",
				).catch(() => ({ images: [] as ImageEntry[] }));
				before = latest.images[0]?.time ?? 0;
			}

			await apiPost("/pt/ai/queue");
			if (!wait) {
				return {
					content: [{ type: "text", text: "Graph queued." }],
					details: {},
				};
			}

			const deadline = Date.now() + timeoutMs;
			let idlePolls = 0;
			while (Date.now() < deadline) {
				if (signal?.aborted) {
					return { content: [{ type: "text", text: "Cancelled" }] };
				}
				await new Promise((r) => setTimeout(r, 3000));
				const latest = await api<{ images: ImageEntry[] }>(
					"/pt/ai/image/latest?limit=1",
				).catch(() => null);
				const newest = latest?.images[0];
				if (newest && newest.time > before) {
					return {
						content: [
							{
								type: "text",
								text: `Generation finished. New image (compressed preview):\n${newest.preview_path ?? newest.abs_path}\nRead this file to view it. Full-res PNG: ${newest.abs_path}`,
							},
						],
						details: newest,
					};
				}
				// Bail early once the queue has drained without publishing an
				// image — the graph almost certainly has no AI Image Output node.
				const q = await api<{
					queue_running?: unknown[];
					queue_pending?: unknown[];
				}>("/queue").catch(() => null);
				if (q) {
					const busy =
						(q.queue_running?.length ?? 0) + (q.queue_pending?.length ?? 0);
					idlePolls = busy === 0 ? idlePolls + 1 : 0;
					if (idlePolls >= 2) {
						throw new Error(
							"Queue finished but no image was published to the bridge. " +
								"Add an 'AI Image Output' node to the graph (connect it to the image output) and try again.",
						);
					}
				}
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `Waiting for generation… (${Math.round((timeoutMs - (deadline - Date.now())) / 1000)}s elapsed)`,
						},
					],
				});
			}
			throw new Error(
				`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for a new image. ` +
					"Is an 'AI Image Output' node in the graph and the queue actually running?",
			);
		},
	});

	pi.registerTool({
		name: "comfyui_get_latest_image",
		label: "ComfyUI Latest Image",
		description:
			"List the newest images published by 'AI Image Output' nodes (newest first). " +
			"Returns absolute file paths — read them with the read tool to view.",
		promptSnippet: "List the newest images from ComfyUI AI Image Output nodes",
		parameters: Type.Object({
			limit: Type.Optional(
				Type.Number({ description: "How many entries (default 5)" }),
			),
		}),
		async execute(_id, params) {
			const data = await api<{ images: ImageEntry[] }>(
				`/pt/ai/image/latest?limit=${params.limit ?? 5}`,
			);
			return {
				content: [{ type: "text", text: formatImages(data.images) }],
				details: data,
			};
		},
	});
}
