// Adler Universal Capture - background service worker
// Storage: IndexedDB + gzip. Everything stays local. No network calls, ever.

try { importScripts("ExtPay.js"); } catch(e) {}
importScripts("prep.js");
importScripts("payments.js"); // shared "Prep for Claude" builder, also used by vault.js

const DB_NAME = "adlerCapture";
const STORE = "caps";
const DB_VER = 1;

const DEFAULTS = {
  recording: false,
  sessionId: 0,
  sessionCount: 0,
  sessionBytes: 0,
  totalCount: 0,
  totalBytes: 0,
  // capture triggers
  onLoad: true,
  onNav: true,
  onClick: true,
  onMutation: true,
  // layers
  keepRawHtml: true,
  keepCleanHtml: true,
  screenshots: false,
  // safety
  maxSessionCaptures: 400,
  maxTotalMB: 500,
  minGapMs: 1200,
  denylist: [],
  hudHidden: false,
  // folder bridge - when a recording session stops, write the prepped .md into
  // Downloads/<exportFolder> so Claude can read it from a connected folder
  autoExport: true,
  exportFolder: "adler-captures",
  exportLayers: ["text", "links", "assets", "structured", "forms", "tables", "repeats"],
  lastExport: "",
  lastExportAt: 0
};

/* ---------------- settings ---------------- */
async function S() {
  const v = await chrome.storage.local.get(null);
  return Object.assign({}, DEFAULTS, v);
}
async function setS(patch) {
  await chrome.storage.local.set(patch);
  return S();
}

