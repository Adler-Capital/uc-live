const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const kb = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB");
const send = (m) => new Promise((r) => chrome.runtime.sendMessage(m, (x) => { void chrome.runtime.lastError; r(x); }));
const when = (ts) => new Date(ts).toLocaleString();

let ITEMS = [];
let SELECTED = new Set();
let OPEN = null;
let TAB = "text";

/* ---------------- list ---------------- */
async function load() {
  const [l, s] = await Promise.all([send({ type: "list" }), send({ type: "stats" })]);
  ITEMS = (l && l.items) || [];
  if (s && s.ok) {
    $("#hCount").textContent = s.stats.totalCount || 0;
    $("#hBytes").textContent = kb(s.stats.totalBytes || 0);
    $("#hRec").textContent = s.stats.recording
      ? "RECORDING - " + s.stats.sessionCount + " this session"
      : "idle";
  }
  const hosts = [...new Set(ITEMS.map((i) => i.host))].sort();
  $("#host").innerHTML = '<option value="">all sites</option>' + hosts.map((h) => `<option>${h}</option>`).join("");
  const sess = [...new Set(ITEMS.map((i) => i.session))].sort((a, b) => b - a);
  $("#sess").innerHTML =
    '<option value="">all sessions</option>' +
    sess.map((s2) => `<option value="${s2}">${s2 ? new Date(+s2).toLocaleString() : "manual"}</option>`).join("");
  render();
}

function filtered() {
  const q = $("#q").value.toLowerCase().trim();
  const h = $("#host").value;
  const s = $("#sess").value;
  return ITEMS.filter((i) => {
    if (h && i.host !== h) return false;
    if (s && String(i.session) !== s) return false;
    if (q && !((i.title || "") + " " + i.url + " " + i.host).toLowerCase().includes(q)) return false;
    return true;
  });
}

