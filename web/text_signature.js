import { app } from "../../../scripts/app.js";

/**
 * Text Signature node — type text, pick a font, render a transparent
 * signature image. The rendered PNG (data URL) is stored in the hidden
 * ``text_sig_data`` widget so it serializes with the workflow; the backend
 * decodes it into IMAGE + MASK (Load Image mask convention), ready to feed
 * the watermark nodes.
 *
 * All styling uses fixed dark hex colors (not CSS vars) so it is unaffected
 * by the ComfyUI theme accent color. Compatible with Nodes 2.0 (Vue) and the
 * legacy canvas via addDOMWidget.
 */

const CSS = `
.pt-ts{display:flex;flex-direction:column;width:100%;height:100%;box-sizing:border-box;gap:5px;padding:2px 4px;font-size:11px;color:#ddd}
.pt-ts-row{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.pt-ts-input{background:#1f1f1f;color:#ddd;border:1px solid #3a3a3a;border-radius:4px;font-size:12px;height:24px;box-sizing:border-box;padding:0 4px;outline:none!important;box-shadow:none!important}
.pt-ts-input:focus{border-color:#6af}
.pt-ts-btn{background:#1f1f1f;color:#ddd;border:1px solid #3a3a3a;border-radius:4px;padding:0 10px;font-size:12px;cursor:pointer;height:24px;white-space:nowrap;outline:none!important;box-shadow:none!important}
.pt-ts-btn:hover{border-color:#6af}
.pt-ts-btn.active{background:#2c4a6e;border-color:#6af}
.pt-ts-slider{accent-color:#6af;height:16px;min-width:50px;outline:none!important}
.pt-ts-label{opacity:.85;white-space:nowrap;min-width:40px}
.pt-ts-val{font-size:11px;opacity:.7;min-width:34px;text-align:right;white-space:nowrap}
.pt-ts-canvas-wrap{flex:1 1 auto;min-height:60px;border:1px solid #3a3a3a;border-radius:4px;overflow:hidden;background:
repeating-conic-gradient(#2a2a2a 0% 25%, #333 0% 50%) 50% / 12px 12px;position:relative;display:flex;align-items:center;justify-content:center}
.pt-ts-canvas{max-width:100%;max-height:100%;display:block;image-rendering:auto}
.pt-ts-empty{opacity:.5;font-size:11px}
`;

let cssInjected = false;
function injectCSS() {
	if (cssInjected) return;
	cssInjected = true;
	const s = document.createElement("style");
	s.textContent = CSS;
	document.head.appendChild(s);
}

function hideWidget(w) {
	if (!w || w.type === "converted-widget") return;
	w.hidden = true;
	w.options = w.options || {};
	w.options.hidden = true;
	w.computeSize = () => [0, -4];
	w.type = "converted-widget";
}

function el(tag, cls, props = {}) {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	Object.assign(e, props);
	return e;
}

const FONTS = [
	["Segoe Script, cursive", "Segoe Script"],
	["Brush Script MT, cursive", "Brush Script MT"],
	["Lucida Handwriting, cursive", "Lucida Handwriting"],
	["Bradley Hand ITC, cursive", "Bradley Hand"],
	["Snell Roundhand, cursive", "Snell Roundhand"],
	["Edwardian Script ITC, cursive", "Edwardian Script"],
	["Comic Sans MS, cursive", "Comic Sans MS"],
	["Georgia, serif", "Georgia"],
	["Times New Roman, serif", "Times New Roman"],
	["Garamond, serif", "Garamond"],
	["Arial, sans-serif", "Arial"],
	["Segoe UI, sans-serif", "Segoe UI"],
	["Courier New, monospace", "Courier New"],
	["cursive", "Cursive (generic)"],
];