/* ---------------- gzip ---------------- */
async function gzip(str) {
  const stream = new Blob([str]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzip(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

/* ---------------- indexeddb ---------------- */
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains(STORE)) {
        const s = d.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        s.createIndex("ts", "ts");
        s.createIndex("host", "host");
        s.createIndex("session", "session");
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function tx(store, mode, fn) {
  return openDB().then(
    (d) =>
      new Promise((res, rej) => {
        const t = d.transaction(store, mode);
        const s = t.objectStore(store);
        let out;
        try {
          out = fn(s);
        } catch (e) {
          rej(e);
          return;
        }
        t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error);
      })
  );
}
const idbAdd = (rec) => tx(STORE, "readwrite", (s) => s.add(rec));
const idbGet = (id) => tx(STORE, "readonly", (s) => s.get(id));
const idbDel = (id) => tx(STORE, "readwrite", (s) => s.delete(id));
const idbAll = () => tx(STORE, "readonly", (s) => s.getAll());
const idbClear = () => tx(STORE, "readwrite", (s) => s.clear());

/* ---------------- badge ---------------- */
async function paintBadge() {
  const s = await S();
  if (s.recording) {
    await chrome.action.setBadgeBackgroundColor({ color: "#1a7f37" });
    await chrome.action.setBadgeText({ text: String(s.sessionCount || 0) });
  } else {
    await chrome.action.setBadgeBackgroundColor({ color: "#6b7280" });
    await chrome.action.setBadgeText({ text: s.totalCount ? String(s.totalCount) : "" });
  }
}

/* ---------------- dedupe ---------------- */
async function seenHash(key) {
  const { _hashes = [] } = await chrome.storage.local.get("_hashes");
  return _hashes.includes(key);
}
async function rememberHash(key) {
  const { _hashes = [] } = await chrome.storage.local.get("_hashes");
  _hashes.push(key);
  while (_hashes.length > 3000) _hashes.shift();
  await chrome.storage.local.set({ _hashes });
}

/* ---------------- store a capture ---------------- */
async function storeCapture(payload, auto) {
  const s = await S();

  const host = (() => {
    try {
      return new URL(payload.url).hostname;
    } catch (e) {
      return "";
    }
  })();

  if (s.denylist.some((d) => d && host.includes(d)))
    return { ok: false, reason: "denylisted", host };

  const key = host + "|" + payload.textHash;
  if (await seenHash(key)) return { ok: false, reason: "duplicate" };

  if (auto && s.recording && s.sessionCount >= s.maxSessionCaptures) {
    await setS({ recording: false });
    await paintBadge();
    return { ok: false, reason: "session cap reached - recording stopped" };
  }
  if (s.totalBytes / 1048576 >= s.maxTotalMB)
    return { ok: false, reason: "total storage cap reached" };

  if (!s.keepRawHtml) delete payload.rawHtml;
  if (!s.keepCleanHtml) delete payload.cleanHtml;

  const json = JSON.stringify(payload);
  const gz = await gzip(json);

  const rec = {
    ts: Date.now(),
    // a capture belongs to a session ONLY while recording; idle Shift+S captures
    // are "manual" (session 0) so they never ride along in a session's auto-export
    session: s.recording ? (s.sessionId || 0) : 0,
    url: payload.url,
    host,
    title: payload.title || "",
    trigger: payload.trigger || (auto ? "auto" : "manual"),
    rawBytes: json.length,
    bytes: gz.byteLength,
    textHash: payload.textHash,
    counts: payload.counts || {},
    gz
  };

  // Supersede: this capture is a fuller render of one we just stored, so REPLACE it
  // rather than leaving a half-painted twin behind. Lets us capture fast and still
  // end up with only the complete state.
  let replaced = false;
  let freed = 0;
  if (payload.replaceId) {
    const old = await idbGet(payload.replaceId);
    if (old) {
      freed = old.bytes || 0;
      await idbDel(payload.replaceId);
      replaced = true;
    }
  }

  const id = await idbAdd(rec);
  await rememberHash(key);

  const patch = {
    totalCount: (s.totalCount || 0) + (replaced ? 0 : 1),
    totalBytes: Math.max(0, (s.totalBytes || 0) - freed + gz.byteLength)
  };
  if (s.recording) {
    patch.sessionCount = (s.sessionCount || 0) + (replaced ? 0 : 1);
    patch.sessionBytes = Math.max(0, (s.sessionBytes || 0) - freed + gz.byteLength);
  }
  await setS(patch);
  await paintBadge();

  if (s.liveBridge) {
    try {
      chrome.runtime.sendMessage(
        { type: "UC_LIVE_NEW", payload, full: /bridge-full/.test(payload.trigger || ""), meta: { id, ts: rec.ts, tabId: payload._tabId != null ? payload._tabId : null } },
        () => void chrome.runtime.lastError
      );
    } catch (e) {}
  }

  const ns = await S();
  return {
    ok: true,
    id,
    bytes: gz.byteLength,
    rawBytes: json.length,
    stats: pickStats(ns)
  };
}

function pickStats(s) {
  return {
    recording: s.recording,
    sessionCount: s.sessionCount,
    sessionBytes: s.sessionBytes,
    totalCount: s.totalCount,
    totalBytes: s.totalBytes
  };
}

/* ---------------- folder bridge ----------------
   A service worker has no URL.createObjectURL and no FileReader, so the file is
   handed to chrome.downloads as a base64 data: URL. Chrome puts it in the user's
   Downloads folder under exportFolder/, which Dan connects to Claude once. */

function toDataUrl(text, mime) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  const CH = 0x8000; // chunked - String.fromCharCode blows the stack on big arrays
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return "data:" + (mime || "text/markdown") + ";base64," + btoa(bin);
}

function saveToFolder(folder, name, text) {
  return new Promise((res) => {
    try {
      chrome.downloads.download(
        {
          url: toDataUrl(text, "text/markdown"),
          filename: (folder || "adler-captures") + "/" + name,
          conflictAction: "uniquify",
          saveAs: false
        },
        (id) => {
          const err = chrome.runtime.lastError;
          res(err ? { ok: false, reason: err.message } : { ok: true, downloadId: id });
        }
      );
    } catch (e) {
      res({ ok: false, reason: String(e && e.message ? e.message : e) });
    }
  });
}

// Record reader for prep.js - reads IndexedDB directly, a few at a time, so a
// 400-capture session never sits fully decompressed in memory.
async function eachFromDb(ids, onRecord) {
  for (let i = 0; i < ids.length; i += 4) {
    for (const id of ids.slice(i, i + 4)) {
      const r = await idbGet(id);
      if (!r) continue;
      const payload = JSON.parse(await gunzip(r.gz));
      onRecord({ meta: { id: r.id, ts: r.ts, bytes: r.bytes, trigger: r.trigger }, payload });
    }
    await new Promise((res) => setTimeout(res, 0));
  }
}

const fileStamp = (ts) => new Date(ts).toISOString().slice(0, 16).replace(/[:T]/g, "-");

/* Export a set of captures as a prepped .md into the bridge folder.
   sessionId === null means "everything currently in the vault". */
async function exportToFolder(sessionId, reason) {
  const s = await S();
  const all = await idbAll();
  const rows = (sessionId == null ? all : all.filter((r) => r.session === sessionId)).sort((a, b) => a.ts - b.ts);
  if (!rows.length) return { ok: false, reason: "no captures to export" };

  const hosts = [...new Set(rows.map((r) => r.host).filter(Boolean))];
  const label = hosts.length === 1 ? hosts[0].replace(/^www\./, "").replace(/[^a-z0-9.-]/gi, "") : hosts.length + "-sites";
  const note =
    "Source: " + (sessionId == null ? "full vault" : "recording session " + new Date(sessionId).toLocaleString()) +
    " - " + rows.length + " captures from " + hosts.join(", ");

  let text;
  try {
    const parts = await buildPrep(rows.map((r) => r.id), s.exportLayers || DEFAULTS.exportLayers, eachFromDb, note);
    text = parts.join("");
  } catch (e) {
    // never let a prep bug swallow the session silently - report it to the HUD
    return { ok: false, reason: "prep failed: " + (e && e.message ? e.message : e), captures: rows.length };
  }
  const name = "capture-" + fileStamp(rows[rows.length - 1].ts) + "-" + label + ".md";

  const r = await saveToFolder(s.exportFolder, name, text);
  if (r.ok) await setS({ lastExport: name, lastExportAt: Date.now() });
  return Object.assign({ file: name, captures: rows.length, chars: text.length, reason }, r);
}

/* ---------------- recording on/off (one code path) ---------------- */
async function setRecording(on) {
  const s = await S();
  const wasSession = s.sessionId;
  const wasCount = s.sessionCount;
  const patch = { recording: on };
  if (on) {
    patch.sessionId = Date.now();
    patch.sessionCount = 0;
    patch.sessionBytes = 0;
  }
  const ns = await setS(patch);
  await paintBadge();
  await broadcast({ type: "recordingChanged", stats: pickStats(ns), settings: ns });

  let exported = null;
  if (!on && s.recording && wasCount > 0 && ns.autoExport) {
    exported = await exportToFolder(wasSession, "session stopped");
    await broadcast({ type: "exported", exported });
  }
  return { stats: pickStats(ns), exported };
}

/* ---------------- messaging ---------------- */
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    try {
      switch (msg.type) {
        case "capture": {
          try { if (sender && sender.tab) msg.payload._tabId = sender.tab.id; } catch (e) {}
          const r = await storeCapture(msg.payload, !!msg.auto);
          reply(r);
          break;
        }
        case "stats": {
          const s = await S();
          reply({ ok: true, stats: pickStats(s), settings: s });
          break;
        }
        case "settings": {
          reply({ ok: true, settings: await S() });
          break;
        }
        case "setSettings": {
          const s = await setS(msg.patch || {});
          await paintBadge();
          await broadcast({ type: "settingsChanged", settings: s });
          reply({ ok: true, settings: s });
          break;
        }
        case "toggleRecording": {
          const s = await S();
          const on = msg.on === undefined ? !s.recording : !!msg.on;
          const r = await setRecording(on);
          reply({ ok: true, stats: r.stats, exported: r.exported });
          break;
        }
        case "exportToFolder": {
          reply(await exportToFolder(msg.sessionId === undefined ? null : msg.sessionId, "manual"));
          break;
        }
        case "list": {
          const all = await idbAll();
          all.sort((a, b) => b.ts - a.ts);
          reply({
            ok: true,
            items: all.map((r) => ({
              id: r.id,
              ts: r.ts,
              session: r.session,
              url: r.url,
              host: r.host,
              title: r.title,
              trigger: r.trigger,
              bytes: r.bytes,
              rawBytes: r.rawBytes,
              counts: r.counts || {}
            }))
          });
          break;
        }
        case "get": {
          const out = [];
          for (const id of msg.ids || []) {
            const r = await idbGet(id);
            if (!r) continue;
            const payload = JSON.parse(await gunzip(r.gz));
            out.push({ meta: { id: r.id, ts: r.ts, bytes: r.bytes, trigger: r.trigger }, payload });
          }
          reply({ ok: true, records: out });
          break;
        }
        case "delete": {
          let freed = 0;
          for (const id of msg.ids || []) {
            const r = await idbGet(id);
            if (r) freed += r.bytes;
            await idbDel(id);
          }
          const s = await S();
          await setS({
            totalCount: Math.max(0, (s.totalCount || 0) - (msg.ids || []).length),
            totalBytes: Math.max(0, (s.totalBytes || 0) - freed)
          });
          await paintBadge();
          reply({ ok: true });
          break;
        }
        case "clear": {
          await idbClear();
          await setS({ totalCount: 0, totalBytes: 0, sessionCount: 0, sessionBytes: 0, _hashes: [] });
          await chrome.storage.local.set({ _hashes: [] });
          await paintBadge();
          reply({ ok: true });
          break;
        }
        case "paidStatus": {
          (self.ucPaidStatus ? self.ucPaidStatus() : Promise.resolve({ ok: true, reason: "dev" }))
            .then((s) => reply(Object.assign({ ok: true }, s)));
          return true;
        }
        case "openPayment": { if (self.ucOpenPayment) self.ucOpenPayment(); reply({ ok: true }); return; }
        case "openTrial": { if (self.ucOpenTrial) self.ucOpenTrial(); reply({ ok: true }); return; }
        case "openBridge": {
          chrome.tabs.create({ url: chrome.runtime.getURL("bridge.html"), pinned: true });
          reply({ ok: true });
          return;
        }
        case "openVault": {
          chrome.tabs.create({ url: chrome.runtime.getURL("vault.html") });
          reply({ ok: true });
          break;
        }
        case "captureActiveTab": {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab) { reply({ ok: false, reason: "no active tab" }); break; }
          const ready = await ensureContentScript(tab.id, tab.url);
          if (!ready.ok) { reply(ready); break; }
          const r = await askTab(tab.id, { type: "doCapture", trigger: "manual" });
          reply(r || { ok: false, reason: "the page stopped responding mid-capture" });
          break;
        }
        case "pageStatus": {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab) { reply({ ok: true, state: "none", label: "no active tab" }); break; }
          if (!INJECTABLE(tab.url)) { reply({ ok: true, state: "blocked", label: "Chrome blocks this page type" }); break; }
          const ping = await askTab(tab.id, { type: "ping" });
          reply(ping && ping.ok
            ? { ok: true, state: "ready", label: "this page is ready" }
            : { ok: true, state: "cold", label: "arming this page..." });
          if (!(ping && ping.ok)) ensureContentScript(tab.id, tab.url);
          break;
        }
        case "injectAll": {
          reply({ ok: true, injected: await injectAll() });
          break;
        }
        default:
          reply({ ok: false, reason: "unknown message" });
      }
    } catch (e) {
      reply({ ok: false, reason: String(e && e.message ? e.message : e) });
    }
  })();
  return true;
});