function render() {
  const rows = filtered();
  if (!rows.length) {
    $("#list").innerHTML = '<div class="empty">No captures match.</div>';
    return;
  }
  paintTokens();
  $("#list").innerHTML = rows
    .map((i) => {
      const c = i.counts || {};
      return `<div class="row ${SELECTED.has(i.id) ? "sel" : ""}" data-id="${i.id}">
      <input type="checkbox" data-ck="${i.id}" ${SELECTED.has(i.id) ? "checked" : ""} />
      <div style="flex:1;min-width:0">
        <div class="t">${esc(i.title || "(untitled)")}</div>
        <div class="u">${esc(i.url)}</div>
        <div class="m">${when(i.ts)} &middot; ${kb(i.bytes)} gz (${kb(i.rawBytes || 0)} raw) &middot; ${esc(i.trigger || "")}</div>
        <div class="m">
          <span class="tag">${c.textChars || 0} chars</span>
          <span class="tag">${c.links || 0} links</span>
          <span class="tag">${c.assets || 0} assets</span>
          <span class="tag">${c.forms || 0} fields</span>
          <span class="tag">${c.tables || 0} tables</span>
          <span class="tag">${c.repeats || 0} repeats</span>
        </div>
      </div></div>`;
    })
    .join("");

  $$("#list .row").forEach((r) => {
    r.onclick = (e) => {
      if (e.target.dataset.ck !== undefined) return;
      openDetail(+r.dataset.id);
    };
  });
  $$("#list input[data-ck]").forEach((c) => {
    c.onclick = (e) => {
      e.stopPropagation();
      const id = +c.dataset.ck;
      c.checked ? SELECTED.add(id) : SELECTED.delete(id);
      c.closest(".row").classList.toggle("sel", c.checked);
      paintTokens();
    };
  });
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// rough pre-flight cost so Dan knows before he sends, not after
function paintTokens() {
  const el = $("#tokenEst");
  if (!el) return;
  const rows = filtered();
  const sel = SELECTED.size ? rows.filter((r) => SELECTED.has(r.id)) : rows;
  if (!sel.length) { el.textContent = ""; return; }
  // build the estimate from the per-layer counts we already hold, not from total bytes,
  // so unticking a layer moves the number honestly
  const on = layers();
  let chars = 0;
  for (const r of sel) {
    const c = r.counts || {};
    if (on.includes("text")) chars += c.textChars || 0;
    if (on.includes("links")) chars += (c.links || 0) * 90;
    if (on.includes("assets")) chars += (c.assets || 0) * 110;
    if (on.includes("forms")) chars += (c.forms || 0) * 130;
    if (on.includes("tables")) chars += (c.tables || 0) * 2000;
    if (on.includes("repeats")) chars += (c.repeats || 0) * 2600;
    if (on.includes("cleanHtml")) chars += c.cleanChars || 0;
    if (on.includes("rawHtml")) chars += c.rawChars || 0;
  }
  const rawTok = estTokens(chars);
  const warn = rawTok > 150000 ? "#b42318" : rawTok > 60000 ? "#92400e" : "#166534";
  el.innerHTML =
    `${sel.length} selected &middot; raw ~<b style="color:${warn}">${fmtTok(rawTok)}</b> tokens` +
    ` &middot; <span style="color:#166534">Prep cuts this roughly 5-15x</span>`;
}

/* ---------------- detail ---------------- */
const TABS = ["text", "links", "assets", "structured", "forms", "tables", "repeats", "cleanHtml", "rawHtml"];

async function openDetail(id) {
  const r = await send({ type: "get", ids: [id] });
  if (!r || !r.records || !r.records.length) return;
  OPEN = r.records[0];
  paintDetail();
}

function paintDetail() {
  if (!OPEN) return;
  const p = OPEN.payload;
  const tabs = TABS.map((t) => `<span class="${t === TAB ? "on" : ""}" data-tab="${t}">${t}</span>`).join("");
  $("#detail").innerHTML =
    `<div style="margin-bottom:8px"><b>${esc(p.title)}</b><br><span style="color:#6b7280;font-size:11px">${esc(p.url)}</span></div>` +
    `<div class="tabs">${tabs}</div><pre>${esc(bodyFor(p, TAB))}</pre>`;
  $$("#detail .tabs span").forEach((s) => (s.onclick = () => { TAB = s.dataset.tab; paintDetail(); }));
}

function bodyFor(p, t) {
  const v = p[t];
  if (v == null || (typeof v === "string" && !v)) return "(empty)";
  if (typeof v === "string") return v.slice(0, 400000);
  return JSON.stringify(v, null, 2).slice(0, 400000);
}

/* ---------------- export ---------------- */
function layers() {
  return $$(".lyr").filter((c) => c.checked).map((c) => c.value);
}
function targetIds() {
  const rows = filtered();
  const ids = SELECTED.size ? rows.filter((r) => SELECTED.has(r.id)).map((r) => r.id) : rows.map((r) => r.id);
  if (!ids.length) { alert("Nothing to export."); return null; }
  return ids;
}

// Pulling every selected capture through ONE runtime message dies silently once the
// decompressed payload gets large (Select All + raw HTML = 100MB+). Stream it in small
// batches instead and build the file incrementally.
const CHUNK = 4;
async function eachRecord(ids, onRecord, label) {
  const status = $("#exportStatus");
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    if (status) status.textContent = (label || "Exporting") + " " + Math.min(i + CHUNK, ids.length) + " / " + ids.length + "...";
    const r = await send({ type: "get", ids: slice });
    for (const rec of (r && r.records) || []) onRecord(rec);
    await new Promise((res) => setTimeout(res, 0)); // let the UI breathe
  }
  if (status) status.textContent = "";
}

