import { app } from "../../../scripts/app.js";

/**
 * Floating prompt panel for the PromptPanel node.
 *
 * On node creation a small button is added inside the node body. Clicking
 * it opens a draggable, resizable floating panel pinned to the document
 * body (so it stays put regardless of canvas pan/zoom). The panel has two
 * textareas (positive / negative) that live-sync to the node's widgets,
 * plus character counts and copy/clear buttons.
 *
 * The panel position is stored in localStorage so it survives reloads.
 * Multiple panels are supported (one per PromptPanel node instance).
 */

const STORAGE_KEY = "pt_prompt_panel_pos";
const PANEL_MIN_W = 360;
const PANEL_MIN_H = 280;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function getWidget(node, name) {
	return node.widgets?.find((w) => w.name === name);
}

function getWidgetValue(node, name, fallback = "") {
	const w = getWidget(node, name);
	return w?.value ?? fallback;
}

function setWidgetValue(node, name, value) {
	const w = getWidget(node, name);
	if (!w) return;
	w.value = value;
	// Trigger ComfyUI's widget callback so the graph knows something changed
	w.callback?.(value);
}

/** Load / save panel position to localStorage. */
function loadPos(id) {
	try {
		const raw = localStorage.getItem(STORAGE_KEY + ":" + id);
		if (raw) return JSON.parse(raw);
	} catch (_) {}
	return null;
}

function savePos(id, pos) {
	try {
		localStorage.setItem(STORAGE_KEY + ":" + id, JSON.stringify(pos));
	} catch (_) {}
}

/** Count characters and tokens (rough: comma-separated tags). */
function countTokens(text) {
	if (!text) return 0;
	return text
		.split(/[,\n]/)
		.map((t) => t.trim())
		.filter(Boolean).length;
}

/* ------------------------------------------------------------------ */
/* Panel creation                                                      */
/* ------------------------------------------------------------------ */