/* ---------------- content-script plumbing ----------------
   Chrome only auto-injects content scripts into pages loaded AFTER install.
   Everything below makes already-open tabs work without a manual reload. */
const INJECTABLE = (url) => /^https?:\/\//i.test(url || "") || /^file:\/\//i.test(url || "");

async function ensureContentScript(tabId, url) {
  if (!INJECTABLE(url))
    return { ok: false, reason: "Chrome blocks extensions on this page (chrome:// pages, the Web Store, and the PDF viewer)" };
  const ping = await askTab(tabId, { type: "ping" });
  if (ping && ping.ok) return { ok: true };
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const p = await askTab(tabId, { type: "ping" });
      if (p && p.ok) return { ok: true, injected: true };
    }
    return { ok: false, reason: "Injected but the page did not respond - try reloading the tab" };
  } catch (e) {
    return { ok: false, reason: "Could not reach this page (" + (e.message || e) + ") - try reloading the tab" };
  }
}

async function injectAll() {
  const tabs = await chrome.tabs.query({});
  let n = 0;
  for (const t of tabs) {
    if (!INJECTABLE(t.url)) continue;
    try {
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["content.js"] });
      n++;
    } catch (e) {}
  }
  return n;
}

function askTab(tabId, msg) {
  return new Promise((res) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, (r) => {
        void chrome.runtime.lastError;
        res(r);
      });
    } catch (e) {
      res(null);
    }
  });
}
async function broadcast(msg) {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) askTab(t.id, msg);
}

