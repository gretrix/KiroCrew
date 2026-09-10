const assert = require("node:assert");
const {
  ANNOTATE_OPS,
  HOST_ID,
  OVERLAY_SOURCE,
  callExpression,
  sanitizeItem,
  sanitizeItems,
  runAnnotateOp,
} = require("../browser-annotate");
const { PAGE_HELPERS_SOURCE, WALKER_SOURCE } = require("../browser-ops");

// ── page-side sources ──

test("overlay: valid JS that splices the walker's shared helpers (same refs, same names)", () => {
  // Must parse -- a syntax error here would surface only as an executeJavaScript
  // rejection at click time.
  assert.doesNotThrow(() => new Function(OVERLAY_SOURCE));
  assert.doesNotThrow(() => new Function(WALKER_SOURCE));
  // The overlay and the walker mint refs through ONE implementation: the helper
  // fragment is embedded verbatim in both, so `eN` in a chat draft is the `eN`
  // the agent's snapshot sees.
  assert.ok(OVERLAY_SOURCE.includes(PAGE_HELPERS_SOURCE), "overlay embeds PAGE_HELPERS_SOURCE");
  assert.ok(WALKER_SOURCE.includes(PAGE_HELPERS_SOURCE), "walker embeds PAGE_HELPERS_SOURCE");
  assert.ok(PAGE_HELPERS_SOURCE.includes("function assignRef(el)"));
  assert.ok(PAGE_HELPERS_SOURCE.includes("function selectorOf(el)"));
  // One host element, marked decorative, that teardown removes.
  assert.ok(OVERLAY_SOURCE.includes(JSON.stringify(HOST_ID)));
  assert.ok(OVERLAY_SOURCE.includes('host.setAttribute("aria-hidden", "true")'));
  assert.ok(OVERLAY_SOURCE.includes("delete window.__kcAnnotate"));
  // Pick mode swallows the click in the CAPTURE phase so the page never acts on it.
  assert.ok(OVERLAY_SOURCE.includes('document.addEventListener("click", onClick, true)'));
  // The note editor focuses itself: no second click to start typing.
  assert.ok(OVERLAY_SOURCE.includes("input.focus(); setTimeout("));
});

test("callExpression: guards on the overlay being present and passes one JSON arg", () => {
  assert.strictEqual(
    callExpression("poll"),
    '(window.__kcAnnotate && typeof window.__kcAnnotate["poll"] === "function") ? window.__kcAnnotate["poll"]() : null',
  );
  assert.ok(callExpression("remove", 3).endsWith('["remove"](3) : null'));
  assert.ok(callExpression("start", { labels: { save: "S" } }).includes('({"labels":{"save":"S"}})'));
  assert.doesNotThrow(() => new Function(`return ${callExpression("edit", 1)}`));
});

// ── sanitizers ──

test("sanitizeItem: keeps the renderer's fields with the expected types, drops malformed items", () => {
  const raw = {
    id: 3, n: 1, note: "fix", ref: "e9", tag: "button", role: "button", name: "Save", text: "Save",
    selector: "#save", rect: { x: 1.5, y: 2, width: 3, height: 4 }, detached: false, el: { secret: true },
  };
  assert.deepStrictEqual(sanitizeItem(raw), {
    id: 3, n: 1, note: "fix", ref: "e9", tag: "button", role: "button", name: "Save", text: "Save",
    selector: "#save", rect: { x: 1.5, y: 2, width: 3, height: 4 }, detached: false,
  });
  assert.strictEqual(sanitizeItem(null), null);
  assert.strictEqual(sanitizeItem({ id: "3", n: 1, ref: "e1" }), null, "non-numeric id");
  assert.strictEqual(sanitizeItem({ id: 1, n: 1 }), null, "missing ref");
  const loose = sanitizeItem({ id: 1, n: 2, ref: "e1", note: 7, rect: null, detached: 1 });
  assert.deepStrictEqual(loose, {
    id: 1, n: 2, note: "", ref: "e1", tag: "", role: "", name: "", text: "", selector: "",
    rect: { x: 0, y: 0, width: 0, height: 0 }, detached: true,
  });
  assert.deepStrictEqual(sanitizeItems("nope"), []);
  assert.deepStrictEqual(sanitizeItems([raw, null, { id: 2, n: 2, ref: "e2" }]).map((i) => i.id), [3, 2]);
});

// ── op dispatcher ──

function fakeContents(handlers = {}) {
  const calls = [];
  const overlayPresent = handlers.overlayPresent !== false;
  return {
    calls,
    isDestroyed: () => !!handlers.destroyed,
    async executeJavaScript(src) {
      if (src === OVERLAY_SOURCE) { calls.push("install"); return handlers.install || { ok: true, reused: false }; }
      const m = /__kcAnnotate\["(\w+)"\]\((.*)\) : null$/.exec(src);
      assert.ok(m, `unexpected script: ${src.slice(0, 80)}`);
      const method = m[1];
      const arg = m[2] ? JSON.parse(m[2]) : undefined;
      calls.push(`${method}${arg === undefined ? "" : ":" + JSON.stringify(arg)}`);
      if (!overlayPresent) return null;
      if (handlers[method]) return handlers[method](arg);
      return { ok: true };
    },
    capturePage() {
      calls.push("capture");
      if (handlers.captureEmpty) return Promise.resolve({ getSize: () => ({ width: 0, height: 0 }), toPNG: () => Buffer.alloc(0) });
      return Promise.resolve({ getSize: () => ({ width: 2000, height: 1200 }), toPNG: () => Buffer.from("png") });
    },
  };
}