function dl(name, parts, mime) {
  // parts may be a string OR an array of strings - an array avoids ever holding one
  // giant concatenated string in memory
  const blob = new Blob(Array.isArray(parts) ? parts : [parts], { type: (mime || "text/plain") + ";charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");

function mdFor(rec, L) {
  const p = rec.payload;
  const out = [];
  out.push(`\n\n---\n\n## ${p.title || "(untitled)"}\n`);
  out.push(`- **URL:** ${p.url}`);
  out.push(`- **Captured:** ${p.capturedAt} (${p.trigger})`);
  const c = p.counts || {};
  out.push(`- **Counts:** ${c.textChars || 0} chars, ${c.links || 0} links, ${c.assets || 0} assets, ${c.forms || 0} fields, ${c.tables || 0} tables, ${c.repeats || 0} repeat-blocks\n`);

  if (L.includes("text") && p.text) out.push(`### Visible text\n\n\`\`\`\n${p.text}\n\`\`\`\n`);

  if (L.includes("repeats") && p.repeats && p.repeats.length) {
    out.push(`### Repeating structures (use these to build a scraper)\n`);
    p.repeats.forEach((r, i) => {
      out.push(`**Block ${i + 1}** - \`${r.itemSignature}\` x${r.count}\n`);
      out.push(`- container: \`${r.containerSelector}\``);
      if (r.stableAttrs && r.stableAttrs.length)
        out.push(`- **stable selectors:** ${r.stableAttrs.map((a) => "`[" + a + "]`").join(", ")}`);
      out.push(`- sample text: ${JSON.stringify(r.sampleText)}\n`);
      out.push(`\`\`\`html\n${r.sampleHtml}\n\`\`\`\n`);
    });
  }
  if (L.includes("links") && p.links && p.links.length) {
    out.push(`### Links (${p.links.length})\n`);
    out.push("| text | href |\n| --- | --- |");
    p.links.forEach((l) => out.push(`| ${(l.text || "").replace(/\|/g, "/")} | ${l.href} |`));
    out.push("");
  }
  if (L.includes("assets") && p.assets && p.assets.length) {
    out.push(`### Downloadable assets / media (${p.assets.length})\n`);
    p.assets.forEach((a) => out.push(`- [${a.kind}] ${a.label ? a.label + " - " : ""}${a.url}`));
    out.push("");
  }
  if (L.includes("structured") && p.structured) {
    const s = p.structured;
    if (s.jsonld && s.jsonld.length) out.push(`### JSON-LD\n\n\`\`\`json\n${JSON.stringify(s.jsonld, null, 2)}\n\`\`\`\n`);
    if (s.meta && Object.keys(s.meta).length) out.push(`### Meta tags\n\n\`\`\`json\n${JSON.stringify(s.meta, null, 2)}\n\`\`\`\n`);
    if (s.inlineState && s.inlineState.length) out.push(`### Inline app state\n\n\`\`\`\n${s.inlineState.join("\n\n/* --- */\n\n").slice(0, 200000)}\n\`\`\`\n`);
  }
  if (L.includes("forms") && p.forms && p.forms.length) {
    out.push(`### Form fields (${p.forms.length})\n`);
    out.push("| tag | type | name | id | label/placeholder | selector |\n| --- | --- | --- | --- | --- | --- |");
    p.forms.forEach((f) =>
      out.push(`| ${f.tag} | ${f.type} | ${f.name} | ${f.id} | ${(f.label || f.placeholder || "").replace(/\|/g, "/")} | \`${f.selector}\` |`)
    );
    out.push("");
  }
  if (L.includes("tables") && p.tables && p.tables.length) {
    out.push(`### Tables (${p.tables.length})\n`);
    p.tables.forEach((t, i) => {
      out.push(`**Table ${i + 1}** \`${t.selector}\`\n`);
      t.rows.forEach((r, ri) => {
        out.push("| " + r.map((c) => String(c).replace(/\|/g, "/")).join(" | ") + " |");
        if (ri === 0) out.push("| " + r.map(() => "---").join(" | ") + " |");
      });
      out.push("");
    });
  }
  if (L.includes("cleanHtml") && p.cleanHtml) out.push(`### Clean HTML\n\n\`\`\`html\n${p.cleanHtml}\n\`\`\`\n`);
  if (L.includes("rawHtml") && p.rawHtml) out.push(`### Raw HTML\n\n\`\`\`html\n${p.rawHtml}\n\`\`\`\n`);
  return out.join("\n");
}

/* ---------------- Prep for Claude ----------------
   The builder itself lives in prep.js so background.js can produce the identical
   file for the folder bridge. vault.js only supplies the record reader. */
async function prepForClaude(ids, L) {
  return buildPrep(ids, L, eachRecord);
}

function csvEsc(v) {
  v = String(v == null ? "" : v).replace(/"/g, '""');
  return /[",\n]/.test(v) ? `"${v}"` : v;
}

/* Any throw inside an export used to reject its promise silently, leaving the
   status stuck on "Preparing 4 / 14..." with no clue why. Every export button now
   runs through this: the real error is shown in the status line AND logged. */
function guard(label, fn) {
  return async () => {
    const st = $("#exportStatus");
    try {
      await fn();
    } catch (e) {
      const msg = (e && e.message) || String(e);
      console.error("[capture] " + label + " failed:", e);
      if (st) st.innerHTML = `<b style="color:#b42318">${label} failed: ${esc(msg)}</b> - reload the extension at chrome://extensions and try again`;
      else alert(label + " failed: " + msg);
    }
  };
}

document.addEventListener("DOMContentLoaded", () => {
  load();

  $("#q").oninput = () => { render(); paintTokens(); };
  $("#host").onchange = () => { render(); paintTokens(); };
  $("#sess").onchange = () => { render(); paintTokens(); };
  $("#all").onclick = () => { filtered().forEach((i) => SELECTED.add(i.id)); render(); paintTokens(); };
  $("#none").onclick = () => { SELECTED.clear(); render(); paintTokens(); };
  $$(".lyr").forEach((c) => (c.onchange = paintTokens));

  $("#del").onclick = async () => {
    if (!SELECTED.size) return alert("Select captures first.");
    if (!confirm("Delete " + SELECTED.size + " capture(s)?")) return;
    await send({ type: "delete", ids: [...SELECTED] });
    SELECTED.clear();
    OPEN = null;
    $("#detail").innerHTML = '<div class="empty">Select a capture to inspect it.</div>';
    load();
  };
  $("#wipe").onclick = async () => {
    if (!confirm("Wipe the ENTIRE vault? This cannot be undone.")) return;
    await send({ type: "clear" });
    SELECTED.clear();
    OPEN = null;
    load();
  };

  $("#prep").onclick = guard("Prep for Claude", async () => {
    const ids = targetIds(); if (!ids) return;
    const L = layers();
    const parts = await prepForClaude(ids, L);
    const chars = parts.reduce((a, p) => a + p.length, 0);
    dl(`capture-for-claude-${stamp()}.md`, parts, "text/markdown");
    const st = $("#exportStatus");
    if (st) st.textContent = `Prepared: ~${fmtTok(estTokens(chars))} tokens (${(chars / 1024).toFixed(0)} KB)`;
  });

  $("#md").onclick = guard(".md raw export", async () => {
    const ids = targetIds(); if (!ids) return;
    const L = layers();
    const index = [];
    const body = [];
    let n = 0;
    await eachRecord(ids, (r) => {
      index.push(`${++n}. ${r.payload.title || "(untitled)"} - ${r.payload.url}`);
      body.push(mdFor(r, L));
    });
    const head =
      `# Adler Universal Capture export\n\n` +
      `- Captures: ${n}\n- Exported: ${new Date().toISOString()}\n- Layers: ${L.join(", ")}\n\n` +
      `## Index\n\n` + index.join("\n");
    dl(`capture-${stamp()}.md`, [head].concat(body), "text/markdown");
  });

  $("#json").onclick = guard(".json export", async () => {
    const ids = targetIds(); if (!ids) return;
    const L = layers();
    const parts = ["[\n"];
    let first = true;
    await eachRecord(ids, (r) => {
      const o = { url: r.payload.url, title: r.payload.title, capturedAt: r.payload.capturedAt, trigger: r.payload.trigger, counts: r.payload.counts };
      L.forEach((k) => (o[k] = r.payload[k]));
      parts.push((first ? "" : ",\n") + JSON.stringify(o, null, 2));
      first = false;
    });
    parts.push("\n]\n");
    dl(`capture-${stamp()}.json`, parts, "application/json");
  });

  $("#txt").onclick = guard(".txt export", async () => {
    const ids = targetIds(); if (!ids) return;
    const parts = [];
    await eachRecord(ids, (r) => {
      parts.push(`===== ${r.payload.title}\n${r.payload.url}\n${r.payload.capturedAt}\n\n${r.payload.text || ""}\n\n\n`);
    });
    dl(`capture-${stamp()}.txt`, parts, "text/plain");
  });

  $("#csv").onclick = guard(".csv export", async () => {
    const ids = targetIds(); if (!ids) return;
    const lines = ["page_url,page_title,kind,text,href"];
    const seen = new Set(); // nav chrome repeats on every capture - emit each row once
    const add = (url, title, kind, text, href) => {
      const k = kind + "|" + text + "|" + href;
      if (seen.has(k)) return;
      seen.add(k);
      lines.push([url, title, kind, text, href].map(csvEsc).join(","));
    };
    await eachRecord(ids, (r) => {
      (r.payload.links || []).forEach((l) => add(r.payload.url, r.payload.title, "link", l.text, l.href));
      (r.payload.assets || []).forEach((a) => add(r.payload.url, r.payload.title, "asset:" + a.kind, a.label, a.url));
      (r.payload.tables || []).forEach((t, ti) =>
        t.rows.forEach((row) => add(r.payload.url, r.payload.title, "table" + (ti + 1), row.join(" | "), ""))
      );
    });
    dl(`capture-${stamp()}.csv`, ["﻿" + lines.join("\n")], "text/csv");
  });

  setInterval(async () => {
    const s = await send({ type: "stats" });
    if (s && s.ok) {
      $("#hCount").textContent = s.stats.totalCount || 0;
      $("#hBytes").textContent = kb(s.stats.totalBytes || 0);
      $("#hRec").textContent = s.stats.recording ? "RECORDING - " + s.stats.sessionCount + " this session" : "idle";
    }
  }, 2500);
});
