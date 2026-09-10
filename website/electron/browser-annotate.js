"use strict";

// Element-level annotation for the native Browser panel.
//
// The user clicks "Annotate", then points at elements ON THE LIVE PAGE: the
// element under the cursor is highlighted (devtools-inspect style), a click
// selects it and opens a small note editor anchored to it, Enter saves the
// note and leaves a numbered marker. The whole surface lives INSIDE the page
// as an injected overlay layer, because the native view is composited above
// the dashboard's DOM -- nothing the renderer draws could sit on top of it.
//
// A HUMAN action, so it deliberately bypasses the agent control plane
// (browser-control.js) and the CDP wire ops: the overlay is injected with
// `webContents.executeJavaScript`, state is read back by polling a small
// drain function, and the screenshot is `webContents.capturePage()`. No
// debugger attachment, no competition with the agent's single CDP owner,
// and Browser Mode may be off.
//
// Refs: the overlay splices in PAGE_HELPERS_SOURCE (browser-ops.js) -- the
// SAME `assignRef`/`accName`/`roleFor`/`selectorOf` the agent's `snapshot`
// walker runs, against the same `window.__kcRefs` map -- so the `eN` written
// into the chat draft is the `eN` the agent can pass to `click`/`hover`/
// `evaluate` (refs resolve through the map even for elements the outline
// does not list, e.g. a paragraph).
//
// The page's own DOM is never modified beyond the one host element; the
// overlay is torn down on `teardown`, and navigation drops it with the doc.

const { PAGE_HELPERS_SOURCE } = require("./browser-ops");

/** Ops the renderer may ask for. A closed set, like the control ops. */
const ANNOTATE_OPS = Object.freeze(["start", "stop", "poll", "remove", "clear", "edit", "capture", "teardown"]);

/** Upper bound on one page round-trip. */
const ANNOTATE_TIMEOUT_MS = 8000;

/** Labels the renderer supplies (already localized) for the in-page editor. */
const DEFAULT_LABELS = Object.freeze({
  placeholder: "Type a note, Enter to save, Esc to cancel",
  save: "Save",
  remove: "Remove",
});

const HOST_ID = "__kcAnnotateHost";

/**
 * The overlay, installed once per document as `window.__kcAnnotate`.
 * Everything it exposes is called through `executeJavaScript` by the ops
 * below; the renderer never touches page JS directly.
 */
