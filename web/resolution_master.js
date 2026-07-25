import { app } from "../../../scripts/app.js";

/**
 * Resolution Master (Nodes 2.0 compatible port) - visual resolution picker.
 *
 * DOM widget UI styled after the original Comfyui-Resolution-Master:
 *  - 2D pad: dot grid at 64-step, origin-anchored frame, knob + right/top
 *    edge handles, drag to set width/height (snapped to 64)
 *  - presets open a separate searchable dialog (category chips + list)
 *  - the rescale_mode/rescale_value widgets stay hidden; the UI no longer
 *    exposes ratio/rescale controls (slimmed down per user request), but
 *    the factor is still computed so the outputs/AI bridge keep working
 *
 * width/height/rescale_mode/rescale_value/mode widgets are hidden but stay
 * serialized. Works in both the legacy canvas renderer and Nodes 2.0.
 */

const PAD_MIN = 0;
const SNAP = 64;
const RANGES = [2048, 3072, 4096]; // pad range selector (original default: 2048)
// Preset data ported from Comfyui-Resolution-Master (ResolutionMasterConfig.js)
const PRESETS = {
	Standard: {
		"1:1 Square": [512, 512],
		"1:2 Tall": [512, 1024],
		"1:3 Ultra Tall": [512, 1536],
		"2:3 Portrait": [512, 768],
		"3:4 Portrait": [576, 768],
		"4:5 Portrait": [512, 640],
		"4:7 Phone": [512, 896],
		"5:12 Banner": [512, 1228],
		"7:9 Vertical": [512, 658],
		"9:16 Mobile": [576, 1024],
		"9:21 Ultra Mobile": [512, 1194],
		"10:16 Monitor": [640, 1024],
		"13:19 Tall Screen": [512, 748],
		"3:2 Landscape": [768, 512],
		"4:3 Classic": [512, 384],
		"16:9 Widescreen": [768, 432],
		"21:9 Ultrawide": [1024, 439],
	},
	SDXL: {
		"1:1 Square": [1024, 1024],
		"3:4 Portrait": [768, 1024],
		"4:5 Portrait": [915, 1144],
		"5:12 Portrait": [640, 1536],
		"7:9 Portrait": [896, 1152],
		"9:16 Portrait": [768, 1344],
		"13:19 Portrait": [832, 1216],
		"3:2 Landscape": [1254, 836],
	},
	Flux: {
		"1:1 Square (Standard)": [1024, 1024],
		"1:1 Square (Medium)": [1408, 1408],
		"1:1 Square (High)": [1440, 1440],
		"2:3 Portrait": [832, 1248],
		"3:4 Portrait": [896, 1184],
		"4:5 Portrait": [928, 1152],
		"9:16 Portrait": [768, 1344],
		"9:21 Portrait": [672, 1440],
	},
	"Flux.2": {
		"1:1 Square": [2048, 2048],
		"1:1 Square Native": [2336, 2336],
		"2:3 Portrait": [1632, 2448],
		"3:4 Portrait": [1728, 2304],
		"4:5 Portrait": [1792, 2240],
		"9:16 Portrait": [1472, 2624],
		"3:2 Landscape": [2448, 1632],
		"4:3 Landscape": [2304, 1728],
		"16:9 Landscape": [2624, 1472],
		"21:9 Ultrawide": [2912, 1248],
	},
	WAN: {
		"16:9 Landscape-1280": [1280, 720],
		"16:9 Landscape-832": [832, 480],
		"1:1 Square-512": [512, 512],
		"1:1 Square-768": [768, 768],
		"1:1 Square-720": [720, 720],
		"2:3 Portrait": [588, 882],
		"3:4 Portrait": [624, 832],
		"9:21 Portrait": [549, 1280],
		"3:2 Landscape": [1080, 720],
		"4:3 Landscape": [960, 720],
		"21:9 Landscape": [1680, 720],
	},
	"HiDream Dev": {
		"1:1 Square-1024": [1024, 1024],
		"1:1 Square-1280": [1280, 1280],
		"1:1 Square-1536": [1536, 1536],
		"16:9 Landscape": [1360, 768],
		"3:2 Landscape": [1248, 832],
		"4:3 Landscape": [1168, 880],
	},
	"Qwen-Image": {
		"1:1 Square (Default)": [1328, 1328],
		"16:9 Landscape": [1664, 928],
		"4:3 Landscape": [1472, 1104],
		"3:2 Landscape": [1584, 1056],
		"1:1 Square-1024": [1024, 1024],
		"3:4 Portrait": [768, 1024],
	},
	ZImageTurbo: {
		"1:1 Square (1024)": [1024, 1024],
		"9:7 Landscape (1024)": [1152, 896],
		"7:9 Portrait (1024)": [896, 1152],
		"4:3 Landscape (1024)": [1152, 864],
		"3:4 Portrait (1024)": [864, 1152],
		"3:2 Landscape (1024)": [1248, 832],
		"2:3 Portrait (1024)": [832, 1248],
		"16:9 Widescreen (1024)": [1280, 720],
		"9:16 Portrait (1024)": [720, 1280],
		"21:9 Ultrawide (1024)": [1344, 576],
		"9:21 Ultra Portrait (1024)": [576, 1344],
		"1:1 Square (1280)": [1280, 1280],
		"9:7 Landscape (1280)": [1440, 1120],
		"7:9 Portrait (1280)": [1120, 1440],
		"4:3 Landscape (1280)": [1472, 1104],
		"3:4 Portrait (1280)": [1104, 1472],
		"3:2 Landscape (1280)": [1536, 1024],
		"2:3 Portrait (1280)": [1024, 1536],
		"16:9 Widescreen (1280)": [1536, 864],
		"9:16 Portrait (1280)": [864, 1536],
		"21:9 Ultrawide (1280)": [1680, 720],
		"9:21 Ultra Portrait (1280)": [720, 1680],
		"1:1 Square (1536)": [1536, 1536],
		"9:7 Landscape (1536)": [1728, 1344],
		"7:9 Portrait (1536)": [1344, 1728],
		"4:3 Landscape (1536)": [1728, 1296],
		"3:4 Portrait (1536)": [1296, 1728],
		"3:2 Landscape (1536)": [1872, 1248],
		"2:3 Portrait (1536)": [1248, 1872],
		"16:9 Widescreen (1536)": [2048, 1152],
		"9:16 Portrait (1536)": [1152, 2048],
		"21:9 Ultrawide (1536)": [2016, 864],
		"9:21 Ultra Portrait (1536)": [864, 2016],
	},
	"Social Media": {
		"Instagram Square": [1080, 1080],
		"Instagram Portrait": [1080, 1350],
		"Instagram Landscape": [1080, 566],
		"Instagram Stories/Reels": [1080, 1920],
		"Facebook Post": [1200, 630],
		"Facebook Cover Page": [820, 312],
		"Facebook Stories": [1080, 1920],
		"Twitter Post": [1200, 675],
		"Twitter Header": [1500, 500],
		"YouTube Thumbnail": [1280, 720],
		"YouTube Shorts": [1080, 1920],
		"LinkedIn Post": [1200, 627],
		"TikTok Video": [1080, 1920],
		"Pinterest Standard Pin": [1000, 1500],
		"Snapchat Story/Ads": [1080, 1920],
	},
	Print: {
		"A3 Portrait": [3508, 4961],
		"A4 Portrait": [2480, 3508],
		"A4 Landscape": [3508, 2480],
		"A5 Portrait": [1748, 2480],
		"A6 Portrait": [1240, 1748],
		"Business Card EU": [1004, 590],
		"Letter Portrait": [2550, 3300],
		"Legal Portrait": [2550, 4200],
		Tabloid: [3300, 5100],
		"4x6 Photo": [1200, 1800],
		"5x7 Photo": [1500, 2100],
		"8x10 Photo": [2400, 3000],
		"11x14 Photo": [3300, 4200],
		"16x20 Photo": [4800, 6000],
		"20x24 Photo": [6000, 7200],
	},
	Cinema: {
		"DCI 2K Flat": [1998, 1080],
		"DCI 2K Scope": [2048, 858],
		"DCI 4K Flat": [3996, 2160],
		"DCI 4K Scope": [4096, 1716],
		"DCI Full 2K": [2048, 1080],
		"DCI Full 4K": [4096, 2160],
		"IMAX 1.90:1": [4096, 2160],
		"Ultra Panavision 70": [7680, 2782],
		"Academy Original": [1474, 1072],
		"Silent Film 1.33:1": [1440, 1080],
		"2.39:1 Anamorphic": [2048, 858],
		"1.85:1 Standard": [1998, 1080],
		"2:1 Univisium": [2048, 1024],
		"4:3 Academy": [1440, 1080],
		"1.33:1 Classic": [1436, 1080],
	},
	"Display Resolutions": {
		CIF: [352, 288],
		SVGA: [800, 600],
		XGA: [1024, 768],
		SXGA: [1280, 1024],
		WXGA: [1366, 768],
		"WSXGA+": [1680, 1050],
		"240p": [426, 240],
		"360p": [640, 360],
		"480p SD": [854, 480],
		"540p qHD": [960, 540],
		"720p HD": [1280, 720],
		"900p HD+": [1600, 900],
		"1080p Full HD": [1920, 1080],
		UWFHD: [2560, 1080],
		"1200p WUXGA": [1920, 1200],
		"1440p QHD": [2560, 1440],
		UWQHD: [3440, 1440],
		"1600p UXGA": [2560, 1600],
		"1800p QHD+": [3200, 1800],
		"4K UHD": [3840, 2160],
		"UW4K (5K2K)": [5120, 2160],
		"5K": [5120, 2880],
		"6K": [6016, 3384],
		"8K UHD": [7680, 4320],
	},
};