/* ---------------- keyboard commands ---------------- */
chrome.commands.onCommand.addListener(async (cmd) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (cmd === "capture_now" && tab) {
    const ready = await ensureContentScript(tab.id, tab.url);
    if (ready.ok) await askTab(tab.id, { type: "doCapture", trigger: "hotkey" });
  }
  if (cmd === "toggle_recording") {
    const s = await S();
    await setRecording(!s.recording);
  }
});

/* ---------------- SPA navigation trigger ---------------- */
chrome.webNavigation.onHistoryStateUpdated.addListener(async (d) => {
  if (d.frameId !== 0) return;
  const s = await S();
  if (!s.recording || !s.onNav) return;
  const ready = await ensureContentScript(d.tabId, d.url);
  if (ready.ok) askTab(d.tabId, { type: "doCapture", trigger: "spa-nav", auto: true });
});

// while recording, make sure every page that finishes loading is armed
chrome.webNavigation.onCompleted.addListener(async (d) => {
  if (d.frameId !== 0) return;
  const s = await S();
  if (!s.recording) return;
  ensureContentScript(d.tabId, d.url);
});

chrome.runtime.onInstalled.addListener(() => { paintBadge(); injectAll(); });
chrome.runtime.onStartup.addListener(() => { paintBadge(); injectAll(); });