const OVERLAY_SOURCE = `(() => {
  if (window.__kcAnnotate && window.__kcAnnotate.doc === document.documentURI && document.getElementById(${JSON.stringify(HOST_ID)})) {
    return { ok: true, reused: true };
  }
  ${PAGE_HELPERS_SOURCE}

  var Z = 2147483647;
  var COLOR = "#e03131";
  var labels = ${JSON.stringify(DEFAULT_LABELS)};
  var state = { picking: false, seq: 0, items: [], events: [], editing: null, hover: null };

  // ── host layer (fixed, full-viewport, click-through except its own widgets) ──
  var host = document.createElement("div");
  host.id = ${JSON.stringify(HOST_ID)};
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:" + Z + ";font:12px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;color:#111;";
  var hoverBox = document.createElement("div");
  hoverBox.style.cssText = "position:absolute;display:none;box-sizing:border-box;border:2px solid " + COLOR + ";background:rgba(224,49,49,.08);border-radius:3px;pointer-events:none;transition:all .04s linear;";
  var hoverTag = document.createElement("div");
  hoverTag.style.cssText = "position:absolute;display:none;padding:2px 6px;border-radius:4px;background:" + COLOR + ";color:#fff;font-size:11px;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis;pointer-events:none;";
  host.appendChild(hoverBox);
  host.appendChild(hoverTag);
  var marksLayer = document.createElement("div");
  marksLayer.style.cssText = "position:absolute;inset:0;pointer-events:none;";
  host.appendChild(marksLayer);
  var editor = null;
  (document.body || document.documentElement).appendChild(host);

  function inHost(node) { return !!(node && host.contains(node)); }
  function rectOf(el) { var r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; }
  function textOf(el) {
    var t = (el.textContent || "").replace(/\\s+/g, " ").trim();
    return t.length > CAP ? t.slice(0, CAP) + "\\u2026" : t;
  }
  function describe(el) {
    var role = roleFor(el);
    var name = accName(el);
    return {
      ref: assignRef(el),
      tag: el.tagName.toLowerCase(),
      role: role || "",
      name: name,
      text: textOf(el),
      selector: selectorOf(el),
      rect: rectOf(el),
    };
  }
  /** Deepest element at a point, descending open shadow roots; never our own host. */
  function deepElementAt(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el || inHost(el)) return null;
    var guard = 0;
    while (el && el.shadowRoot && guard++ < 20) {
      var inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    if (!el || el === document.documentElement || el === document.body) return null;
    return el;
  }
  function push(ev) { state.events.push(ev); if (state.events.length > 200) state.events.splice(0, state.events.length - 200); }
  function itemById(id) { for (var i = 0; i < state.items.length; i++) if (state.items[i].id === id) return state.items[i]; return null; }
  function publicItem(it) {
    return { id: it.id, n: it.n, note: it.note, ref: it.ref, tag: it.tag, role: it.role, name: it.name, text: it.text, selector: it.selector, rect: it.el ? rectOf(it.el) : it.rect, detached: !(it.el && it.el.isConnected) };
  }

  // ── hover highlight ──
  function showHover(el) {
    if (!el) { hoverBox.style.display = "none"; hoverTag.style.display = "none"; state.hover = null; return; }
    state.hover = el;
    var r = rectOf(el);
    hoverBox.style.display = "block";
    hoverBox.style.left = r.x + "px"; hoverBox.style.top = r.y + "px";
    hoverBox.style.width = r.width + "px"; hoverBox.style.height = r.height + "px";
    var role = roleFor(el); var name = accName(el);
    hoverTag.textContent = el.tagName.toLowerCase() + (role ? " · " + role : "") + (name ? " \\u201c" + (name.length > 40 ? name.slice(0, 40) + "\\u2026" : name) + "\\u201d" : "");
    hoverTag.style.display = "block";
    var top = r.y - 22; if (top < 2) top = r.y + r.height + 4;
    hoverTag.style.left = Math.max(2, r.x) + "px"; hoverTag.style.top = top + "px";
  }

  // ── markers (one badge + outline per annotation) ──
  function renderMarks() {
    while (marksLayer.firstChild) marksLayer.removeChild(marksLayer.firstChild);
    for (var i = 0; i < state.items.length; i++) {
      var it = state.items[i];
      if (!it.el || !it.el.isConnected) continue;
      var r = rectOf(it.el);
      var box = document.createElement("div");
      box.style.cssText = "position:absolute;box-sizing:border-box;border:2px solid " + COLOR + ";border-radius:3px;pointer-events:none;left:" + r.x + "px;top:" + r.y + "px;width:" + r.width + "px;height:" + r.height + "px;";
      var badge = document.createElement("button");
      badge.type = "button";
      badge.setAttribute("data-kc-mark", String(it.id));
      badge.textContent = String(it.n);
      badge.title = it.note;
      badge.style.cssText = "position:absolute;pointer-events:auto;cursor:pointer;min-width:20px;height:20px;padding:0 6px;border:0;border-radius:10px;background:" + COLOR + ";color:#fff;font:600 12px/20px system-ui,sans-serif;box-shadow:0 1px 3px rgba(0,0,0,.35);left:" + Math.max(0, r.x - 10) + "px;top:" + Math.max(0, r.y - 10) + "px;";
      badge.addEventListener("click", onBadgeClick, true);
      marksLayer.appendChild(box);
      marksLayer.appendChild(badge);
    }
  }
  function onBadgeClick(e) {
    e.preventDefault(); e.stopPropagation();
    var id = Number(e.currentTarget.getAttribute("data-kc-mark"));
    var it = itemById(id);
    if (it) openEditor(it);
  }

  // ── note editor (anchored to the element; focused immediately) ──
  function closeEditor(commit) {
    if (!editor) return;
    var it = state.editing;
    var value = editor.input.value.trim();
    var root = editor.root;
    editor = null; state.editing = null;
    if (root.parentNode) root.parentNode.removeChild(root);
    if (!it) return;
    if (commit) {
      if (!value) { removeItem(it.id); return; }
      var isNew = !it.note;
      it.note = value;
      if (isNew) { it.n = ++state.seq; state.items.push(it); push({ type: "added", item: publicItem(it) }); }
      else push({ type: "updated", item: publicItem(it) });
      renderMarks();
    } else if (!it.note) {
      // Cancelled before the first save: nothing to keep.
      push({ type: "cancelled" });
    }
  }
  function removeItem(id) {
    var idx = -1;
    for (var i = 0; i < state.items.length; i++) if (state.items[i].id === id) idx = i;
    if (idx < 0) return false;
    state.items.splice(idx, 1);
    for (var k = 0; k < state.items.length; k++) state.items[k].n = k + 1;
    state.seq = state.items.length;
    push({ type: "removed", id: id });
    renderMarks();
    return true;
  }
  function openEditor(it) {
    closeEditor(false);
    state.editing = it;
    var r = it.el ? rectOf(it.el) : it.rect;
    var root = document.createElement("div");
    root.style.cssText = "position:absolute;pointer-events:auto;display:flex;gap:6px;align-items:center;padding:6px;border-radius:8px;background:#fff;color:#111;box-shadow:0 4px 16px rgba(0,0,0,.25);border:1px solid rgba(0,0,0,.12);min-width:260px;max-width:min(420px,calc(100vw - 16px));";
    var n = document.createElement("span");
    n.textContent = String(it.n || state.items.length + 1);
    n.style.cssText = "flex:none;min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:" + COLOR + ";color:#fff;font:600 12px/20px system-ui,sans-serif;text-align:center;";
    var input = document.createElement("input");
    input.type = "text";
    input.value = it.note || "";
    input.placeholder = labels.placeholder;
    input.setAttribute("aria-label", labels.placeholder);
    input.style.cssText = "flex:1;min-width:0;height:26px;padding:0 8px;border:1px solid rgba(0,0,0,.2);border-radius:6px;font:13px system-ui,sans-serif;color:#111;background:#fff;outline:none;";
    input.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); closeEditor(true); }
      else if (e.key === "Escape") { e.preventDefault(); closeEditor(false); }
    }, true);
    input.addEventListener("focus", function () { input.style.borderColor = COLOR; });
    var save = document.createElement("button");
    save.type = "button"; save.textContent = labels.save;
    save.style.cssText = "flex:none;height:26px;padding:0 10px;border:0;border-radius:6px;background:" + COLOR + ";color:#fff;font:600 12px system-ui,sans-serif;cursor:pointer;";
    save.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); closeEditor(true); }, true);
    root.appendChild(n); root.appendChild(input); root.appendChild(save);
    if (it.note) {
      var del = document.createElement("button");
      del.type = "button"; del.textContent = labels.remove;
      del.style.cssText = "flex:none;height:26px;padding:0 8px;border:1px solid rgba(0,0,0,.2);border-radius:6px;background:#fff;color:#111;font:12px system-ui,sans-serif;cursor:pointer;";
      del.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); var id = it.id; closeEditor(false); removeItem(id); }, true);
      root.appendChild(del);
    }
    // Below the element when there is room, else above; clamped to the viewport.
    var top = r.y + r.height + 6;
    if (top + 44 > window.innerHeight) top = Math.max(4, r.y - 46);
    var left = Math.min(Math.max(4, r.x), Math.max(4, window.innerWidth - 300));
    root.style.left = left + "px"; root.style.top = top + "px";
    host.appendChild(root);
    editor = { root: root, input: input };
    // Type immediately: no second click. Two attempts because the click that
    // selected the element may still be settling focus on the page.
    input.focus(); setTimeout(function () { if (editor && editor.input === input) input.focus(); }, 0);
    showHover(null);
  }

  // ── pick mode: capture-phase listeners so the page never sees the click ──
  function onMove(e) {
    if (!state.picking || state.editing) return;
    if (inHost(e.target)) return;
    showHover(deepElementAt(e.clientX, e.clientY));
  }
  function onClick(e) {
    if (!state.picking) return;
    if (inHost(e.composedPath ? e.composedPath()[0] : e.target)) return;
    e.preventDefault(); e.stopPropagation();
    // A click elsewhere while a note is open saves it and picks the new
    // element in the same gesture -- no dead click between two annotations.
    if (state.editing) closeEditor(true);
    var path = e.composedPath ? e.composedPath() : [];
    var el = (path[0] && path[0].nodeType === 1 ? path[0] : null) || deepElementAt(e.clientX, e.clientY);
    if (!el || inHost(el)) return;
    var existing = null;
    for (var i = 0; i < state.items.length; i++) if (state.items[i].el === el) existing = state.items[i];
    if (existing) { openEditor(existing); return; }
    var d = describe(el);
    var it = { id: ++idSeq, n: 0, note: "", el: el, ref: d.ref, tag: d.tag, role: d.role, name: d.name, text: d.text, selector: d.selector, rect: d.rect };
    push({ type: "picked", item: publicItem(it) });
    openEditor(it);
  }
  function swallow(e) {
    if (!state.picking) return;
    if (inHost(e.composedPath ? e.composedPath()[0] : e.target)) return;
    e.preventDefault(); e.stopPropagation();
  }
  function onKey(e) {
    if (e.key === "Escape" && state.picking && !state.editing) { e.preventDefault(); e.stopPropagation(); setPicking(false); push({ type: "stopped" }); }
  }
  var idSeq = 0;
  function setPicking(on) {
    on = !!on;
    if (on === state.picking) return;
    state.picking = on;
    document.documentElement.style.cursor = on ? "crosshair" : "";
    if (!on) { showHover(null); closeEditor(true); }
  }
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("mousedown", swallow, true);
  document.addEventListener("mouseup", swallow, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", renderMarks, true);
  window.addEventListener("resize", renderMarks);
  // Layout can move elements without a scroll/resize (animations, lazy
  // content); keep markers glued at a low cadence while any exist.
  var glue = setInterval(function () { if (state.items.length) renderMarks(); }, 250);

  window.__kcAnnotate = {
    doc: document.documentURI,
    start: function (opts) {
      if (opts && opts.labels) { for (var k in opts.labels) if (opts.labels[k]) labels[k] = String(opts.labels[k]); }
      setPicking(true);
      return { ok: true, url: location.href, title: document.title };
    },
    stop: function () { setPicking(false); return { ok: true }; },
    poll: function () {
      var evs = state.events; state.events = [];
      return { ok: true, picking: state.picking, editing: !!state.editing, url: location.href, title: document.title, items: state.items.map(publicItem), events: evs };
    },
    remove: function (id) { closeEditor(false); return { ok: removeItem(Number(id)) }; },
    clear: function () { closeEditor(false); state.items = []; state.seq = 0; renderMarks(); push({ type: "cleared" }); return { ok: true }; },
    edit: function (id) { var it = itemById(Number(id)); if (!it) return { ok: false }; openEditor(it); return { ok: true }; },
    // Before a screenshot: hide the transient chrome, keep the markers.
    prepareCapture: function () { closeEditor(true); showHover(null); renderMarks(); return { ok: true, items: state.items.map(publicItem), url: location.href, title: document.title, width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 }; },
    teardown: function () {
      setPicking(false); closeEditor(false); clearInterval(glue);
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("mousedown", swallow, true);
      document.removeEventListener("mouseup", swallow, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", renderMarks, true);
      window.removeEventListener("resize", renderMarks);
      if (host.parentNode) host.parentNode.removeChild(host);
      delete window.__kcAnnotate;
      return { ok: true };
    },
  };
  return { ok: true, reused: false };
})()`;

