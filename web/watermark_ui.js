import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

/**
 * Visual watermark editor for PromptToolkit nodes.
 *
 * Adds a DOM widget with an interactive canvas: drag the watermark to move
 * it, drag the bottom-right handle (or use the mouse wheel over the
 * watermark) to resize it. Position/scale live in hidden numeric widgets so
 * they serialize with the workflow and are sent to the Python node.
 *
 * Compatible with both the legacy LiteGraph canvas renderer and Nodes 2.0
 * (Vue nodes): DOM widgets render via WidgetDOM.vue in Vue mode, and the
 * numeric widgets are hidden with `options.hidden` (Vue mode) plus the
 * `converted-widget` + zero-size trick (legacy mode).
 */

const HANDLE = 7; // half-size of the resize handle in px
const ASPECTS = [
	[1, 1, "1:1"],
	[4, 3, "4:3"],
	[3, 4, "3:4"],
	[16, 9, "16:9"],
	[9, 16, "9:16"],
];

const NODE_CONFIGS = {
	ApplyWatermark: {
		posX: "pos_x",
		posY: "pos_y",
		scale: "scale_percent",
		opacity: "opacity",
		margin: "margin_percent",
		hide: ["pos_x", "pos_y", "scale_percent"],
		wmInput: "watermark",
	},
	SaveImageStripTags: {
		posX: "watermark_pos_x",
		posY: "watermark_pos_y",
		scale: "watermark_scale",
		opacity: "watermark_opacity",
		margin: "watermark_margin",
		hide: ["watermark_pos_x", "watermark_pos_y", "watermark_scale"],
		wmInput: "watermark",
	},
};

/** Hide a widget in both rendering modes while keeping it serialized. */
function hideWidget(widget) {
	if (!widget || widget.type === "converted-widget") return;
	widget.hidden = true; // DOM widgets & Vue data layer
	widget.options = widget.options || {};
	widget.options.hidden = true; // Nodes 2.0 (Vue) filter
	widget.computeSize = () => [0, -4]; // legacy canvas collapse
	widget.type = "converted-widget";
}

function getWidget(node, name) {
	return node.widgets?.find((w) => w.name === name);
}

function getVal(node, name, fallback) {
	const w = getWidget(node, name);
	const v = Number(w?.value);
	return Number.isFinite(v) ? v : fallback;
}

function setVal(node, name, value) {
	const w = getWidget(node, name);
	if (!w) return;
	const v = Math.round(value * 10000) / 10000;
	w.value = v;
	w.callback?.(v);
}

/** Resolve the upstream LoadImage node feeding the watermark input. */
function resolveWatermarkUrl(node, cfg) {
	const slot = node.inputs?.findIndex((i) => i.name === cfg.wmInput);
	if (slot == null || slot < 0) return null;
	let origin = node.getInputNode?.(slot);
	let guard = 0;
	while (
		origin &&
		(origin.type === "Reroute" || origin.comfyClass === "Reroute") &&
		guard++ < 10
	) {
		origin = origin.getInputNode?.(0);
	}
	if (!origin) return null;
	if (origin.comfyClass !== "LoadImage" && origin.type !== "LoadImage")
		return null;
	let v = origin.widgets?.find((w) => w.name === "image")?.value;
	if (!v) return null;
	if (typeof v === "string") v = { filename: v, subfolder: "", type: "input" };
	if (!v.filename) return null;
	const params = new URLSearchParams({
		filename: v.filename,
		subfolder: v.subfolder ?? "",
		type: v.type ?? "input",
	});
	const path = `/view?${params.toString()}`;
	return api.apiURL ? api.apiURL(path) : path;
}

/** True if the watermark input slot has any link connected (any source node). */
function isWatermarkConnected(node, cfg) {
	const slot = node.inputs?.find((i) => i.name === cfg.wmInput);
	if (!slot) return false;
	if (slot.link != null && slot.link >= 0) return true;
	const origin = node.getInputNode?.(
		node.inputs.findIndex((i) => i.name === cfg.wmInput),
	);
	return !!origin;
}

