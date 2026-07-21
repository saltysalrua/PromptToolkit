import { app } from "../../../scripts/app.js";

/**
 * Signature pad widget for the PromptToolkit "SignaturePad" node.
 *
 * Strokes are drawn on a fixed-resolution offscreen canvas (1024x512) and
 * exported as a PNG data URL into the hidden `signature_data` widget, so
 * the signature serializes with the workflow and is decoded by Python.
 * The display canvas is just a scaled view of the offscreen one.
 *
 * DOM widget: works in both the legacy canvas renderer and Nodes 2.0.
 */

const PAD_W = 1024;
const PAD_H = 512;

function hideWidget(widget) {
	if (!widget || widget.type === "converted-widget") return;
	widget.hidden = true; // DOM widgets (multiline text) & Vue data layer
	widget.options = widget.options || {};
	widget.options.hidden = true; // Nodes 2.0 (Vue) filter
	widget.computeSize = () => [0, -4]; // legacy canvas collapse
	widget.type = "converted-widget";
}

function makeButton(label) {
	const btn = document.createElement("button");
	btn.type = "button";
	btn.textContent = label;
	Object.assign(btn.style, {
		background: "#1f1f1f",
		color: "inherit",
		border: "1px solid #3a3a3a",
		borderRadius: "4px",
		padding: "0 8px",
		fontSize: "11px",
		cursor: "pointer",
		whiteSpace: "nowrap",
	});
	return btn;
}