function createPanel(node) {
	const nodeId = node.id;
	const savedPos = loadPos(nodeId);

	// Root container
	const panel = document.createElement("div");
	panel.className = "pt-prompt-panel";
	panel.dataset.nodeId = String(nodeId);
	Object.assign(panel.style, {
		position: "fixed",
		zIndex: "99999",
		display: "flex",
		flexDirection: "column",
		background: "#1e1e1e",
		border: "1px solid #4a4a4a",
		borderRadius: "8px",
		boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
		width: (savedPos?.w || 420) + "px",
		minWidth: PANEL_MIN_W + "px",
		minHeight: PANEL_MIN_H + "px",
		fontFamily: "inherit",
		overflow: "hidden",
		userSelect: "none",
	});

	// Position
	const px = savedPos?.x ?? Math.max(20, window.innerWidth - 460);
	const py = savedPos?.y ?? 80;
	panel.style.left = px + "px";
	panel.style.top = py + "px";

	// ---- Title bar (drag handle) ----
	const titleBar = document.createElement("div");
	Object.assign(titleBar.style, {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		padding: "6px 10px",
		background: "#2a2a2a",
		borderBottom: "1px solid #3a3a3a",
		cursor: "move",
		fontSize: "12px",
		fontWeight: "bold",
		color: "#ccc",
		flex: "0 0 auto",
	});

	const titleText = document.createElement("span");
	titleText.textContent = `📝 Prompt Panel #${nodeId}`;
	titleText.style.whiteSpace = "nowrap";
	titleText.style.overflow = "hidden";
	titleText.style.textOverflow = "ellipsis";

	const closeBtn = document.createElement("button");
	closeBtn.type = "button";
	closeBtn.textContent = "✕";
	closeBtn.title = "Close panel";
	Object.assign(closeBtn.style, {
		background: "none",
		border: "none",
		color: "#999",
		fontSize: "14px",
		cursor: "pointer",
		padding: "0 4px",
		lineHeight: "1",
	});
	closeBtn.addEventListener(
		"mouseenter",
		() => (closeBtn.style.color = "#f44"),
	);
	closeBtn.addEventListener(
		"mouseleave",
		() => (closeBtn.style.color = "#999"),
	);
	closeBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		panel.remove();
	});

	titleBar.appendChild(titleText);
	titleBar.appendChild(closeBtn);
	panel.appendChild(titleBar);

	// ---- Content area ----
	const content = document.createElement("div");
	Object.assign(content.style, {
		display: "flex",
		flexDirection: "column",
		flex: "1 1 auto",
		padding: "8px",
		gap: "6px",
		overflow: "hidden",
	});
	panel.appendChild(content);

	/** Build one prompt section (label + textarea + footer). */
	function makeSection(labelText, widgetName, accentColor) {
		const wrap = document.createElement("div");
		Object.assign(wrap.style, {
			display: "flex",
			flexDirection: "column",
			flex: "1 1 auto",
			minHeight: "0",
			gap: "3px",
		});

		const header = document.createElement("div");
		Object.assign(header.style, {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: "6px",
		});

		const label = document.createElement("span");
		label.textContent = labelText;
		Object.assign(label.style, {
			fontSize: "11px",
			fontWeight: "bold",
			color: accentColor,
			flex: "0 0 auto",
		});

		const btns = document.createElement("div");
		Object.assign(btns.style, {
			display: "flex",
			gap: "4px",
			flex: "0 0 auto",
		});

		function makeMiniBtn(text, title) {
			const b = document.createElement("button");
			b.type = "button";
			b.textContent = text;
			b.title = title;
			Object.assign(b.style, {
				background: "#333",
				border: "1px solid #444",
				borderRadius: "3px",
				color: "#aaa",
				fontSize: "10px",
				padding: "1px 6px",
				cursor: "pointer",
				lineHeight: "16px",
			});
			b.addEventListener("mouseenter", () => {
				b.style.background = "#444";
				b.style.color = "#fff";
			});
			b.addEventListener("mouseleave", () => {
				b.style.background = "#333";
				b.style.color = "#aaa";
			});
			return b;
		}

		const copyBtn = makeMiniBtn("📋", "Copy to clipboard");
		const clearBtn = makeMiniBtn("🗑", "Clear");
		btns.appendChild(copyBtn);
		btns.appendChild(clearBtn);

		header.appendChild(label);
		header.appendChild(btns);

		const ta = document.createElement("textarea");
		ta.spellcheck = false;
		ta.placeholder = labelText + "...";
		Object.assign(ta.style, {
			flex: "1 1 auto",
			minHeight: "60px",
			width: "100%",
			boxSizing: "border-box",
			background: "#161616",
			border: "1px solid #333",
			borderRadius: "4px",
			color: "#ddd",
			fontSize: "12px",
			fontFamily: "inherit",
			padding: "6px 8px",
			resize: "none",
			outline: "none",
			lineHeight: "1.5",
			overflow: "auto",
		});
		ta.addEventListener("focus", () => (ta.style.borderColor = "#5a5a5a"));
		ta.addEventListener("blur", () => (ta.style.borderColor = "#333"));

		const footer = document.createElement("div");
		Object.assign(footer.style, {
			display: "flex",
			justifyContent: "space-between",
			fontSize: "10px",
			color: "#777",
			flex: "0 0 auto",
			userSelect: "none",
		});
		const charSpan = document.createElement("span");
		const tokenSpan = document.createElement("span");
		footer.appendChild(charSpan);
		footer.appendChild(tokenSpan);

		function updateCount() {
			const v = ta.value;
			charSpan.textContent = `${v.length} chars`;
			tokenSpan.textContent = `${countTokens(v)} tags`;
		}

		// Sync textarea → widget
		ta.addEventListener("input", () => {
			setWidgetValue(node, widgetName, ta.value);
			updateCount();
		});

		// Copy
		copyBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			navigator.clipboard?.writeText(ta.value).then(() => {
				copyBtn.textContent = "✓";
				setTimeout(() => (copyBtn.textContent = "📋"), 800);
			});
		});

		// Clear
		clearBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			ta.value = "";
			setWidgetValue(node, widgetName, "");
			updateCount();
		});

		wrap.appendChild(header);
		wrap.appendChild(ta);
		wrap.appendChild(footer);

		// Initial value from widget
		ta.value = getWidgetValue(node, widgetName, "");
		updateCount();

		return { wrap, textarea: ta, updateCount };
	}

	const posSection = makeSection("Positive", "positive", "#7c7");

	posSection.wrap.style.flex = "1 1 auto";

	content.appendChild(posSection.wrap);

	// ---- Resize handle (bottom-right corner) ----
	const resizeHandle = document.createElement("div");
	Object.assign(resizeHandle.style, {
		flex: "0 0 auto",
		height: "14px",
		background: "#2a2a2a",
		borderTop: "1px solid #3a3a3a",
		cursor: "se-resize",
		display: "flex",
		alignItems: "center",
		justifyContent: "flex-end",
		padding: "0 4px",
		fontSize: "10px",
		color: "#555",
	});
	resizeHandle.textContent = "◢";
	panel.appendChild(resizeHandle);

	/* ---- Drag logic ---- */
	{
		let dragging = false;
		let dx = 0,
			dy = 0;

		titleBar.addEventListener("mousedown", (e) => {
			if (e.target === closeBtn) return;
			dragging = true;
			const rect = panel.getBoundingClientRect();
			dx = e.clientX - rect.left;
			dy = e.clientY - rect.top;
			e.preventDefault();
		});

		const onMove = (e) => {
			if (!dragging) return;
			const x = Math.max(0, Math.min(window.innerWidth - 80, e.clientX - dx));
			const y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dy));
			panel.style.left = x + "px";
			panel.style.top = y + "px";
		};
		const onUp = () => {
			if (!dragging) return;
			dragging = false;
			savePos(nodeId, {
				x: parseInt(panel.style.left, 10),
				y: parseInt(panel.style.top, 10),
				w: panel.offsetWidth,
			});
		};
		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
		// Cleanup when panel is removed
		const cleanup = () => {
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
		};
		panel._cleanup = cleanup;
	}

	/* ---- Resize logic ---- */
	{
		let resizing = false;
		let startX = 0,
			startY = 0,
			startW = 0,
			startH = 0;

		resizeHandle.addEventListener("mousedown", (e) => {
			resizing = true;
			startX = e.clientX;
			startY = e.clientY;
			startW = panel.offsetWidth;
			startH = panel.offsetHeight;
			e.preventDefault();
			e.stopPropagation();
		});

		const onMove = (e) => {
			if (!resizing) return;
			const w = Math.max(PANEL_MIN_W, startW + (e.clientX - startX));
			const h = Math.max(PANEL_MIN_H, startH + (e.clientY - startY));
			panel.style.width = w + "px";
			panel.style.height = h + "px";
		};
		const onUp = () => {
			if (!resizing) return;
			resizing = false;
			savePos(nodeId, {
				x: parseInt(panel.style.left, 10),
				y: parseInt(panel.style.top, 10),
				w: panel.offsetWidth,
			});
		};
		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
		const prevCleanup = panel._cleanup;
		panel._cleanup = () => {
			prevCleanup?.();
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
		};
	}

	/* ---- Widget → textarea sync (external changes) ---- */
	const syncInterval = setInterval(() => {
		if (!panel.isConnected) {
			clearInterval(syncInterval);
			return;
		}
		const posW = getWidgetValue(node, "positive", "");
		if (
			posSection.textarea !== document.activeElement &&
			posSection.textarea.value !== posW
		) {
			posSection.textarea.value = posW;
			posSection.updateCount();
		}
	}, 500);

	/* ---- Cleanup on node removal ---- */
	const origOnRemoved = node.onRemoved;
	node.onRemoved = function () {
		panel._cleanup?.();
		panel.remove();
		clearInterval(syncInterval);
		origOnRemoved?.apply(this, arguments);
	};

	// Close button cleanup
	closeBtn.addEventListener("click", () => {
		panel._cleanup?.();
		clearInterval(syncInterval);
	});

	document.body.appendChild(panel);
	return panel;
}