/** Call one overlay method in the page; `null` when the overlay is not there. */
function callExpression(method, arg) {
  return `(window.__kcAnnotate && typeof window.__kcAnnotate[${JSON.stringify(method)}] === "function") ? window.__kcAnnotate[${JSON.stringify(method)}](${arg === undefined ? "" : JSON.stringify(arg)}) : null`;
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error(`${label} timed out after ${ms}ms`);
      err.code = "annotate_timeout";
      reject(err);
    }, ms);
    Promise.resolve(promise).then(
      (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } },
      (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } },
    );
  });
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Sanitize one annotation as the page reported it: only the fields the
 *  renderer consumes, only the types it expects. */
function sanitizeItem(it) {
  if (!it || typeof it !== "object") return null;
  const id = num(it.id);
  const n = num(it.n);
  if (id === null || n === null || typeof it.ref !== "string") return null;
  const r = it.rect && typeof it.rect === "object" ? it.rect : {};
  return {
    id,
    n,
    note: typeof it.note === "string" ? it.note : "",
    ref: it.ref,
    tag: typeof it.tag === "string" ? it.tag : "",
    role: typeof it.role === "string" ? it.role : "",
    name: typeof it.name === "string" ? it.name : "",
    text: typeof it.text === "string" ? it.text : "",
    selector: typeof it.selector === "string" ? it.selector : "",
    rect: { x: num(r.x) || 0, y: num(r.y) || 0, width: num(r.width) || 0, height: num(r.height) || 0 },
    detached: !!it.detached,
  };
}