function setupTextSignature(node) {
	injectCSS();
	const wData = node.widgets?.find((w) => w.name === "text_sig_data");
	hideWidget(wData);

	// ---- serializable state widget -----------------------------------------
	// text_sig_state is declared in Python INPUT_TYPES so ComfyUI serializes it.
	const stateWidget = node.widgets?.find((w) => w.name === "text_sig_state");
	hideWidget(stateWidget);

	// Parse saved state or use defaults
	let saved = {};
	try {
		if (stateWidget.value) saved = JSON.parse(stateWidget.value);
	} catch {}

	const p = {
		text: saved.text ?? "",
		font: saved.font ?? FONTS[0][0],
		size: saved.size ?? 64,
		color: saved.color ?? "#ffffff",
		bold: saved.bold ?? false,
		italic: saved.italic ?? false,
		padding: saved.padding ?? 16,
		letterSpacing: saved.letterSpacing ?? 0,
		importedFonts: saved.importedFonts ?? [], // [{name, dataUrl}]
	};

	function saveState() {
		const slim = {
			text: p.text,
			font: p.font,
			size: p.size,
			color: p.color,
			bold: p.bold,
			italic: p.italic,
			padding: p.padding,
			letterSpacing: p.letterSpacing,
			importedFonts: (p.importedFonts || []).map((e) => ({
				name: e.name,
				dataUrl: e.dataUrl,
			})),
		};
		stateWidget.value = JSON.stringify(slim);
		stateWidget.callback?.(stateWidget.value);
	}

	const container = el("div", "pt-ts");

	// row 1: text input
	const row1 = el("div", "pt-ts-row");
	const textInput = el("input", "pt-ts-input", {
		type: "text",
		placeholder: "输入签名文字…",
	});
	textInput.style.flex = "1 1 auto";
	textInput.style.minWidth = "120px";
	textInput.value = p.text;
	row1.append(el("span", "pt-ts-label", { textContent: "文字" }), textInput);

	// row 2: font select + size
	const row2 = el("div", "pt-ts-row");
	const fontSel = el("select", "pt-ts-input");
	fontSel.style.flex = "1 1 auto";
	for (const [val, label] of FONTS) fontSel.add(new Option(label, val));
	fontSel.value = p.font;
	const sizeLabel = el("span", "pt-ts-val", { textContent: `${p.size}px` });
	const sizeSlider = el("input", "pt-ts-slider", {
		type: "range",
		min: "16",
		max: "200",
		step: "1",
		value: String(p.size),
	});
	const importBtn = el("button", "pt-ts-btn", {
		textContent: "📁",
		title: "导入字体文件 (.ttf/.otf/.woff/.woff2)",
	});
	row2.append(
		el("span", "pt-ts-label", { textContent: "字体" }),
		fontSel,
		importBtn,
		sizeSlider,
		sizeLabel,
	);

	// row 3: color + bold/italic + padding + letterSpacing
	const row3 = el("div", "pt-ts-row");
	const colorInput = el("input", "pt-ts-input", {
		type: "color",
		value: p.color,
	});
	colorInput.style.width = "34px";
	colorInput.style.height = "24px";
	colorInput.style.padding = "0";
	const boldBtn = el("button", `pt-ts-btn${p.bold ? " active" : ""}`, {
		textContent: "B",
		title: "粗体",
	});
	boldBtn.style.fontWeight = "700";
	const italicBtn = el("button", `pt-ts-btn${p.italic ? " active" : ""}`, {
		textContent: "I",
		title: "斜体",
	});
	italicBtn.style.fontStyle = "italic";
	const padLabel = el("span", "pt-ts-val", { textContent: `${p.padding}px` });
	const padSlider = el("input", "pt-ts-slider", {
		type: "range",
		min: "0",
		max: "64",
		step: "1",
		value: String(p.padding),
	});
	const lsLabel = el("span", "pt-ts-val", {
		textContent: `${p.letterSpacing}`,
	});
	const lsSlider = el("input", "pt-ts-slider", {
		type: "range",
		min: "0",
		max: "20",
		step: "1",
		value: String(p.letterSpacing),
	});
	row3.append(
		el("span", "pt-ts-label", { textContent: "颜色" }),
		colorInput,
		boldBtn,
		italicBtn,
		el("span", "pt-ts-label", { textContent: "边距" }),
		padSlider,
		padLabel,
		el("span", "pt-ts-label", { textContent: "字距" }),
		lsSlider,
		lsLabel,
	);

	// preview canvas
	const wrap = el("div", "pt-ts-canvas-wrap");
	const canvas = el("canvas", "pt-ts-canvas");
	const empty = el("div", "pt-ts-empty", { textContent: "输入文字后此处预览" });
	wrap.append(canvas, empty);

	container.append(row1, row2, row3, wrap);

	// ---- render ------------------------------------------------------------
	function buildFontStr() {
		return `${p.italic ? "italic " : ""}${p.bold ? "700 " : "400 "}${p.size}px ${p.font}`;
	}

	function render() {
		const text = p.text;
		empty.style.display = text ? "none" : "block";
		if (!text) {
			canvas.width = 1;
			canvas.height = 1;
			writeData("");
			return;
		}
		// measure
		const measure = el("canvas").getContext("2d");
		measure.font = buildFontStr();
		const ls = p.letterSpacing;
		let totalW = 0;
		const widths = [];
		for (const ch of text) {
			const wch = measure.measureText(ch).width;
			widths.push(wch);
			totalW += wch + ls;
		}
		totalW -= ls; // last char no trailing spacing
		const ascent = measure.actualBoundingBoxAscent || p.size * 0.75;
		const descent = measure.actualBoundingBoxDescent || p.size * 0.25;
		const textH = ascent + descent;
		const pad = p.padding;
		const cw = Math.max(1, Math.ceil(totalW + pad * 2));
		const ch = Math.max(1, Math.ceil(textH + pad * 2));
		canvas.width = cw;
		canvas.height = ch;
		const ctx = canvas.getContext("2d");
		ctx.clearRect(0, 0, cw, ch);
		ctx.font = buildFontStr();
		ctx.fillStyle = p.color;
		ctx.textBaseline = "alphabetic";
		let x = pad;
		const y = pad + ascent;
		for (let i = 0; i < text.length; i++) {
			ctx.fillText(text[i], x, y);
			x += widths[i] + ls;
		}
		// scale display to fit wrap
		const fit = Math.min(
			1,
			(wrap.clientWidth - 8) / cw,
			(wrap.clientHeight - 8) / ch,
		);
		canvas.style.width = `${Math.round(cw * fit)}px`;
		canvas.style.height = `${Math.round(ch * fit)}px`;
		writeData(canvas.toDataURL("image/png"));
	}

	function writeData(dataUrl) {
		if (wData) {
			wData.value = dataUrl;
			wData.callback?.(dataUrl);
		}
	}

	// ---- events -----------------------------------------------------------
	function onParamsChange() {
		p.text = textInput.value;
		p.font = fontSel.value;
		p.size = Number(sizeSlider.value);
		p.color = colorInput.value;
		p.padding = Number(padSlider.value);
		p.letterSpacing = Number(lsSlider.value);
		sizeLabel.textContent = `${p.size}px`;
		padLabel.textContent = `${p.padding}px`;
		lsLabel.textContent = `${p.letterSpacing}`;
		render();
		saveState();
	}
	textInput.addEventListener("input", onParamsChange);
	fontSel.addEventListener("change", onParamsChange);
	sizeSlider.addEventListener("input", onParamsChange);
	colorInput.addEventListener("input", onParamsChange);
	padSlider.addEventListener("input", onParamsChange);
	lsSlider.addEventListener("input", onParamsChange);
	boldBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		p.bold = !p.bold;
		boldBtn.classList.toggle("active", p.bold);
		render();
		saveState();
	});
	italicBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		p.italic = !p.italic;
		italicBtn.classList.toggle("active", p.italic);
		render();
		saveState();
	});

	// ---- imported fonts ---------------------------------------------------
	function addFontOption(name, family) {
		const opt = el("option", { value: family, textContent: `📁 ${name}` });
		fontSel.add(opt, fontSel.firstChild);
	}

	async function loadImportedFont(entry) {
		try {
			const ff = new FontFace(entry.family, `url("${entry.dataUrl}")`);
			await ff.load();
			document.fonts.add(ff);
			addFontOption(entry.name, entry.family);
			console.log("[TextSignature] font loaded OK:", entry.name, entry.family);
			return true;
		} catch (e) {
			console.error(
				"[TextSignature] font load FAILED:",
				entry.name,
				e.message,
				e,
			);
			return false;
		}
	}

	async function importFontFile(file) {
		console.log(
			"[TextSignature] importing font:",
			file.name,
			file.size,
			"bytes",
		);
		const buf = await file.arrayBuffer();
		const b64 = arrayBufferToBase64(buf);
		const ext = (file.name.split(".").pop() || "ttf").toLowerCase();
		const mime =
			ext === "woff2"
				? "font/woff2"
				: ext === "woff"
					? "font/woff"
					: ext === "otf"
						? "font/otf"
						: "font/ttf";
		const dataUrl = `data:${mime};base64,${b64}`;
		const family = `PT-Imported-${Date.now()}`;
		const entry = { name: file.name, family, dataUrl };
		if (await loadImportedFont(entry)) {
			p.importedFonts.push(entry);
			p.font = family;
			// Defer select to next frame so the option is in the DOM
			requestAnimationFrame(() => {
				fontSel.value = family;
				onParamsChange();
			});
			saveState();
		} else {
			alert(`字体加载失败: ${file.name}\n请检查文件是否为有效的字体文件`);
		}
	}

	importBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		e.preventDefault();
		// Create file input on document.body — outside the DOM widget wrapper
		// so Vue's pointer-event interception doesn't block it.
		const tmp = document.createElement("input");
		tmp.type = "file";
		tmp.accept = ".ttf,.otf,.woff,.woff2";
		tmp.style.position = "fixed";
		tmp.style.left = "-9999px";
		tmp.style.opacity = "0";
		document.body.appendChild(tmp);
		tmp.addEventListener("change", () => {
			const f = tmp.files?.[0];
			if (f) importFontFile(f);
			document.body.removeChild(tmp);
		});
		// Some browsers need a microtask delay after append
		setTimeout(() => tmp.click(), 0);
	});

	function arrayBufferToBase64(buf) {
		let binary = "";
		const bytes = new Uint8Array(buf);
		const chunk = 0x8000;
		for (let i = 0; i < bytes.length; i += chunk)
			binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
		return btoa(binary);
	}

	// initial render (deferred so wrap has a size)
	(async () => {
		// Restore imported fonts from saved state (p.importedFonts already
		// parsed from stateWidget). Regenerate family names to avoid collisions.
		if (p.importedFonts.length) {
			const restored = [];
			for (const s of p.importedFonts) {
				const family = `PT-Imported-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
				const entry = { name: s.name, family, dataUrl: s.dataUrl };
				if (await loadImportedFont(entry)) {
					restored.push(entry);
					if (p.font && p.font.startsWith("PT-Imported-")) {
						p.font = family;
					}
				}
			}
			p.importedFonts = restored;
			// Select active font in dropdown
			for (const opt of fontSel.options) {
				if (opt.value === p.font) {
					opt.selected = true;
					break;
				}
			}
		}
		requestAnimationFrame(() => requestAnimationFrame(render));
	})();

	const ro = new ResizeObserver(() => render());
	ro.observe(wrap);

	const domWidget = node.addDOMWidget(
		"text_signature_ui",
		"pt_text_signature",
		container,
		{
			getValue: () => "",
			setValue: () => {},
			getMinHeight: () => 220,
			hideOnZoom: true,
		},
	);
	domWidget.serialize = false;

	const origOnRemoved = node.onRemoved;
	node.onRemoved = function () {
		ro.disconnect();
		origOnRemoved?.apply(this, arguments);
	};
}

app.registerExtension({
	name: "PromptToolkit.TextSignature",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData.name !== "TextSignature") return;
		const orig = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const r = orig?.apply(this, arguments);
			try {
				setupTextSignature(this);
				if (this.size[0] < 320) this.size[0] = 320;
			} catch (err) {
				console.error("[PromptToolkit] text signature setup failed", err);
			}
			return r;
		};
	},
});