/* ---------------- v1.13: bridge auto-reopen ---------------- */
async function maybeReopenBridge() {
  try {
    const st = await chrome.storage.local.get(["bridgeReopen", "liveBridge"]);
    if (!st.bridgeReopen && !st.liveBridge) return;
    const url = chrome.runtime.getURL("bridge.html");
    const tabs = await chrome.tabs.query({ url });
    if (!tabs.length) await chrome.tabs.create({ url, pinned: true, active: false });
  } catch (e) {}
}
chrome.runtime.onInstalled.addListener(() => maybeReopenBridge());
chrome.runtime.onStartup.addListener(() => maybeReopenBridge());


/* ---------------- v1.16: stall watchdog ----------------
   Chrome freezes hidden/pinned tab renderers (the "unthrottled" worker freezes with them).
   Alarms run in the service worker, which is never frozen: if the bridge stops writing its
   heartbeat while liveBridge is on, reload the bridge tab to thaw + auto-restart it. */
chrome.alarms.create("ucBridgeWatch", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== "ucBridgeWatch") return;
  try {
    const st = await chrome.storage.local.get(["liveBridge", "bridgeBeat"]);
    if (!st.liveBridge) return;
    if (Date.now() - (st.bridgeBeat || 0) < 75000) return;
    const url = chrome.runtime.getURL("bridge.html");
    const tabs = await chrome.tabs.query({ url });
    await chrome.storage.local.set({ bridgeReopen: true });
    if (!tabs.length) { await chrome.tabs.create({ url, pinned: true, active: false }); return; }
    await chrome.tabs.reload(tabs[0].id);
  } catch (e) {}
});