const CSS = `
.pt-rm-section{border:1px solid #3a3a3a;border-radius:6px;overflow:hidden;background:rgba(30,30,30,.6);flex:0 0 auto}
.pt-rm-sec-head{display:flex;align-items:center;gap:6px;padding:3px 8px;cursor:pointer;background:rgba(255,255,255,.04);font-size:11px;user-select:none}
.pt-rm-sec-head:hover{background:rgba(255,255,255,.08)}
.pt-rm-arrow{font-size:8px;opacity:.7;transition:transform .12s}
.pt-rm-arrow.collapsed{transform:rotate(-90deg)}
.pt-rm-sec-body{padding:6px 8px;display:flex;flex-direction:column;gap:6px}
.pt-rm-sec-body.collapsed{display:none}
.pt-rm-btn{background:#1f1f1f;color:inherit;border:1px solid #3a3a3a;border-radius:4px;padding:0 10px;font-size:12px;cursor:pointer;white-space:nowrap;height:24px}
.pt-rm-btn:hover{border-color:#6af}
.pt-rm-btn.active{background:#2c4a6e;border-color:#6af}
.pt-rm-btn:focus,.pt-rm-input:focus,.pt-rm-slider:focus,.pt-rm-radio:focus,.pt-rm-cat:focus,.pt-rm-preset:focus{outline:none;border-color:#6af}
.pt-rm-slider:focus{outline:none}
.pt-rm-section :focus,.pt-rm-row :focus,.pt-rm-dialog :focus{outline:none!important;box-shadow:none!important}
.pt-rm-btn,.pt-rm-input,.pt-rm-slider,.pt-rm-radio,.pt-rm-cat,.pt-rm-preset{outline:none!important;box-shadow:none!important}
.pt-rm-btn:focus-visible,.pt-rm-input:focus-visible,.pt-rm-slider:focus-visible,.pt-rm-cat:focus-visible,.pt-rm-preset:focus-visible{outline:none!important;box-shadow:none!important;border-color:#6af}
.pt-rm-input{background:#1f1f1f;color:inherit;border:1px solid #3a3a3a;border-radius:4px;font-size:12px;height:24px;box-sizing:border-box;padding:0 4px}
.pt-rm-row{display:flex;align-items:center;gap:4px;user-select:none}
.pt-rm-radio{accent-color:#6af;margin:0}
.pt-rm-slider{flex:1 1 auto;min-width:40px;accent-color:#6af;height:16px}
.pt-rm-val{font-size:11px;opacity:.85;min-width:44px;text-align:right;white-space:nowrap}
.pt-rm-dialog-bg{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center}
.pt-rm-dialog{width:auto;max-width:96vw;max-height:88vh;background:#232323;border:1px solid #444;border-radius:8px;display:flex;flex-direction:column;padding:10px;gap:8px;color:#ddd;font-size:12px}
.pt-rm-dialog-title{font-size:13px;font-weight:600;display:flex;justify-content:space-between;align-items:center}
.pt-rm-dialog-close{cursor:pointer;opacity:.7;padding:0 4px}
.pt-rm-dialog-close:hover{opacity:1}
.pt-rm-cats{display:flex;flex-wrap:wrap;gap:4px}
.pt-rm-cat{padding:2px 8px;border-radius:10px;border:1px solid #444;cursor:pointer;font-size:11px;white-space:nowrap}
.pt-rm-cat:hover{border-color:#6af}
.pt-rm-cat.active{background:#2c4a6e;border-color:#6af}
.pt-rm-cols{display:flex;flex-wrap:wrap;align-items:flex-start;gap:6px;overflow-y:auto;overflow-x:hidden;padding:2px;max-height:68vh}
.pt-rm-col{display:flex;flex-direction:column;align-items:center;flex:0 0 auto;background:rgba(0,0,0,.2);border:1px solid #3a3a3a;border-radius:6px;padding:6px;gap:4px;min-width:96px}
.pt-rm-ratio-box{width:36px;height:36px;display:flex;align-items:center;justify-content:center}
.pt-rm-ratio-box>div{border:1.5px solid #6af;background:rgba(90,170,255,.12);border-radius:2px;box-sizing:border-box}
.pt-rm-ratio-label{color:#6af;font-weight:700;font-size:12px;border-bottom:1px solid #444;width:100%;text-align:center;padding-bottom:3px}
.pt-rm-col-items{display:flex;flex-direction:column;gap:3px;width:100%}
.pt-rm-preset{display:flex;flex-direction:column;align-items:center;text-align:center;padding:4px 5px;border-radius:4px;border:1px solid #3a3a3a;background:#2a2a2a;cursor:pointer;color:#ddd;font-size:11px;word-break:break-word}
.pt-rm-preset:hover{border-color:#6af;background:#2c3540}
.pt-rm-preset.active{border-color:#6af;background:#2c4a6e}
.pt-rm-preset small{opacity:.55;margin-top:1px}
.pt-rm-empty{padding:20px;text-align:center;opacity:.5;width:100%}
`;