/* ------------------------------------------------------------------ */
/* Node setup: add a "Open Panel" button widget                        */
/* ------------------------------------------------------------------ */

function setupNode(node) {
	// Small button bar inside the node
	const btnBar = document.createElement("div");
	Object.assign(btnBar.style, {
		display: "flex",
		gap: "6px",
		padding: "4px",
		height: "28px",
		boxSizing: "border-box",
		overflow: "hidden",
	});

	const openBtn = document.createElement("button");
	openBtn.type = "button";
	openBtn.textContent = "📂 Open Prompt Panel";
	Object.assign(openBtn.style, {
		flex: "1 1 auto",
		background: "#2a4a2a",
		border: "1px solid #3a6a3a",
		borderRadius: "4px",
		color: "#8c8",
		fontSize: "11px",
		padding: "4px 8px",
		cursor: "pointer",
	});
	openBtn.addEventListener("mouseenter", () => {
		openBtn.style.background = "#3a5a3a";
	});
	openBtn.addEventListener("mouseleave", () => {
		openBtn.style.background = "#2a4a2a";
	});

	let panel = null;
	openBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		// Toggle: if panel exists and is connected, close it
		if (panel?.isConnected) {
			panel._cleanup?.();
			panel.remove();
			panel = null;
			openBtn.textContent = "📂 Open Prompt Panel";
			return;
		}
		panel = createPanel(node);
		openBtn.textContent = "📂 Close Prompt Panel";
	});

	btnBar.appendChild(openBtn);

	const domWidget = node.addDOMWidget(
		"prompt_panel_btn",
		"pt_prompt_panel_btn",
		btnBar,
		{
			getValue: () => "",
			setValue: () => {},
			getMinHeight: () => 32,
			computeSize: () => [0, 32],
		},
	);
	domWidget.serialize = false;
	domWidget.options = domWidget.options || {};
	domWidget.options.boundingBox = () => [0, 32];
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

app.registerExtension({
	name: "PromptToolkit.PromptPanel",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData.name !== "PromptPanel") return;
		const orig = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const r = orig?.apply(this, arguments);
			try {
				setupNode(this);
			} catch (err) {
				console.error("[PromptToolkit] prompt panel setup failed", err);
			}
			return r;
		};
	},
});