function sanitizeItems(items) {
  return Array.isArray(items) ? items.map(sanitizeItem).filter(Boolean) : [];
}

/**
 * Serve one annotate op against a WebContents (or a test double exposing
 * `executeJavaScript`, `capturePage`, `isDestroyed`). Answered failures
 * resolve `{ ok:false, code, error }`; unknown ops throw like the control
 * dispatcher does.
 */
async function runAnnotateOp(webContents, op, args) {
  if (!ANNOTATE_OPS.includes(op)) throw new Error(`unsupported annotate op: ${op}`);
  const wc = webContents;
  if (!wc || typeof wc.executeJavaScript !== "function") {
    return { ok: false, code: "no_view", error: "no native browser view" };
  }
  if (typeof wc.isDestroyed === "function" && wc.isDestroyed()) {
    return { ok: false, code: "no_view", error: "the browser view is gone" };
  }
  const a = args && typeof args === "object" ? args : {};
  const exec = (src, label) => withTimeout(wc.executeJavaScript(src, true), ANNOTATE_TIMEOUT_MS, label);
  try {
    switch (op) {
      case "start": {
        const installed = await exec(OVERLAY_SOURCE, "overlay install");
        if (!installed || !installed.ok) return { ok: false, code: "install_failed", error: "could not install the annotate overlay" };
        const labels = a.labels && typeof a.labels === "object" ? a.labels : undefined;
        const res = await exec(callExpression("start", { labels }), "annotate start");
        if (!res || !res.ok) return { ok: false, code: "no_overlay", error: "the annotate overlay did not start" };
        return { ok: true, url: String(res.url || ""), title: String(res.title || "") };
      }
      case "stop":
        return (await exec(callExpression("stop"), "annotate stop")) ? { ok: true } : { ok: false, code: "no_overlay", error: "no annotate overlay on this page" };
      case "poll": {
        const res = await exec(callExpression("poll"), "annotate poll");
        if (!res) return { ok: false, code: "no_overlay", error: "no annotate overlay on this page" };
        return {
          ok: true,
          picking: !!res.picking,
          editing: !!res.editing,
          url: String(res.url || ""),
          title: String(res.title || ""),
          items: sanitizeItems(res.items),
          events: Array.isArray(res.events) ? res.events.filter((e) => e && typeof e.type === "string").map((e) => ({ type: e.type, id: num(e.id) ?? undefined })) : [],
        };
      }
      case "remove": {
        const id = num(a.id);
        if (id === null) return { ok: false, code: "bad_id", error: "remove needs a numeric id" };
        const res = await exec(callExpression("remove", id), "annotate remove");
        return res ? { ok: !!res.ok } : { ok: false, code: "no_overlay", error: "no annotate overlay on this page" };
      }
      case "edit": {
        const id = num(a.id);
        if (id === null) return { ok: false, code: "bad_id", error: "edit needs a numeric id" };
        const res = await exec(callExpression("edit", id), "annotate edit");
        return res ? { ok: !!res.ok } : { ok: false, code: "no_overlay", error: "no annotate overlay on this page" };
      }
      case "clear":
        return (await exec(callExpression("clear"), "annotate clear")) ? { ok: true } : { ok: false, code: "no_overlay", error: "no annotate overlay on this page" };
      case "teardown":
        await exec(callExpression("teardown"), "annotate teardown");
        return { ok: true };
      case "capture": {
        if (typeof wc.capturePage !== "function") return { ok: false, code: "no_view", error: "this view cannot be captured" };
        const prep = await exec(callExpression("prepareCapture"), "annotate prepare");
        if (!prep) return { ok: false, code: "no_overlay", error: "no annotate overlay on this page" };
        const image = await withTimeout(wc.capturePage(), ANNOTATE_TIMEOUT_MS, "capturePage");
        if (!image || typeof image.toPNG !== "function") return { ok: false, code: "capture_failed", error: "capturePage returned no image" };
        const size = typeof image.getSize === "function" ? image.getSize() : { width: 0, height: 0 };
        if (!size.width || !size.height) return { ok: false, code: "capture_empty", error: "the page has not painted yet -- try again" };
        const cssWidth = num(prep.width) || size.width;
        const cssHeight = num(prep.height) || size.height;
        return {
          ok: true,
          png: image.toPNG().toString("base64"),
          width: size.width,
          height: size.height,
          cssWidth,
          cssHeight,
          dpr: num(prep.dpr) || size.width / cssWidth,
          url: String(prep.url || ""),
          title: String(prep.title || ""),
          items: sanitizeItems(prep.items),
        };
      }
      default:
        throw new Error(`unsupported annotate op: ${op}`);
    }
  } catch (e) {
    if (e && /unsupported annotate op/.test(String(e.message))) throw e;
    const code = e && e.code === "annotate_timeout" ? "annotate_timeout" : "annotate_failed";
    return { ok: false, code, error: String((e && e.message) || e) };
  }
}

module.exports = {
  ANNOTATE_OPS,
  ANNOTATE_TIMEOUT_MS,
  DEFAULT_LABELS,
  HOST_ID,
  OVERLAY_SOURCE,
  callExpression,
  sanitizeItem,
  sanitizeItems,
  runAnnotateOp,
};