let cssInjected = false;
function injectCSS() {
	if (cssInjected) return;
	cssInjected = true;
	const style = document.createElement("style");
	style.textContent = CSS;
	document.head.appendChild(style);
}

function hideWidget(widget) {
	if (!widget || widget.type === "converted-widget") return;
	widget.hidden = true; // DOM widgets & Vue data layer
	widget.options = widget.options || {};
	widget.options.hidden = true;
	widget.computeSize = () => [0, -4];
	widget.type = "converted-widget";
}

function el(tag, cls, props = {}) {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	Object.assign(e, props);
	return e;
}

function setupResolutionMaster(node) {
	injectCSS();
	const wW = node.widgets?.find((w) => w.name === "width");
	const wH = node.widgets?.find((w) => w.name === "height");
	const wMode = node.widgets?.find((w) => w.name === "mode");
	const wResMode = node.widgets?.find((w) => w.name === "rescale_mode");
	const wResVal = node.widgets?.find((w) => w.name === "rescale_value");
	[wW, wH, wMode, wResMode, wResVal].forEach(hideWidget);

	const props = node.properties;
	props.ptRescaleMode =
		props.ptRescaleMode ?? String(wResMode?.value ?? "manual");
	props.ptManual = props.ptManual ?? 1.0;
	props.ptResolution = props.ptResolution ?? 1080;
	props.ptMP = props.ptMP ?? 2.0;
	props.ptPresetName = props.ptPresetName ?? "";
	props.ptPresetCat = props.ptPresetCat ?? "";

	const getWH = () => [
		Math.round(Number(wW?.value) || 1024),
		Math.round(Number(wH?.value) || 1024),
	];

	function computeFactor(mode, val, w, h) {
		const current = Math.max(1, w * h);
		if (mode === "resolution")
			return Math.sqrt((val * (16 / 9) * val) / current);
		if (mode === "megapixels") return Math.sqrt((val * 1e6) / current);
		return val;
	}

	/** The rescale_value widget always holds the COMPUTED factor. */
	function writeRescale() {
		const [w, h] = getWH();
		const raw =
			props.ptRescaleMode === "resolution"
				? props.ptResolution
				: props.ptRescaleMode === "megapixels"
					? props.ptMP
					: props.ptManual;
		const factor = computeFactor(props.ptRescaleMode, raw, w, h);
		if (wResMode) {
			wResMode.value = props.ptRescaleMode;
			wResMode.callback?.(props.ptRescaleMode);
		}
		if (wResVal) {
			wResVal.value = factor;
			wResVal.callback?.(factor);
		}
		return factor;
	}

	function setWH(w, h) {
		w = Math.min(Math.max(Math.round(w), 1), 32768);
		h = Math.min(Math.max(Math.round(h), 1), 32768);
		if (wW) {
			wW.value = w;
			wW.callback?.(w);
		}
		if (wH) {
			wH.value = h;
			wH.callback?.(h);
		}
		writeRescale();
	}

	// ---- layout -------------------------------------------------------------
	const container = el("div");
	Object.assign(container.style, {
		display: "flex",
		flexDirection: "column",
		width: "100%",
		height: "100%",
		boxSizing: "border-box",
		gap: "4px",
		padding: "2px 4px",
		fontSize: "11px",
	});

	const pad = el("canvas");
	Object.assign(pad.style, {
		flex: "0 0 auto",
		aspectRatio: "1 / 1",
		width: "100%",
		borderRadius: "4px",
		touchAction: "none",
		display: "block",
		cursor: "crosshair",
	});

	// dims row (always visible)
	const dimsRow = el("div", "pt-rm-row");
	const inW = el("input", "pt-rm-input", {
		type: "number",
		min: "1",
		max: "32768",
		step: "64",
	});
	inW.style.width = "60px";
	const inH = el("input", "pt-rm-input", {
		type: "number",
		min: "1",
		max: "32768",
		step: "64",
	});
	inH.style.width = "60px";
	const swapBtn = el("button", "pt-rm-btn", {
		textContent: "⇄",
		title: "交换宽高",
	});
	const rangeSel = el("select", "pt-rm-input", { title: "手写板量程" });
	for (const r of RANGES) rangeSel.add(new Option(String(r), String(r)));
	const dimsLabel = el("span", "pt-rm-val");
	dimsLabel.style.marginLeft = "auto";
	dimsRow.append(inW, "×", inH, swapBtn, rangeSel, dimsLabel);

	function section(title) {
		const wrap = el("div", "pt-rm-section");
		const head = el("div", "pt-rm-sec-head");
		const arrow = el("span", "pt-rm-arrow", { textContent: "▼" });
		head.append(arrow, el("span", "", { textContent: title }));
		const body = el("div", "pt-rm-sec-body");
		head.addEventListener("click", (e) => {
			e.stopPropagation();
			body.classList.toggle("collapsed");
			arrow.classList.toggle("collapsed");
		});
		wrap.append(head, body);
		return { wrap, body };
	}

	// 比例/缩放 sections were removed to slim the node down. The rescale
	// widgets stay hidden; setRaw + writeRescale keep them consistent for
	// the node outputs and the AI bridge hook.

	function setRaw(mode, v) {
		if (mode === "resolution") props.ptResolution = v;
		else if (mode === "megapixels") props.ptMP = v;
		else props.ptManual = v;
	}

	// 预设 section: button opens a searchable dialog
	const presetSec = section("预设");
	const presetBtn = el("button", "pt-rm-btn", { textContent: "📐 选择预设…" });
	presetBtn.style.width = "100%";
	presetBtn.style.height = "24px";
	const presetName = el("div", "pt-rm-val");
	presetName.style.textAlign = "left";
	presetName.style.opacity = "0.7";
	presetSec.body.append(presetBtn, presetName);

	function refreshPresetName() {
		presetName.textContent = props.ptPresetName
			? `当前：${props.ptPresetName}`
			: "未选择预设";
	}

	presetBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		openPresetDialog();
	});

	function openPresetDialog() {
		const bg = el("div", "pt-rm-dialog-bg");
		const dlg = el("div", "pt-rm-dialog");
		const title = el("div", "pt-rm-dialog-title");
		title.append(
			el("span", "", { textContent: "选择分辨率预设" }),
			el("span", "pt-rm-dialog-close", { textContent: "✕" }),
		);
		const search = el("input", "pt-rm-input", {
			type: "text",
			placeholder: "搜索预设…",
		});
		Object.assign(search.style, {
			width: "100%",
			height: "26px",
			boxSizing: "border-box",
		});
		const cats = el("div", "pt-rm-cats");
		const list = el("div", "pt-rm-cols");
		let activeCat = props.ptPresetCat || "Standard";

		const gcd = (a, b) => (b ? gcd(b, a % b) : a);

		/** Group entries by gcd ratio; columns sorted landscape→portrait. */
		function groupByRatio(entries) {
			const grouped = {};
			for (const [name, dims] of entries) {
				const g = gcd(dims[0], dims[1]) || 1;
				const ratio = `${dims[0] / g}:${dims[1] / g}`;
				(grouped[ratio] ??= []).push({ name, dims, pixels: dims[0] * dims[1] });
			}
			for (const r in grouped) grouped[r].sort((a, b) => b.pixels - a.pixels);
			return Object.keys(grouped)
				.sort((a, b) => {
					const [aw, ah] = a.split(":").map(Number);
					const [bw, bh] = b.split(":").map(Number);
					return bw / bh - aw / ah;
				})
				.map((r) => [r, grouped[r]]);
		}

		function ratioSampleBox(w, h) {
			const wrap = el("div", "pt-rm-ratio-box");
			const box = el("div");
			const ar = w / h;
			let bw = 34;
			let bh = bw / ar;
			if (bh > 34) {
				bh = 34;
				bw = bh * ar;
			}
			box.style.width = `${Math.max(3, bw)}px`;
			box.style.height = `${Math.max(3, bh)}px`;
			wrap.appendChild(box);
			return wrap;
		}

		function close() {
			bg.remove();
			document.removeEventListener("keydown", onKey, true);
		}
		function onKey(e) {
			if (e.key === "Escape") {
				e.stopPropagation();
				close();
			}
		}
		title.lastChild.addEventListener("click", close);
		bg.addEventListener("pointerdown", (e) => {
			if (e.target === bg) close();
		});
		document.addEventListener("keydown", onKey, true);

		function renderCats() {
			cats.replaceChildren();
			for (const cat of Object.keys(PRESETS)) {
				const chip = el(
					"span",
					`pt-rm-cat${cat === activeCat ? " active" : ""}`,
					{ textContent: cat },
				);
				chip.addEventListener("click", () => {
					activeCat = cat;
					props.ptPresetCat = cat;
					search.value = "";
					renderCats();
					renderList();
				});
				cats.appendChild(chip);
			}
		}

		function addPreset(items, catName, presetName_, dims) {
			const full = `${catName} / ${presetName_}`;
			const b = el(
				"button",
				`pt-rm-preset${full === props.ptPresetName ? " active" : ""}`,
			);
			b.append(
				document.createTextNode(presetName_),
				el("small", "", { textContent: `${dims[0]}×${dims[1]}` }),
			);
			b.addEventListener("click", () => {
				setWH(dims[0], dims[1]);
				props.ptPresetName = full;
				props.ptPresetCat = catName;
				refreshPresetName();
				close();
			});
			items.appendChild(b);
		}

		function renderList() {
			list.replaceChildren();
			const q = search.value.trim().toLowerCase();
			const entries = Object.entries(PRESETS[activeCat] || {}).filter(
				([name, dims]) =>
					!q ||
					name.toLowerCase().includes(q) ||
					`${dims[0]}×${dims[1]}`.includes(q),
			);
			const groups = groupByRatio(entries);
			if (!groups.length) {
				list.appendChild(
					el("div", "pt-rm-empty", { textContent: "没有匹配的预设" }),
				);
				return;
			}
			for (const [ratio, presets] of groups) {
				const col = el("div", "pt-rm-col");
				col.append(
					ratioSampleBox(presets[0].dims[0], presets[0].dims[1]),
					el("div", "pt-rm-ratio-label", { textContent: ratio }),
				);
				const items = el("div", "pt-rm-col-items");
				for (const p of presets) addPreset(items, activeCat, p.name, p.dims);
				col.appendChild(items);
				list.appendChild(col);
			}
		}

		search.addEventListener("input", renderList);
		renderCats();
		renderList();
		dlg.append(title, search, cats, list);
		bg.appendChild(dlg);
		document.body.appendChild(bg);
		search.focus();
	}

	container.append(pad, dimsRow, presetSec.wrap);

	// ---- state / pad ----------------------------------------------------------
	const state = {
		drag: null,
		padMax: RANGES[0],
		removed: false,
		raf: 0,
		hash: "",
	};
	rangeSel.addEventListener("change", () => {
		state.padMax = Number(rangeSel.value) || RANGES[0];
	});

	function syncInputs() {
		const [w, h] = getWH();
		if (document.activeElement !== inW) inW.value = String(w);
		if (document.activeElement !== inH) inH.value = String(h);
		const mp = (w * h) / 1e6;
		const gcd = (a, b) => (b ? gcd(b, a % b) : a);
		const g = gcd(w, h) || 1;
		dimsLabel.textContent = `${w / g}:${h / g} · ${mp.toFixed(2)}MP`;
		refreshPresetName();
	}

	inW.addEventListener("change", () =>
		setWH(Math.round(Number(inW.value) / SNAP) * SNAP, getWH()[1]),
	);
	inH.addEventListener("change", () =>
		setWH(getWH()[0], Math.round(Number(inH.value) / SNAP) * SNAP),
	);
	swapBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		const [w, h] = getWH();
		setWH(h, w);
	});

	// pad geometry (faithful port of the original 2D canvas)
	function padRect() {
		const cw = pad.clientWidth || 1;
		const ch = pad.clientHeight || 1;
		const side = Math.max(1, Math.min(cw, ch) - 20);
		return { x: (cw - side) / 2, y: (ch - side) / 2, w: side, h: side };
	}

	function dimsToPx(w, h, R) {
		return {
			x: R.x + ((w - PAD_MIN) / (state.padMax - PAD_MIN)) * R.w,
			y: R.y + R.h * (1 - (h - PAD_MIN) / (state.padMax - PAD_MIN)),
		};
	}

	function padPos(e) {
		const rect = pad.getBoundingClientRect();
		const sx = (pad.clientWidth || 1) / (rect.width || 1);
		const sy = (pad.clientHeight || 1) / (rect.height || 1);
		return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
	}

	function pxToDims(pt, R) {
		const fx = Math.min(Math.max((pt.x - R.x) / R.w, 0), 1);
		const fy = Math.min(Math.max((pt.y - R.y) / R.h, 0), 1);
		const w =
			Math.round((PAD_MIN + fx * (state.padMax - PAD_MIN)) / SNAP) * SNAP;
		const h =
			Math.round((PAD_MIN + (1 - fy) * (state.padMax - PAD_MIN)) / SNAP) * SNAP;
		return [
			Math.min(Math.max(w, SNAP), state.padMax),
			Math.min(Math.max(h, SNAP), state.padMax),
		];
	}

	function handles(R) {
		const [w, h] = getWH();
		const knob = dimsToPx(w, h, R);
		return {
			knob,
			right: {
				x: knob.x,
				y: R.y + R.h * (1 - (h - PAD_MIN) / (state.padMax - PAD_MIN) / 2),
			},
			top: {
				x: R.x + ((w - PAD_MIN) / (state.padMax - PAD_MIN) / 2) * R.w,
				y: knob.y,
			},
		};
	}

	function hit(pt, p, r) {
		return Math.hypot(pt.x - p.x, pt.y - p.y) <= r;
	}

	pad.addEventListener("pointerdown", (e) => {
		if (e.button !== 0) return;
		const pt = padPos(e);
		const R = padRect();
		// ignore clicks in the margin band outside the square
		if (pt.x < R.x || pt.x > R.x + R.w || pt.y < R.y || pt.y > R.y + R.h)
			return;
		const hd = handles(R);
		let mode = "both";
		if (hit(pt, hd.right, 12)) mode = "x";
		else if (hit(pt, hd.top, 12)) mode = "y";
		e.preventDefault();
		e.stopPropagation();
		pad.setPointerCapture(e.pointerId);
		state.drag = mode;
		const [w, h] = pxToDims(pt, R);
		const [cw, chh] = getWH();
		setWH(mode === "y" ? cw : w, mode === "x" ? chh : h);
	});
	pad.addEventListener("pointermove", (e) => {
		const pt = padPos(e);
		if (!state.drag) {
			const hd = handles(padRect());
			pad.style.cursor = hit(pt, hd.right, 12)
				? "ew-resize"
				: hit(pt, hd.top, 12)
					? "ns-resize"
					: "crosshair";
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		const [w, h] = pxToDims(pt, padRect());
		const [cw, chh] = getWH();
		setWH(state.drag === "y" ? cw : w, state.drag === "x" ? chh : h);
	});
	function endPadDrag(e) {
		if (!state.drag) return;
		state.drag = null;
		try {
			pad.releasePointerCapture(e.pointerId);
		} catch {
			/* released */
		}
	}
	pad.addEventListener("pointerup", endPadDrag);
	pad.addEventListener("pointercancel", endPadDrag);

	function drawPad() {
		const dpr = window.devicePixelRatio || 1;
		const cw = pad.clientWidth || 1;
		const ch = pad.clientHeight || 1;
		pad.width = Math.round(cw * dpr);
		pad.height = Math.round(ch * dpr);
		const ctx = pad.getContext("2d");
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		const [w, h] = getWH();
		const R = padRect();
		const hd = handles(R);

		ctx.fillStyle = "rgba(20,20,20,0.8)";
		ctx.strokeStyle = "rgba(0,0,0,0.5)";
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.roundRect(R.x - 4, R.y - 4, R.w + 8, R.h + 8, 6);
		ctx.fill();
		ctx.stroke();

		// dot grid at every 64-step (hidden when too dense to read)
		ctx.fillStyle = "rgba(200,200,200,0.5)";
		ctx.beginPath();
		const stepPx = (SNAP / (state.padMax - PAD_MIN)) * R.w;
		if (stepPx >= 3) {
			for (let ix = R.x + stepPx; ix < R.x + R.w; ix += stepPx)
				for (let iy = R.y + stepPx; iy < R.y + R.h; iy += stepPx)
					ctx.rect(ix - 0.5, iy - 0.5, 1, 1);
		}
		ctx.fill();

		// origin-anchored frame (bottom-left → current point)
		const fx = ((w - PAD_MIN) / (state.padMax - PAD_MIN)) * R.w;
		const fy = ((h - PAD_MIN) / (state.padMax - PAD_MIN)) * R.h;
		ctx.fillStyle = "rgba(150,150,250,0.1)";
		ctx.strokeStyle = "rgba(150,150,250,0.7)";
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.rect(R.x, R.y + R.h - fy, fx, fy);
		ctx.fill();
		ctx.stroke();

		// knob (white) + right-edge (blue, width) + top-edge (pink, height)
		ctx.fillStyle = "#fff";
		ctx.strokeStyle = "#000";
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.arc(hd.knob.x, hd.knob.y, 8, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();
		ctx.fillStyle = "#89F";
		ctx.beginPath();
		ctx.arc(hd.right.x, hd.right.y, 6, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();
		ctx.fillStyle = "#F89";
		ctx.beginPath();
		ctx.arc(hd.top.x, hd.top.y, 6, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();

		ctx.fillStyle = "rgba(255,255,255,0.9)";
		ctx.font = "11px sans-serif";
		ctx.textAlign = "center";
		ctx.fillText(`${w} × ${h}`, R.x + R.w / 2, R.y + R.h - 6);
	}

	function tick() {
		if (state.removed) return;
		const dpr = window.devicePixelRatio || 1;
		const [w, h] = getWH();
		const hash = [
			Math.round((pad.clientWidth || 1) * dpr),
			Math.round((pad.clientHeight || 1) * dpr),
			state.padMax,
			w,
			h,
			props.ptRescaleMode,
			props.ptManual,
			props.ptResolution,
			props.ptMP,
			props.ptPresetName,
		].join("|");
		if (hash !== state.hash) {
			state.hash = hash;
			syncInputs();
			drawPad();
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
		"resolution_master_ui",
		"pt_resolution_master",
		container,
		{
			getValue: () => "",
			setValue: () => {},
			getMinHeight: () => 420,
			hideOnZoom: true,
		},
	);
	domWidget.serialize = false;

	// AI bridge hook (see web/ai_bridge.js): apply a patch from the harness
	// with proper rescale-factor recomputation and UI refresh, instead of
	// blindly writing widget values.
	node._ptResolutionApply = (patch = {}) => {
		const num = (v) => (v == null ? null : Number(v));
		if (patch.width != null || patch.height != null) {
			const [cw, ch] = getWH();
			setWH(num(patch.width) ?? cw, num(patch.height) ?? ch);
		}
		if (patch.rescale_mode != null) {
			const m = String(patch.rescale_mode);
			if (["manual", "resolution", "megapixels"].includes(m)) {
				props.ptRescaleMode = m;
			}
		}
		if (patch.rescale_value != null) {
			setRaw(props.ptRescaleMode, num(patch.rescale_value));
		}
		if (patch.rescale_mode != null || patch.rescale_value != null) {
			writeRescale();
		}
		for (const name of ["batch_size", "latent_type", "mode", "auto_detect"]) {
			if (patch[name] == null) continue;
			const w = node.widgets?.find((x) => x.name === name);
			if (w) {
				w.value = patch[name];
				w.callback?.(w.value);
			}
		}
		syncInputs();
		node.setDirtyCanvas?.(true, true);
	};

	// The rescale widgets may hold stale raw values from older versions of
	// this port; normalize to the computed factor on setup.
	writeRescale();
	syncInputs();
}

app.registerExtension({
	name: "PromptToolkit.ResolutionMaster",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData.name !== "ResolutionMasterPT") return;
		const orig = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const r = orig?.apply(this, arguments);
			try {
				setupResolutionMaster(this);
				if (this.size[0] < 340) this.size[0] = 340;
			} catch (err) {
				console.error("[PromptToolkit] resolution master setup failed", err);
			}
			return r;
		};
	},
});