function createEditor(node, cfg) {
	const container = document.createElement("div");
	container.className = "pt-watermark-editor";
	Object.assign(container.style, {
		display: "flex",
		flexDirection: "column",
		width: "100%",
		height: "100%",
		boxSizing: "border-box",
		gap: "3px",
		padding: "2px 4px",
	});

	const canvas = document.createElement("canvas");
	Object.assign(canvas.style, {
		flex: "1 1 auto",
		minHeight: "0",
		width: "100%",
		borderRadius: "4px",
		touchAction: "none",
		display: "block",
	});

	const footer = document.createElement("div");
	Object.assign(footer.style, {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: "6px",
		fontSize: "11px",
		lineHeight: "18px",
		opacity: "0.85",
		flex: "0 0 auto",
		userSelect: "none",
	});

	const aspectBtn = document.createElement("button");
	aspectBtn.type = "button";
	Object.assign(aspectBtn.style, {
		background: "#1f1f1f",
		color: "inherit",
		border: "1px solid #3a3a3a",
		borderRadius: "4px",
		padding: "0 8px",
		fontSize: "11px",
		cursor: "pointer",
	});

	const readout = document.createElement("span");
	Object.assign(readout.style, {
		whiteSpace: "nowrap",
		overflow: "hidden",
		textOverflow: "ellipsis",
		textAlign: "right",
		flex: "1 1 auto",
	});

	footer.appendChild(aspectBtn);
	footer.appendChild(readout);
	container.appendChild(canvas);
	container.appendChild(footer);

	const state = {
		aspectIdx: 0,
		wmImg: null,
		wmUrl: null,
		drag: null,
		live: null, // authoritative pos/scale while dragging (widgets are write-only then)
		hash: "",
		raf: 0,
		removed: false,
	};

	const ctx = canvas.getContext("2d");

	function currentAspect() {
		// Prefer the real aspect of the last executed output, if available.
		const img = node.imgs?.[node.imageIndex ?? 0];
		if (img?.naturalWidth) return img.naturalWidth / img.naturalHeight;
		const [w, h] = ASPECTS[state.aspectIdx];
		return w / h;
	}

	function readParams() {
		const live = state.live;
		return {
			posX: Math.min(Math.max(live?.posX ?? getVal(node, cfg.posX, 1), 0), 1),
			posY: Math.min(Math.max(live?.posY ?? getVal(node, cfg.posY, 1), 0), 1),
			scale: Math.min(
				Math.max(live?.scale ?? getVal(node, cfg.scale, 15), 1),
				100,
			),
			opacity: Math.min(Math.max(getVal(node, cfg.opacity, 0.8), 0), 1),
			margin: Math.min(Math.max(getVal(node, cfg.margin, 2), 0), 50),
		};
	}

	/** Preview + watermark rectangles in CSS px, mirroring the Python math. */
	function layout() {
		const w = canvas.clientWidth || 1;
		const h = canvas.clientHeight || 1;
		const p = readParams();
		const ar = currentAspect();
		let rw = w;
		let rh = rw / ar;
		if (rh > h) {
			rh = h;
			rw = rh * ar;
		}
		const R = { x: (w - rw) / 2, y: (h - rh) / 2, w: rw, h: rh };
		const short = Math.min(R.w, R.h);
		const m = (short * p.margin) / 100;
		const wmW = Math.max(1, (short * p.scale) / 100);
		const wmAr = state.wmImg?.naturalWidth
			? state.wmImg.naturalHeight / state.wmImg.naturalWidth
			: 1;
		const wmH = Math.max(1, wmW * wmAr);
		const x = R.x + m + Math.max(0, R.w - 2 * m - wmW) * p.posX;
		const y = R.y + m + Math.max(0, R.h - 2 * m - wmH) * p.posY;
		return { R, m, wm: { x, y, w: wmW, h: wmH }, p };
	}

	function drawChecker(R) {
		const s = 8;
		ctx.save();
		ctx.beginPath();
		ctx.rect(R.x, R.y, R.w, R.h);
		ctx.clip();
		for (let yy = R.y; yy < R.y + R.h; yy += s) {
			for (let xx = R.x; xx < R.x + R.w; xx += s) {
				const odd = ((xx - R.x) / s + (yy - R.y) / s) % 2 < 1;
				ctx.fillStyle = odd ? "#2b2b2b" : "#383838";
				ctx.fillRect(xx, yy, s, s);
			}
		}
		ctx.restore();
	}

	function draw() {
		const { R, m, wm, p } = layout();
		const cw = canvas.clientWidth || 1;
		const ch = canvas.clientHeight || 1;
		ctx.clearRect(0, 0, cw, ch);

		ctx.fillStyle = "#1a1a1a";
		ctx.fillRect(0, 0, cw, ch);
		drawChecker(R);
		ctx.strokeStyle = "#666";
		ctx.lineWidth = 1;
		ctx.strokeRect(R.x + 0.5, R.y + 0.5, R.w - 1, R.h - 1);

		if (state.drag) {
			ctx.save();
			ctx.setLineDash([4, 3]);
			ctx.strokeStyle = "rgba(255,255,255,0.35)";
			ctx.strokeRect(R.x + m, R.y + m, R.w - 2 * m, R.h - 2 * m);
			ctx.restore();
		}

		const hasInput = !!resolveWatermarkUrl(node, cfg);
		const connected = isWatermarkConnected(node, cfg);
		ctx.save();
		if (state.wmImg?.naturalWidth) {
			ctx.globalAlpha = Math.max(0.05, p.opacity);
			ctx.drawImage(state.wmImg, wm.x, wm.y, wm.w, wm.h);
		} else {
			ctx.globalAlpha = 0.9;
			ctx.fillStyle = "rgba(90,160,255,0.35)";
			ctx.fillRect(wm.x, wm.y, wm.w, wm.h);
			ctx.strokeStyle = "rgba(120,190,255,0.9)";
			ctx.strokeRect(wm.x + 0.5, wm.y + 0.5, wm.w - 1, wm.h - 1);
			if (wm.w > 60 && wm.h > 18) {
				ctx.fillStyle = "rgba(255,255,255,0.85)";
				ctx.font = "11px sans-serif";
				ctx.textAlign = "center";
				ctx.textBaseline = "middle";
				ctx.fillText(
					hasInput ? "水印" : connected ? "水印已连接" : "未连接水印图",
					wm.x + wm.w / 2,
					wm.y + wm.h / 2,
				);
			}
		}
		ctx.restore();

		// Resize handle (bottom-right corner).
		ctx.fillStyle = "#fff";
		ctx.strokeStyle = "#333";
		ctx.beginPath();
		ctx.rect(
			wm.x + wm.w - HANDLE,
			wm.y + wm.h - HANDLE,
			HANDLE * 2,
			HANDLE * 2,
		);
		ctx.fill();
		ctx.stroke();

		readout.textContent = `x:${p.posX.toFixed(2)} y:${p.posY.toFixed(2)}  ${p.scale.toFixed(1)}%`;
	}

	function syncWatermarkImage() {
		const url = resolveWatermarkUrl(node, cfg);
		if (url === state.wmUrl) return;
		state.wmUrl = url;
		if (!url) {
			state.wmImg = null;
			return;
		}
		const img = new Image();
		img.onload = () => {
			state.wmImg = img;
		};
		img.onerror = () => {
			state.wmImg = null;
		};
		img.src = url;
	}

	function eventPos(e) {
		const rect = canvas.getBoundingClientRect();
		// The graph zoom CSS-scales the widget wrapper, so the bounding rect
		// is in scaled screen px while layout() works in unscaled layout px.
		const sx = (canvas.clientWidth || 1) / (rect.width || 1);
		const sy = (canvas.clientHeight || 1) / (rect.height || 1);
		return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
	}

	function hitHandle(pt, wm) {
		return (
			Math.abs(pt.x - (wm.x + wm.w)) <= HANDLE * 2 &&
			Math.abs(pt.y - (wm.y + wm.h)) <= HANDLE * 2
		);
	}

	canvas.addEventListener("pointerdown", (e) => {
		if (e.button !== 0) return;
		const pt = eventPos(e);
		const { R, m, wm } = layout();
		const mode = hitHandle(pt, wm)
			? "resize"
			: pt.x >= wm.x &&
					pt.x <= wm.x + wm.w &&
					pt.y >= wm.y &&
					pt.y <= wm.y + wm.h
				? "move"
				: null;
		if (!mode) return;
		e.preventDefault();
		e.stopPropagation();
		canvas.setPointerCapture(e.pointerId);
		const p = readParams();
		state.live = { posX: p.posX, posY: p.posY, scale: p.scale };
		// Freeze the geometry at drag start; recomputing layout() from updated
		// values inside pointermove would feed back into the drag math.
		state.drag = {
			mode,
			R,
			m,
			short: Math.min(R.w, R.h),
			wmW: wm.w,
			wmH: wm.h,
			dx: pt.x - wm.x,
			dy: pt.y - wm.y,
			anchorX: wm.x, // top-left stays pinned while resizing
			anchorY: wm.y,
		};
	});

	canvas.addEventListener("pointermove", (e) => {
		const pt = eventPos(e);
		if (!state.drag) {
			const { wm } = layout();
			canvas.style.cursor = hitHandle(pt, wm)
				? "nwse-resize"
				: pt.x >= wm.x &&
						pt.x <= wm.x + wm.w &&
						pt.y >= wm.y &&
						pt.y <= wm.y + wm.h
					? "move"
					: "default";
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		const d = state.drag;
		const { R, m, short } = d;
		const live = state.live;
		if (d.mode === "move") {
			const availW = Math.max(1e-6, R.w - 2 * m - d.wmW);
			const availH = Math.max(1e-6, R.h - 2 * m - d.wmH);
			live.posX = Math.min(Math.max((pt.x - d.dx - R.x - m) / availW, 0), 1);
			live.posY = Math.min(Math.max((pt.y - d.dy - R.y - m) / availH, 0), 1);
		} else {
			const wmAr = d.wmH / d.wmW;
			const newW = Math.min(Math.max(pt.x - d.anchorX, short * 0.01), short);
			const newH = newW * wmAr;
			live.scale = (newW / short) * 100;
			// Keep the top-left corner pinned at the drag-start anchor.
			const availW = Math.max(1e-6, R.w - 2 * m - newW);
			const availH = Math.max(1e-6, R.h - 2 * m - newH);
			live.posX = Math.min(Math.max((d.anchorX - R.x - m) / availW, 0), 1);
			live.posY = Math.min(Math.max((d.anchorY - R.y - m) / availH, 0), 1);
		}
		setVal(node, cfg.posX, live.posX);
		setVal(node, cfg.posY, live.posY);
		setVal(node, cfg.scale, live.scale);
	});

	function endDrag(e) {
		if (!state.drag) return;
		state.drag = null;
		state.live = null; // widgets hold the final values; reads are sync
		try {
			canvas.releasePointerCapture(e.pointerId);
		} catch {
			/* already released */
		}
	}
	canvas.addEventListener("pointerup", endDrag);
	canvas.addEventListener("pointercancel", endDrag);

	canvas.addEventListener(
		"wheel",
		(e) => {
			const pt = eventPos(e);
			const { R, m, wm, p } = layout();
			const over =
				pt.x >= wm.x &&
				pt.x <= wm.x + wm.w &&
				pt.y >= wm.y &&
				pt.y <= wm.y + wm.h;
			if (!over) return;
			e.preventDefault();
			e.stopPropagation();
			const factor = e.deltaY < 0 ? 1.06 : 1 / 1.06;
			const short = Math.min(R.w, R.h);
			const scale = Math.min(Math.max(p.scale * factor, 1), 100);
			const newW = (short * scale) / 100;
			const newH = newW * (wm.h / wm.w);
			// Keep the top-left corner pinned, same as handle resizing.
			const availW = Math.max(1e-6, R.w - 2 * m - newW);
			const availH = Math.max(1e-6, R.h - 2 * m - newH);
			setVal(node, cfg.scale, scale);
			setVal(
				node,
				cfg.posX,
				Math.min(Math.max((wm.x - R.x - m) / availW, 0), 1),
			);
			setVal(
				node,
				cfg.posY,
				Math.min(Math.max((wm.y - R.y - m) / availH, 0), 1),
			);
		},
		{ passive: false },
	);

	aspectBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		state.aspectIdx = (state.aspectIdx + 1) % ASPECTS.length;
	});

	function tick() {
		if (state.removed) return;
		syncWatermarkImage();
		const dpr = window.devicePixelRatio || 1;
		const cw = canvas.clientWidth || 1;
		const chh = canvas.clientHeight || 1;
		const p = readParams();
		const hash = [
			Math.round(cw * dpr),
			Math.round(chh * dpr),
			state.aspectIdx,
			state.wmUrl,
			state.wmImg?.naturalWidth ?? 0,
			node.imgs?.[node.imageIndex ?? 0]?.src ?? "",
			p.posX,
			p.posY,
			p.scale,
			p.opacity,
			p.margin,
			!!state.drag,
		].join("|");
		if (hash !== state.hash) {
			state.hash = hash;
			canvas.width = Math.round(cw * dpr);
			canvas.height = Math.round(chh * dpr);
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			draw();
			const usingReal = !!node.imgs?.[node.imageIndex ?? 0]?.naturalWidth;
			aspectBtn.textContent = `画幅 ${usingReal ? "实际" : ASPECTS[state.aspectIdx][2]}`;
		}
		state.raf = requestAnimationFrame(tick);
	}
	state.raf = requestAnimationFrame(tick);

	const origOnRemoved = node.onRemoved;
	node.onRemoved = function () {
		state.removed = true;
		cancelAnimationFrame(state.raf);
		origOnRemoved?.apply(this, arguments);
	};

	return container;
}

function setupNode(node, cfg) {
	for (const name of cfg.hide) hideWidget(getWidget(node, name));
	const element = createEditor(node, cfg);
	const domWidget = node.addDOMWidget(
		"watermark_editor",
		"pt_watermark_editor",
		element,
		{
			getValue: () => "",
			setValue: () => {},
			getMinHeight: () => 300,
			hideOnZoom: true,
		},
	);
	// The editor is pure UI; position/scale serialize via the hidden widgets.
	domWidget.serialize = false;
}

app.registerExtension({
	name: "PromptToolkit.WatermarkUI",
	beforeRegisterNodeDef(nodeType, nodeData) {
		const cfg = NODE_CONFIGS[nodeData.name];
		if (!cfg) return;
		const orig = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const r = orig?.apply(this, arguments);
			try {
				setupNode(this, cfg);
			} catch (err) {
				console.error("[PromptToolkit] watermark editor setup failed", err);
			}
			return r;
		};
	},
});