test("runAnnotateOp: op set is closed; unknown ops throw like the control dispatcher", async () => {
  assert.deepStrictEqual([...ANNOTATE_OPS], ["start", "stop", "poll", "remove", "clear", "edit", "capture", "teardown"]);
  await assert.rejects(() => runAnnotateOp(fakeContents(), "evaluate", {}), /unsupported annotate op: evaluate/);
});

test("runAnnotateOp: answers (never throws) without a view", async () => {
  assert.deepStrictEqual(await runAnnotateOp(null, "poll"), { ok: false, code: "no_view", error: "no native browser view" });
  const gone = await runAnnotateOp(fakeContents({ destroyed: true }), "poll");
  assert.strictEqual(gone.code, "no_view");
});

test("runAnnotateOp start: installs the overlay, then starts pick mode with the caller's labels", async () => {
  const wc = fakeContents({ start: () => ({ ok: true, url: "https://x.test/", title: "X" }) });
  const res = await runAnnotateOp(wc, "start", { labels: { placeholder: "Note…", save: "OK" } });
  assert.deepStrictEqual(res, { ok: true, url: "https://x.test/", title: "X" });
  assert.deepStrictEqual(wc.calls, ["install", 'start:{"labels":{"placeholder":"Note…","save":"OK"}}']);
});

test("runAnnotateOp poll: sanitizes items and events; a missing overlay is an answered no_overlay", async () => {
  const wc = fakeContents({
    poll: () => ({
      ok: true, picking: 1, editing: 0, url: "https://x.test/", title: "X",
      items: [{ id: 1, n: 1, note: "a", ref: "e2", tag: "button", role: "button", name: "Save", text: "Save", selector: "#s", rect: { x: 0, y: 0, width: 1, height: 1 }, detached: false, el: {} }],
      events: [{ type: "added", item: {} }, { type: "removed", id: 9 }, { nope: true }, null],
    }),
  });
  const res = await runAnnotateOp(wc, "poll");
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.picking, true);
  assert.strictEqual(res.editing, false);
  assert.deepStrictEqual(res.items.map((i) => [i.id, i.ref, i.note]), [[1, "e2", "a"]]);
  assert.strictEqual("el" in res.items[0], false, "page-side element handle never crosses IPC");
  assert.deepStrictEqual(res.events, [{ type: "added", id: undefined }, { type: "removed", id: 9 }]);

  const missing = await runAnnotateOp(fakeContents({ overlayPresent: false }), "poll");
  assert.deepStrictEqual(missing, { ok: false, code: "no_overlay", error: "no annotate overlay on this page" });
});

test("runAnnotateOp remove/edit: need a numeric id and forward it", async () => {
  const wc = fakeContents({ remove: (id) => ({ ok: id === 4 }), edit: (id) => ({ ok: id === 4 }) });
  assert.deepStrictEqual(await runAnnotateOp(wc, "remove", { id: "x" }), { ok: false, code: "bad_id", error: "remove needs a numeric id" });
  assert.deepStrictEqual(await runAnnotateOp(wc, "remove", { id: 4 }), { ok: true });
  assert.deepStrictEqual(await runAnnotateOp(wc, "edit", { id: 5 }), { ok: false });
  assert.deepStrictEqual(wc.calls, ["remove:4", "edit:5"]);
});

test("runAnnotateOp capture: prepares the overlay (editor closed, markers on) BEFORE capturePage, returns sizes + items", async () => {
  const wc = fakeContents({
    prepareCapture: () => ({
      ok: true, url: "https://x.test/", title: "X", width: 1000, height: 600, dpr: 2,
      items: [{ id: 1, n: 1, note: "a", ref: "e2", rect: { x: 0, y: 0, width: 1, height: 1 } }],
    }),
  });
  const res = await runAnnotateOp(wc, "capture");
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(wc.calls, ["prepareCapture", "capture"]);
  assert.strictEqual(res.png, Buffer.from("png").toString("base64"));
  assert.deepStrictEqual([res.width, res.height, res.cssWidth, res.cssHeight, res.dpr], [2000, 1200, 1000, 600, 2]);
  assert.deepStrictEqual(res.items.map((i) => i.ref), ["e2"]);

  const empty = await runAnnotateOp(fakeContents({ captureEmpty: true }), "capture");
  assert.strictEqual(empty.code, "capture_empty");
  const noOverlay = await runAnnotateOp(fakeContents({ overlayPresent: false }), "capture");
  assert.strictEqual(noOverlay.code, "no_overlay");
});

test("runAnnotateOp: a page-side exception becomes an answered annotate_failed", async () => {
  const wc = fakeContents({ clear: () => { throw new Error("boom"); } });
  const res = await runAnnotateOp(wc, "clear");
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, "annotate_failed");
  assert.match(res.error, /boom/);
});
