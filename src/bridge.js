// UC Live Bridge - v1.12
// The Claude-Vault folder is the bus: extension writes captures/, results/, tabs.json;
// Claude (Cowork) writes commands/ and payloads/. No servers, everything local.
const $ = (id) => document.getElementById(id);
const log = (m, cls) => {
  const el = $("log");
  el.innerHTML = `<div class="${cls || ""}">[${new Date().toLocaleTimeString()}] ${m}</div>` + el.innerHTML;
  if (el.childNodes.length > 300) el.removeChild(el.lastChild);
};
$("ver").textContent = "v" + chrome.runtime.getManifest().version;

/* ---------- handle persistence (tiny IDB) ---------- */
const HDB = () => new Promise((res, rej) => {
  const r = indexedDB.open("adlerBridge", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("kv");
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const kvSet = async (k, v) => { const d = await HDB(); return new Promise((res, rej) => { const t = d.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); };
const kvGet = async (k) => { const d = await HDB(); return new Promise((res, rej) => { const r = d.transaction("kv").objectStore("kv").get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); };

let root = null, running = false, timer = null, tabsTimer = null, worker = null;
function startClock() {
  stopClock();
  try {
    worker = new Worker(chrome.runtime.getURL("bridge-worker.js"));
    worker.onmessage = () => pollCommands();
  } catch (e) {
    timer = setInterval(pollCommands, 1000);
    log("worker unavailable, page-timer fallback: " + e.message, "bad");
  }
}
function stopClock() { if (worker) { worker.terminate(); worker = null; } clearInterval(timer); }

async function subdir(name, create) {
  return root.getDirectoryHandle(name, { create: !!create });
}
async function writeText(dirName, fileName, text) {
  const d = await subdir(dirName, true);
  const fh = await d.getFileHandle(fileName, { create: true });
  const w = await fh.createWritable();
  await w.write(text); await w.close();
}
async function ensureLayout() {
  for (const n of ["captures", "commands", "results", "payloads"]) await subdir(n, true);
  await writeText("captures", "_bridge.json", JSON.stringify({ up: true, at: new Date().toISOString(), version: chrome.runtime.getManifest().version }));
}
async function paintPerm() {
  if (!root) { $("dir").textContent = "not connected"; return false; }
  const p = await root.queryPermission({ mode: "readwrite" });
  $("dir").textContent = root.name;
  $("perm").innerHTML = p === "granted" ? '<span class="ok">● read/write</span>' : '<span class="bad">● permission needed</span>';
  $("regrant").style.display = p === "granted" ? "none" : "inline-block";
  return p === "granted";
}

$("connect").onclick = async () => {
  try {
    root = await window.showDirectoryPicker({ id: "uc-live", mode: "readwrite" });
    await kvSet("dir", root);
    await ensureLayout();
    await paintPerm();
    log("connected folder: " + root.name, "ok");
  } catch (e) { log("connect cancelled: " + e.message, "bad"); }
};
$("regrant").onclick = async () => {
  if (!root) return;
  await root.requestPermission({ mode: "readwrite" });
  if (await paintPerm()) { await ensureLayout(); log("access re-granted", "ok"); }
};

/* ---------- capture stream (background broadcasts while liveBridge is on) ---------- */
const fname = (s) => (s || "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "UC_LIVE_NEW" || !running || !root) return;
  const p = msg.payload || {};
  const host = (() => { try { return new URL(p.url).hostname; } catch (e) { return "page"; } })();
  const name = Date.now() + "-" + (msg.meta && msg.meta.tabId != null ? "t" + msg.meta.tabId + "-" : "") + fname(host) + ".json";
  const lite = Object.assign({}, p);
  if (!msg.full) { delete lite.rawHtml; delete lite.cleanHtml; }   // full HTML only on capture_full
  lite._tabId = msg.meta ? msg.meta.tabId : null;
  writeText("captures", name, JSON.stringify(lite))
    .then(() => log("capture -> " + name + " (" + (p.counts ? p.counts.textChars : "?") + " chars, " + (p.selectorMap ? p.selectorMap.length : 0) + " selectors)"))
    .catch((e) => log("capture write failed: " + e.message, "bad"));
});

/* ---------- tab roster ---------- */
async function writeTabs() {
  if (!running || !root) return;
  const tabs = await chrome.tabs.query({});
  const roster = tabs.map((t) => ({ id: t.id, active: t.active, url: t.url, title: t.title, windowId: t.windowId }));
  await writeText("captures", "tabs.json", JSON.stringify({ at: new Date().toISOString(), tabs: roster })).catch(() => {});
}
["onCreated", "onRemoved", "onUpdated", "onActivated"].forEach((ev) =>
  chrome.tabs[ev].addListener(() => { clearTimeout(tabsTimer); tabsTimer = setTimeout(writeTabs, 800); })
);

/* ---------- the injected executor ---------- */
function pageExec(cmd) {
  const srOf = (n) => { try { return (chrome.dom && chrome.dom.openOrClosedShadowRoot) ? chrome.dom.openOrClosedShadowRoot(n) : n.shadowRoot; } catch (e) { return n.shadowRoot; } };
  const qDeep = (sel, node) => {
    try { const f = node.querySelector(sel); if (f) return f; } catch (e) { return null; }
    const kids = node.querySelectorAll("*");
    for (const k of kids) { const sr = srOf(k); if (sr) { const f2 = qDeep(sel, sr); if (f2) return f2; } }
    return null;
  };
  const q = (sel) => qDeep(sel, document);
  const el = cmd.selector ? q(cmd.selector) : null;
  const fire = (t, types) => types.forEach((x) => t.dispatchEvent(new Event(x, { bubbles: true })));
  const need = () => ({ ok: false, error: "selector not found: " + cmd.selector });
  const flash = (t) => { try { const o = t.style.outline; t.style.outline = "3px solid #f97316"; t.style.outlineOffset = "2px"; setTimeout(() => { t.style.outline = o; t.style.outlineOffset = ""; }, 900); } catch (e) {} };
  switch (cmd.action) {
    case "click": {
      if (!el) return need();
      flash(el); el.scrollIntoView({ block: "center" }); el.click();
      return { ok: true };
    }
    case "click_at": {
      const x = Number(cmd.x != null ? cmd.x : (cmd.value && cmd.value.x));
      const y = Number(cmd.y != null ? cmd.y : (cmd.value && cmd.value.y));
      if (!isFinite(x) || !isFinite(y)) return { ok: false, error: "click_at needs x,y" };
      let t = document.elementFromPoint(x, y);
      for (let i = 0; i < 8 && t; i++) {
        const sr = srOf(t);
        if (!sr || !sr.elementFromPoint) break;
        const inner = sr.elementFromPoint(x, y);
        if (!inner || inner === t) break;
        t = inner;
      }
      if (!t) return { ok: false, error: "nothing at " + x + "," + y };
      flash(t);
      const mev = (type) => t.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
      mev("pointerdown"); mev("mousedown"); mev("pointerup"); mev("mouseup"); mev("click");
      return { ok: true, tag: t.tagName, text: (t.textContent || "").trim().slice(0, 80) };
    }
    case "click_text": {
      const want = String(cmd.value || "").trim();
      if (!want) return { ok: false, error: "click_text needs value" };
      const all = [];
      (function walk(n) {
        const kids = n.querySelectorAll("*");
        for (const k of kids) { all.push(k); const sr = srOf(k); if (sr) walk(sr); }
      })(document);
      const vis = all.filter((c) => { try { const r = c.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (c.textContent || "").includes(want); } catch (e) { return false; } });
      if (!vis.length) return { ok: false, error: "no visible element containing: " + want };
      vis.sort((a, b2) => (a.textContent || "").length - (b2.textContent || "").length);
      let t = vis[0];
      const inner = t.querySelector && t.querySelector("a,button,[role=button],[role=option]");
      if (inner && (inner.textContent || "").includes(want)) t = inner;
      if (!(t.matches && t.matches("a,button,[role=button],[role=option],li,label")))
        t = t.closest("button,a,[role=button],[role=option],li,label") || t;
      flash(t);
      const r = t.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const mev = (type) => t.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window }));
      mev("pointerdown"); mev("mousedown"); mev("pointerup"); mev("mouseup"); mev("click");
      return { ok: true, tag: t.tagName, text: (t.textContent || "").trim().slice(0, 80) };
    }
    case "set_value": {
      if (!el) return need();
      flash(el);
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const d = Object.getOwnPropertyDescriptor(proto, "value");
      if (d && d.set) d.set.call(el, cmd.value); else el.value = cmd.value;
      fire(el, ["input", "change"]);
      return { ok: true, value: el.value };
    }
    case "select_option": {
      if (!el) return need();
      flash(el);
      el.value = cmd.value;
      if (el.value !== String(cmd.value)) { // try label match
        for (const o of el.options || []) if (o.label.trim() === String(cmd.value).trim()) { el.value = o.value; break; }
      }
      fire(el, ["input", "change"]);
      return { ok: true, value: el.value };
    }
    case "check": {
      if (!el) return need();
      flash(el);
      el.checked = cmd.value !== false;
      fire(el, ["click", "input", "change"]);
      return { ok: true, checked: el.checked };
    }
    case "key": {
      const t = el || document.activeElement || document.body;
      for (const type of ["keydown", "keypress", "keyup"])
        t.dispatchEvent(new KeyboardEvent(type, { key: cmd.value, bubbles: true }));
      return { ok: true };
    }
    case "scroll_to": {
      if (el) el.scrollIntoView({ block: "center" });
      else window.scrollTo(0, Number(cmd.value) || 0);
      return { ok: true };
    }
    case "attach_file": {
      if (!el) return need();
      const bin = atob(cmd.payloadB64 || "");
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const f = new File([u8], cmd.payloadName || "file.pdf", { type: cmd.payloadMime || "application/pdf" });
      const dt = new DataTransfer(); dt.items.add(f);
      flash(el);
      el.files = dt.files;
      fire(el, ["input", "change"]);
      return { ok: true, name: f.name, size: f.size };
    }
  }
  return { ok: false, error: "unknown action " + cmd.action };
}

/* ---------- command runner ---------- */
async function resolveTab(spec) {
  if (spec == null || spec === "active") {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return t && t.id;
  }
  if (typeof spec === "number") return spec;
  if (spec && spec.new) {
    const t = await chrome.tabs.create({ url: spec.new, active: !!spec.focus });
    await new Promise((res) => {
      const fn = (id, info) => { if (id === t.id && info.status === "complete") { chrome.tabs.onUpdated.removeListener(fn); res(); } };
      chrome.tabs.onUpdated.addListener(fn);
      setTimeout(res, 15000);
    });
    return t.id;
  }
  return null;
}
async function askCapture(tabId, full) {
  return new Promise((res) => {
    chrome.tabs.sendMessage(tabId, { type: "doCapture", trigger: full ? "bridge-full" : "bridge" }, (r) => {
      void chrome.runtime.lastError; res(r);
    });
  });
}
async function runCommand(cmd) {
  const dom = ["click", "click_at", "click_text", "set_value", "select_option", "check", "key", "scroll_to", "attach_file", "exec"];
  try {
    if (cmd.action === "reload_self") {
      await chrome.storage.local.set({ bridgeReopen: true, liveBridge: true });
      setTimeout(() => { window.__selfReload = true; chrome.runtime.reload(); }, 500);
      return { ok: true, note: "reloading extension; bridge reopens and restarts itself" };
    }
    if (cmd.action === "list_tabs") { await writeTabs(); return { ok: true, wrote: "captures/tabs.json" }; }
    const tabId = await resolveTab(cmd.tab);
    if (cmd.action === "new_tab") return { ok: true, tabId };
    if (!tabId) return { ok: false, error: "no target tab" };
    if (cmd.action === "close_tab") {
      if (typeof cmd.tab !== "number") return { ok: false, error: "close_tab requires an explicit numeric tab id (never active/null)" };
      await chrome.tabs.remove(tabId); return { ok: true };
    }
    if (cmd.action === "navigate") {
      await chrome.tabs.update(tabId, { url: cmd.value });
      await new Promise((res) => setTimeout(res, cmd.settleMs || 4000));
      await askCapture(tabId); return { ok: true, tabId };
    }
    if (cmd.action === "capture" || cmd.action === "capture_full") {
      window.__wantFull = cmd.action === "capture_full";
      const r = await askCapture(tabId, window.__wantFull);
      return { ok: !!(r && r.ok !== false), tabId, store: r };
    }
    if (cmd.action === "capture_all") {
      const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
      let n = 0;
      for (const t of tabs) { await askCapture(t.id); n++; await new Promise((r) => setTimeout(r, 400)); }
      return { ok: true, captured: n };
    }
    if (cmd.action === "reload_tab") {
      await chrome.tabs.reload(tabId);
      return { ok: true, tabId, note: "tab reloading" };
    }
    if (cmd.action === "exec") {
      const rs = await chrome.scripting.executeScript({
        target: { tabId, allFrames: cmd.frames !== "top" }, world: "MAIN", args: [cmd.value || ""],
        func: (code) => { try { return { ok: true, frameUrl: location.href.slice(0, 80), data: String(eval(code)).slice(0, 8000) }; } catch (e) { return { ok: false, frameUrl: location.href.slice(0, 80), error: e.message }; } }
      });
      const hits = (rs || []).map((r) => r && r.result).filter(Boolean);
      return { ok: hits.some((h) => h.ok), tabId, frames: hits };
    }
    if (dom.includes(cmd.action)) {
      if (cmd.action === "attach_file" && cmd.payloadFile && !cmd.payloadB64) {
        const pd = await subdir("payloads");
        const fh = await pd.getFileHandle(cmd.payloadFile);
        const file = await fh.getFile();
        const buf = new Uint8Array(await file.arrayBuffer());
        let bin = ""; const CH = 0x8000;
        for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
        cmd.payloadB64 = btoa(bin);
        cmd.payloadName = cmd.payloadName || cmd.payloadFile;
      }
      const rs = await chrome.scripting.executeScript({ target: { tabId, allFrames: cmd.frames !== "top" }, args: [cmd], func: pageExec });
      const hits = (rs || []).map((r) => r && r.result).filter(Boolean);
      const okr = hits.find((h) => h.ok);
      const out = Object.assign({ tabId, framesTried: hits.length }, okr || hits[0] || { ok: false, error: "no frame results" });
      if (out.ok && cmd.capture !== false) {
        await new Promise((res) => setTimeout(res, cmd.settleMs || 1200));
        await askCapture(tabId);
      }
      return out;
    }
    return { ok: false, error: "unknown action " + cmd.action };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
async function pollCommands() {
  if (!running || !root) return;
  const _now = Date.now();
  if (!window.__ucBeat || _now - window.__ucBeat > 5000) { window.__ucBeat = _now; chrome.storage.local.set({ bridgeBeat: _now }); }
  try {
    const cd = await subdir("commands");
    for await (const [name, handle] of cd.entries()) {
      if (handle.kind !== "file" || !name.endsWith(".json")) continue;
      let cmd = null;
      try { cmd = JSON.parse(await (await handle.getFile()).text()); }
      catch (e) { await cd.removeEntry(name).catch(() => {}); continue; }
      await cd.removeEntry(name).catch(() => {});
      log("cmd " + (cmd.id || name) + ": " + cmd.action + (cmd.selector ? " " + cmd.selector : ""));
      const result = await runCommand(cmd);
      await writeText("results", (cmd.id || name.replace(/\.json$/, "")) + ".json",
        JSON.stringify(Object.assign({ id: cmd.id || name, at: new Date().toISOString(), action: cmd.action }, result)));
      log("  -> " + (result.ok ? "ok" : "FAIL: " + result.error), result.ok ? "ok" : "bad");
    }
  } catch (e) { log("poll error: " + e.message, "bad"); }
}

/* ---------- run control ---------- */
async function setRunning(on) {
  running = on;
  $("state").textContent = on ? "LIVE" : "stopped";
  $("state").className = on ? "ok" : "bad";
  $("run").textContent = on ? "Stop bridge" : "Start bridge";
  $("run").className = on ? "on" : "";
  chrome.runtime.sendMessage({ type: "setSettings", patch: { liveBridge: on } }, () => void chrome.runtime.lastError);
  if (on) { try { const ct = await chrome.tabs.getCurrent(); if (ct) chrome.tabs.update(ct.id, { autoDiscardable: false }); } catch (e) {}
    chrome.storage.local.set({ bridgeBeat: Date.now() });
    await ensureLayout(); await writeTabs(); startClock(); log("bridge LIVE - unthrottled worker clock, watching commands/", "ok"); }
  else { stopClock(); log("bridge stopped"); }
}
async function gateOk() {
  return new Promise((res) => {
    chrome.runtime.sendMessage({ type: "paidStatus" }, (s) => { void chrome.runtime.lastError; res(s || { ok: true, reason: "dev" }); });
  });
}
$("run").onclick = async () => {
  if (!root || !(await paintPerm())) { log("connect the folder first", "bad"); return; }
  if (!running) {
    const g = await gateOk();
    if (!g.ok) {
      log(g.reason === "trial_expired" ? "trial ended — upgrade to keep the Live Bridge" : "Live Bridge is a paid feature — start a free trial or upgrade", "bad");
      const bar = document.getElementById("paywall"); if (bar) bar.style.display = "block";
      return;
    }
    if (g.reason === "trial") log("trial: " + g.daysLeft + " day(s) left", "ok");
  }
  setRunning(!running);
};
document.getElementById("btnTrial") && (document.getElementById("btnTrial").onclick = () => chrome.runtime.sendMessage({ type: "openTrial" }, () => void chrome.runtime.lastError));
document.getElementById("btnUpgrade") && (document.getElementById("btnUpgrade").onclick = () => chrome.runtime.sendMessage({ type: "openPayment" }, () => void chrome.runtime.lastError));
$("capAll").onclick = () => runCommand({ action: "capture_all" }).then((r) => log("capture_all: " + JSON.stringify(r)));
window.addEventListener("beforeunload", () => {
  if (window.__selfReload) return;
  chrome.runtime.sendMessage({ type: "setSettings", patch: { liveBridge: false } }, () => void chrome.runtime.lastError);
});

/* ---------- boot ---------- */
(async () => {
  root = await kvGet("dir").catch(() => null);
  if (root) {
    const granted = await paintPerm();
    log(granted ? "folder restored: " + root.name : "folder remembered - click Re-grant access", granted ? "ok" : "");
    const st = await chrome.storage.local.get(["bridgeReopen", "liveBridge"]);
    if (st.bridgeReopen) await chrome.storage.local.set({ bridgeReopen: false });
    if (granted && (st.bridgeReopen || st.liveBridge)) {
      setRunning(true);
      log("auto-started (post-reload/restart)", "ok");
    } else if (st.bridgeReopen && !granted) {
      log("click Re-grant access, then Start bridge", "bad");
    }
  }
})();