function setupPad(node) {
	const dataWidget = node.widgets?.find((w) => w.name === "signature_data");
	hideWidget(dataWidget);

	const off = document.createElement("canvas");
	off.width = PAD_W;
	off.height = PAD_H;
	const octx = off.getContext("2d");
	octx.lineCap = "round";
	octx.lineJoin = "round";

	const container = document.createElement("div");
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
		cursor: "crosshair",
	});

	const toolbar = document.createElement("div");
	Object.assign(toolbar.style, {
		display: "flex",
		alignItems: "center",
		gap: "6px",
		fontSize: "11px",
		flex: "0 0 auto",
		userSelect: "none",
	});

	const brush = document.createElement("input");
	brush.type = "range";
	brush.min = "2";
	brush.max = "40";
	brush.value = "10";
	brush.title = "笔刷大小";
	Object.assign(brush.style, { flex: "1 1 auto", minWidth: "40px" });

	const color = document.createElement("input");
	color.type = "color";
	color.value = "#1a1a1a";
	color.title = "墨色";
	Object.assign(color.style, {
		width: "24px",
		height: "20px",
		padding: "0",
		border: "none",
		background: "none",
		cursor: "pointer",
	});

	const eraserBtn = makeButton("橡皮");
	const undoBtn = makeButton("撤销");
	const clearBtn = makeButton("清空");

	toolbar.append(brush, color, eraserBtn, undoBtn, clearBtn);
	container.append(canvas, toolbar);

	const state = {
		strokes: [], // {erase, size, color, points:[[x,y],...]}
		baseImg: null, // raster loaded from the serialized data URL
		baseLoaded: false,
		drawing: null,
		eraser: false,
		removed: false,
		raf: 0,
		hash: "",
	};

	function serialize() {
		if (!dataWidget) return;
		dataWidget.value = off.toDataURL("image/png");
		dataWidget.callback?.(dataWidget.value);
	}

	function loadBase() {
		if (state.baseLoaded) return;
		state.baseLoaded = true;
		const v = dataWidget?.value;
		if (typeof v !== "string" || !v.startsWith("data:image")) return;
		const img = new Image();
		img.onload = () => {
			state.baseImg = img;
			repaintOff();
		};
		img.src = v;
	}

	function repaintOff() {
		octx.save();
		octx.globalCompositeOperation = "source-over";
		octx.clearRect(0, 0, PAD_W, PAD_H);
		if (state.baseImg) octx.drawImage(state.baseImg, 0, 0, PAD_W, PAD_H);
		for (const s of state.strokes) drawStroke(s);
		octx.restore();
	}

	function drawStroke(s) {
		if (s.points.length === 0) return;
		octx.save();
		octx.globalCompositeOperation = s.erase ? "destination-out" : "source-over";
		octx.strokeStyle = s.color;
		octx.fillStyle = s.color;
		octx.lineWidth = s.size;
		if (s.points.length === 1) {
			const [x, y] = s.points[0];
			octx.beginPath();
			octx.arc(x, y, s.size / 2, 0, Math.PI * 2);
			octx.fill();
		} else {
			octx.beginPath();
			octx.moveTo(s.points[0][0], s.points[0][1]);
			for (let i = 1; i < s.points.length; i++)
				octx.lineTo(s.points[i][0], s.points[i][1]);
			octx.stroke();
		}
		octx.restore();
	}

	/** Map a pointer event to offscreen coordinates. */
	function padPos(e) {
		const rect = canvas.getBoundingClientRect();
		const fx = (e.clientX - rect.left) / (rect.width || 1);
		const fy = (e.clientY - rect.top) / (rect.height || 1);
		return [
			Math.min(Math.max(fx, 0), 1) * PAD_W,
			Math.min(Math.max(fy, 0), 1) * PAD_H,
		];
	}

	canvas.addEventListener("pointerdown", (e) => {
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		canvas.setPointerCapture(e.pointerId);
		state.drawing = {
			erase: state.eraser,
			size: Number(brush.value),
			color: color.value,
			points: [padPos(e)],
		};
		drawStroke(state.drawing); // single dot
	});

	canvas.addEventListener("pointermove", (e) => {
		if (!state.drawing) return;
		e.preventDefault();
		e.stopPropagation();
		const s = state.drawing;
		const prev = s.points[s.points.length - 1];
		const next = padPos(e);
		// Segment drawn incrementally; full repaint happens only on undo/clear.
		octx.save();
		octx.globalCompositeOperation = s.erase ? "destination-out" : "source-over";
		octx.strokeStyle = s.color;
		octx.lineWidth = s.size;
		octx.beginPath();
		octx.moveTo(prev[0], prev[1]);
		octx.lineTo(next[0], next[1]);
		octx.stroke();
		octx.restore();
		s.points.push(next);
	});

	function endStroke(e) {
		if (!state.drawing) return;
		state.strokes.push(state.drawing);
		state.drawing = null;
		serialize();
		try {
			canvas.releasePointerCapture(e.pointerId);
		} catch {
			/* already released */
		}
	}
	canvas.addEventListener("pointerup", endStroke);
	canvas.addEventListener("pointercancel", endStroke);

	eraserBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		state.eraser = !state.eraser;
		eraserBtn.style.outline = state.eraser ? "2px solid #6af" : "none";
		canvas.style.cursor = state.eraser ? "cell" : "crosshair";
	});

	undoBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		state.strokes.pop();
		repaintOff();
		serialize();
	});

	clearBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		state.strokes = [];
		state.baseImg = null;
		octx.clearRect(0, 0, PAD_W, PAD_H);
		serialize();
	});

	function drawView() {
		const dpr = window.devicePixelRatio || 1;
		const cw = canvas.clientWidth || 1;
		const ch = canvas.clientHeight || 1;
		canvas.width = Math.round(cw * dpr);
		canvas.height = Math.round(ch * dpr);
		const ctx = canvas.getContext("2d");
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		// checkerboard so transparency reads clearly
		const s = 8;
		for (let y = 0; y < ch; y += s)
			for (let x = 0; x < cw; x += s) {
				ctx.fillStyle =
					((x / s) | 0) % 2 === ((y / s) | 0) % 2 ? "#2b2b2b" : "#383838";
				ctx.fillRect(x, y, s, s);
			}
		ctx.drawImage(off, 0, 0, cw, ch);
	}

	function tick() {
		if (state.removed) return;
		loadBase();
		const dpr = window.devicePixelRatio || 1;
		const hash = [
			Math.round((canvas.clientWidth || 1) * dpr),
			Math.round((canvas.clientHeight || 1) * dpr),
			state.strokes.length,
			state.drawing ? state.drawing.points.length : -1,
			!!state.baseImg,
		].join("|");
		if (hash !== state.hash) {
			state.hash = hash;
			drawView();
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

	const domWidget = node.addDOMWidget(
		"signature_pad",
		"pt_signature_pad",
		container,
		{
			getValue: () => "",
			setValue: () => {},
			getMinHeight: () => 260,
			hideOnZoom: true,
		},
	);
	// Signature content serializes via the hidden signature_data widget.
	domWidget.serialize = false;
}

app.registerExtension({
	name: "PromptToolkit.SignaturePad",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData.name !== "SignaturePad") return;
		const orig = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const r = orig?.apply(this, arguments);
			try {
				setupPad(this);
			} catch (err) {
				console.error("[PromptToolkit] signature pad setup failed", err);
			}
			return r;
		};
	},
});
