// Adler Universal Capture - content script (capture engine + HUD)
(function () {
  const HUD_ID = "adler-auc-hud";
  const VERSION = (() => { try { return chrome.runtime.getManifest().version; } catch (e) { return "?"; } })();

  // Reloading an unpacked extension leaves the OLD content script running in already-open
  // tabs with a dead chrome context. A plain boolean guard would make the new script bail
  // and leave that zombie HUD on screen showing stale numbers. Version-compare instead:
  // same version = already running, older version = tear its HUD out and take over.
  if (window.__adlerUCVersion === VERSION) return;
  if (window.__adlerUCVersion) {
    const zombie = document.getElementById(HUD_ID);
    if (zombie) zombie.remove();
  }
  window.__adlerUCVersion = VERSION;
  const KEEP_ATTRS = new Set([
    "id", "class", "href", "src", "alt", "title", "name", "type", "value",
    "placeholder", "role", "download", "target", "rel", "for", "action",
    "method", "colspan", "rowspan", "label", "content", "property", "selected", "checked"
  ]);
  const ASSET_RE = /\.(pdf|docx?|xlsx?|csv|txt|zip|rar|pptx?|jpe?g|png|gif|webp|svg|mp4|mp3|json|xml)(\?|#|$)/i;

  const MIN_AUTO_CHARS = 300; // below this an auto-capture is a loading skeleton, not a page

  let settings = {};
  let stats = {};
  let lastCaptureAt = 0;
  let lastTextHash = "";
  // url -> the last visible text captured for it. Used to tell a PARTIAL RENDER of the
  // page we just took (skip it) apart from GENUINELY DIFFERENT content living at the same
  // URL (keep it). Master-detail apps like Jobberman swap the whole right-hand panel
  // without ever changing the address bar, so length alone is not a valid discriminator.
  const lastTextByUrl = new Map();
  const lastRecByUrl = new Map(); // url -> {id, at} so a fuller render can replace a partial one
  let busy = false;
  let clickTimer = null;
  let mutTimer = null;
  let observer = null;

  /* ---------------- helpers ---------------- */
  const fnv = (str) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16);
  };
  const kb = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB");
  const txt = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n || 400);
  // never let our own HUD leak into a capture
  const inHud = (el) => {
    try { return !!(el && el.closest && el.closest("#" + HUD_ID)); } catch (e) { return false; }
  };

  /* ---- v1.8: reach into shadow DOM and same-origin iframes ----
     Verified: innerText does NOT include shadow-root text, and querySelectorAll does not
     pierce shadow roots. Content scripts can open even CLOSED roots via
     chrome.dom.openOrClosedShadowRoot. Same-origin iframes are reachable via
     contentDocument; cross-origin ones are not (by design). */
  let CAPTURE_ROOTS = [document];
  function shadowOf(el) {
    try { if (chrome.dom && chrome.dom.openOrClosedShadowRoot) return chrome.dom.openOrClosedShadowRoot(el); } catch (e) {}
    return el.shadowRoot || null;
  }
  function collectRoots() {
    const roots = [document], seen = new Set([document]);
    const walk = (root, depth) => {
      if (depth > 4) return;
      let els = [];
      try { els = root.querySelectorAll("*"); } catch (e) { return; }
      for (const el of els) {
        const sr = shadowOf(el);
        if (sr && !seen.has(sr)) { seen.add(sr); roots.push(sr); walk(sr, depth + 1); }
        if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
          try {
            const d = el.contentDocument;
            if (d && d.body && !seen.has(d)) { seen.add(d); roots.push(d); walk(d, depth + 1); }
          } catch (e) {} // cross-origin - unreachable, skip silently
        }
      }
    };
    walk(document, 0);
    return roots;
  }
  function qsa(sel) {
    const out = [];
    for (const r of CAPTURE_ROOTS) {
      try { r.querySelectorAll(sel).forEach((e) => out.push(e)); } catch (e) {}
    }
    return out;
  }
  // text that lives ONLY in shadow roots / same-origin iframes (innerText skips both)
  function hiddenRootText() {
    const mainLines = new Set(((document.body && document.body.innerText) || "").split("\n").map((s) => s.trim()));
    const parts = [];
    for (const r of CAPTURE_ROOTS) {
      if (r === document) continue;
      let t = "";
      if (r.body) t = r.body.innerText || "";      // iframe document
      else {                                        // shadow root - walk text nodes
        try {
          const w = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
          const buf = []; let n;
          while ((n = w.nextNode())) {
            const p = n.parentElement;
            if (p && /^(style|script|noscript|template)$/i.test(p.tagName)) continue;
            const s = n.textContent.trim();
            if (s) buf.push(s);
          }
          t = buf.join("\n");
        } catch (e) {}
      }
      for (const line of t.split("\n")) {
        const s = line.trim();
        if (s && !mainLines.has(s)) { mainLines.add(s); parts.push(s); }
        if (parts.length > 4000) return parts.join("\n");
      }
    }
    return parts.join("\n");
  }

  // Lazy lists end with a "Loading messages.." line that sits BETWEEN the old rows and
  // the newly streamed ones, which breaks a naive contiguous-substring comparison.
  // Drop that tail before comparing two renders of the same page.
  const stripLoader = (t) =>
    (t || "").replace(/(?:^|\n)[^\n]{0,60}(loading|please wait|loading\.\.\.)[^\n]{0,60}\s*$/i, "").trim();

  // true only for DOM changes that belong to the PAGE, not to our own HUD
  const pageMutation = (m) => {
    const n = m.target && m.target.nodeType === 1 ? m.target : m.target && m.target.parentElement;
    return !inHud(n);
  };

  // wait until the DOM stops changing, so we never snapshot a half-painted page
  function settle(quietMs, maxMs) {
    return new Promise((res) => {
      let quiet, hard, obs, done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(quiet);
        clearTimeout(hard);
        try { obs && obs.disconnect(); } catch (e) {}
        res();
      };
      const bump = () => { clearTimeout(quiet); quiet = setTimeout(finish, quietMs || 800); };
      try {
        // our own HUD repaints constantly - those are not the page settling
        obs = new MutationObserver((muts) => { if (muts.some(pageMutation)) bump(); });
        obs.observe(document.body, { childList: true, subtree: true, characterData: true });
      } catch (e) { return finish(); }
      hard = setTimeout(finish, maxMs || 5000);
      bump();
    });
  }

  // stable test hooks (data-cy / data-testid) are the best scraper targets a page can offer
  function stableAttrs(el) {
    const out = new Set();
    const walk = (e) => {
      if (e.attributes)
        for (const a of e.attributes)
          if (/^data-(cy|testid|test|qa|automation)$/i.test(a.name))
            out.add(a.name + '="' + String(a.value).replace(/\d{3,}/g, "{id}") + '"');
      for (const c of e.children || []) walk(c);
    };
    try { walk(el); } catch (e) {}
    return [...out].slice(0, 25);
  }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id && !/^\d/.test(el.id)) return "#" + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    for (let i = 0; i < 4 && cur && cur.nodeType === 1 && cur.tagName !== "HTML"; i++) {
      let p = cur.tagName.toLowerCase();
      const cls = (cur.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) p += "." + cls.map((c) => CSS.escape(c)).join(".");
      parts.unshift(p);
      if (cur.id && !/^\d/.test(cur.id)) { parts[0] = "#" + CSS.escape(cur.id); break; }
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }

  function signature(el) {
    const cls = (el.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 6).join(".");
    const role = el.getAttribute("role");
    return el.tagName.toLowerCase() + (cls ? "." + cls : "") + (role ? "[role=" + role + "]" : "");
  }

  /* ---------------- layer builders ---------------- */
  function cleanClone() {
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll("#" + HUD_ID).forEach((n) => n.remove());
    clone.querySelectorAll("script,style,noscript,template,link[rel=stylesheet]").forEach((n) => n.remove());
    // sanitize invalid negative dimensions some sites ship (e.g. Robinhood width="-104")
    // which otherwise make the browser log an SVG-attribute warning against the extension.
    clone.querySelectorAll("[width],[height]").forEach((n) => {
      ["width", "height"].forEach((d) => {
        const v = n.getAttribute(d);
        if (v && /^-/.test(v.trim())) n.setAttribute(d, "0");
      });
    });
    clone.querySelectorAll("svg").forEach((n) => {
      const t = (n.getAttribute("aria-label") || n.querySelector("title")?.textContent || "").trim();
      const rep = document.createElement("i");
      rep.setAttribute("data-svg", t || "icon");
      n.replaceWith(rep);
    });
    const all = clone.querySelectorAll("*");
    for (const el of all) {
      for (const a of Array.from(el.attributes)) {
        const n = a.name.toLowerCase();
        if (n.startsWith("data-") || n.startsWith("aria-") || KEEP_ATTRS.has(n)) {
          if (a.value && a.value.length > 300) el.setAttribute(a.name, a.value.slice(0, 120) + "...[trimmed]");
          if (/^data:/i.test(a.value)) el.setAttribute(a.name, "data:[inline-asset trimmed]");
        } else {
          el.removeAttribute(a.name);
        }
      }
    }
    return clone;
  }

  function cleanElHtml(el) {
    const c = el.cloneNode(true);
    c.querySelectorAll("script,style,noscript,svg").forEach((n) => n.remove());
    c.querySelectorAll("*").forEach((e) => {
      for (const a of Array.from(e.attributes)) {
        const n = a.name.toLowerCase();
        if (!(n.startsWith("data-") || KEEP_ATTRS.has(n))) e.removeAttribute(a.name);
        else if (a.value && a.value.length > 200) e.setAttribute(a.name, a.value.slice(0, 80) + "...");
      }
    });
    return c.outerHTML;
  }

  function visibleText() {
    const hud = document.getElementById(HUD_ID);
    const prev = hud ? hud.style.display : null;
    if (hud) hud.style.display = "none";
    const t = (document.body && document.body.innerText) || "";
    if (hud) hud.style.display = prev;
    return t.replace(/\n{3,}/g, "\n\n").trim();
  }

  function links() {
    const seen = new Set();
    const out = [];
    for (const a of qsa("a[href]")) {
      const href = a.href;
      if (!href || href.startsWith("javascript:") || inHud(a)) continue;
      const key = href + "|" + txt(a.innerText, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text: txt(a.innerText, 160), href });
      if (out.length >= 1500) break;
    }
    return out;
  }

  function assets() {
    const out = [];
    const seen = new Set();
    const push = (url, kind, label) => {
      if (!url || seen.has(url)) return;
      seen.add(url);
      out.push({ url, kind, label: txt(label, 120) });
    };
    qsa("a[href]").forEach((a) => {
      if (inHud(a)) return;
      if (ASSET_RE.test(a.href) || a.hasAttribute("download"))
        push(a.href, (a.href.match(ASSET_RE) || [, "link"])[1].toLowerCase(), a.innerText);
    });
    qsa("img[src],source[src],video,audio,embed[src],object[data],iframe[src]").forEach((n) => {
      if (inHud(n)) return;
      let u = n.src || n.getAttribute("data") || "";
      if (/^(VIDEO|AUDIO)$/.test(n.tagName)) {
        u = n.currentSrc || n.src || "";
        let lbl = n.getAttribute("alt") || n.getAttribute("aria-label") || "";
        if (isFinite(n.duration) && n.duration > 0)
          lbl = (lbl ? lbl + " " : "") + "[" + Math.floor(n.duration / 60) + ":" + String(Math.floor(n.duration % 60)).padStart(2, "0") + "]";
        if (u) push(u, n.tagName.toLowerCase(), lbl);
        return;
      }
      if (u && !/^data:/i.test(u)) push(u, n.tagName.toLowerCase(), n.getAttribute("alt") || "");
    });
    return out.slice(0, 800);
  }

  function structured() {
    const jsonld = [];
    qsa('script[type="application/ld+json"]').forEach((s) => {
      try { jsonld.push(JSON.parse(s.textContent)); }
      catch (e) { jsonld.push({ _unparsed: (s.textContent || "").slice(0, 4000) }); }
    });
    const meta = {};
    document.querySelectorAll("meta[name],meta[property]").forEach((m) => {
      const k = m.getAttribute("name") || m.getAttribute("property");
      const v = m.getAttribute("content");
      if (k && v) meta[k] = v.slice(0, 500);
    });
    const inlineState = [];
    document.querySelectorAll("script:not([src])").forEach((s) => {
      const t = s.textContent || "";
      if (t.length < 60 || t.length > 400000) return;
      const m = t.match(/(?:__NEXT_DATA__|__NUXT__|__INITIAL_STATE__|window\.__data|application\/json|SIGI_STATE|__UNIVERSAL_DATA_FOR_REHYDRATION__|ytInitialData|ytInitialPlayerResponse)/);
      if (m) inlineState.push(t.slice(0, 200000));
    });
    document.querySelectorAll('script[type="application/json"]').forEach((s) => {
      const t = s.textContent || "";
      if (t.length > 40) inlineState.push(t.slice(0, 200000));
    });
    return { jsonld, meta, inlineState: inlineState.slice(0, 6) };
  }

  function forms() {
    const out = [];
    const fields = qsa("input,select,textarea,button[type=submit]");
    for (const f of fields) {
      if (inHud(f)) continue;
      const rec = {
        tag: f.tagName.toLowerCase(),
        type: f.getAttribute("type") || "",
        name: f.getAttribute("name") || "",
        id: f.id || "",
        placeholder: f.getAttribute("placeholder") || "",
        selector: cssPath(f),
        form: f.form ? (f.form.getAttribute("action") || f.form.id || "form") : ""
      };
      if (rec.type === "password") rec.value = "[redacted]";
      else if (f.value && String(f.value).length < 200) rec.value = f.value;
      if (f.tagName === "SELECT")
        rec.options = Array.from(f.options).slice(0, 200).map((o) => ({ value: o.value, label: txt(o.text, 80) }));
      const lbl = f.id ? document.querySelector('label[for="' + CSS.escape(f.id) + '"]') : null;
      if (lbl) rec.label = txt(lbl.innerText, 120);
      out.push(rec);
      if (out.length >= 400) break;
    }
    return out;
  }


  function interactives() {
    const out = [];
    const els = qsa("a[href],button,input,select,textarea,[role='button'],[role='link'],[role='tab'],[onclick],summary,[contenteditable='true']");
    for (const el of els) {
      if (inHud(el)) continue;
      let r; try { r = el.getBoundingClientRect(); } catch (e) { continue; }
      if (!r || (r.width === 0 && r.height === 0)) continue;
      out.push({
        tag: el.tagName.toLowerCase(),
        selector: cssPath(el),
        text: txt(el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder"), 120),
        type: el.getAttribute("type") || "",
        href: el.getAttribute("href") || "",
        box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
      });
      if (out.length >= 500) break;
    }
    return out;
  }

  function tables() {
    const out = [];
    qsa("table").forEach((t) => {
      if (inHud(t)) return;
      const rows = [];
      t.querySelectorAll("tr").forEach((tr) => {
        const cells = Array.from(tr.querySelectorAll("th,td")).map((c) => txt(c.innerText, 300));
        if (cells.length) rows.push(cells);
      });
      if (rows.length > 1) out.push({ selector: cssPath(t), rows: rows.slice(0, 500) });
    });
    return out.slice(0, 40);
  }

  function repeats() {
    const out = [];
    const els = [];
    for (const r of CAPTURE_ROOTS) {
      try { (r.body || r).querySelectorAll("*").forEach((e) => els.push(e)); } catch (e) {}
    }
    for (const p of els) {
      if (p.id === HUD_ID || inHud(p)) continue;
      const kids = p.children;
      if (kids.length < 3 || kids.length > 400) continue;
      const groups = new Map();
      for (const k of kids) {
        const s = signature(k);
        if (!groups.has(s)) groups.set(s, []);
        groups.get(s).push(k);
      }
      for (const [sig, arr] of groups) {
        if (arr.length < 3) continue;
        const sample = arr[0];
        const st = (sample.innerText || "").trim();
        if (st.length < 40) continue; // "Upgrade to see actual info" tier noise
        out.push({
          containerSelector: cssPath(p),
          itemSignature: sig,
          count: arr.length,
          stableAttrs: stableAttrs(sample),
          sampleText: txt(st, 500),
          sampleHtml: cleanElHtml(sample).slice(0, 2500)
        });
      }
    }
    out.sort(
      (a, b) =>
        b.count * Math.min(b.sampleText.length, 400) + (b.stableAttrs.length ? 5000 : 0) -
        (a.count * Math.min(a.sampleText.length, 400) + (a.stableAttrs.length ? 5000 : 0))
    );
    const seen = new Set();
    return out.filter((r) => {
      if (seen.has(r.itemSignature)) return false;
      seen.add(r.itemSignature);
      return true;
    }).slice(0, 12);
  }

  /* ---------------- snapshot ---------------- */
  function buildSnapshot(trigger) {
    CAPTURE_ROOTS = collectRoots();
    let text = visibleText();
    const hidden = hiddenRootText();
    if (hidden) text += "\n\n----- shadow-DOM / embedded-frame content -----\n" + hidden;
    const clean = (settings.keepCleanHtml === false || /^bridge/.test(trigger||"")) ? "" : (()=>{try{return cleanClone().outerHTML;}catch(e){return "";}})();
    const raw = settings.keepRawHtml === false ? "" : document.documentElement.outerHTML;
    const L = links(), A = assets(), F = forms(), T = tables(), R = repeats(), SD = structured();
    const IM = interactives();

    return {
      url: location.href,
      title: document.title || "",
      capturedAt: new Date().toISOString(),
      trigger: trigger || "manual",
      textHash: fnv(text.slice(0, 200000)),
      text,
      links: L,
      assets: A,
      structured: SD,
      forms: F,
      selectorMap: IM,
      tables: T,
      repeats: R,
      cleanHtml: clean,
      rawHtml: raw,
      counts: {
        textChars: text.length,
        links: L.length,
        assets: A.length,
        forms: F.length,
        interactives: IM.length,
        tables: T.length,
        repeats: R.length,
        cleanChars: clean.length,
        rawChars: raw.length
      }
    };
  }

  async function capture(trigger, auto) {
    if (busy) return { ok: false, reason: "busy" };
    const now = Date.now();
    if (auto && now - lastCaptureAt < (settings.minGapMs || 2500))
      return { ok: false, reason: "throttled" };
    busy = true;
    hudFlash(auto ? "waiting for page to settle..." : "capturing...");
    try {
      // never snapshot mid-render
      await settle(auto ? 550 : 250, auto ? 3500 : 1200);

      const snap = buildSnapshot(trigger);

      if (auto) {
        if (snap.textHash === lastTextHash) {
          hudRender("no change");
          return { ok: false, reason: "no change" };
        }
        if (!snap.title || snap.counts.textChars < MIN_AUTO_CHARS) {
          hudRender("skipped: page still loading");
          return { ok: false, reason: "loading skeleton" };
        }
        // A partial render is a SUBSET of the state we just captured (the nav chrome
        // renders first, the body fills in after). Different content at the same URL is
        // not a subset, so every candidate in a master-detail list still gets captured.
        const prev = lastTextByUrl.get(snap.url);
        const prevCore = stripLoader(prev);
        const newCore = stripLoader(snap.text);
        if (prev && newCore.length < prevCore.length && prevCore.indexOf(newCore) !== -1) {
          hudRender("skipped: same page still rendering");
          return { ok: false, reason: "partial render" };
        }
        // The mirror case: we stored a partial render moments ago and this is the same
        // page finished. Replace it instead of keeping both.
        const rec = lastRecByUrl.get(snap.url);
        if (prev && rec && Date.now() - rec.at < 15000 && newCore.length > prevCore.length && newCore.indexOf(prevCore) !== -1) {
          snap.replaceId = rec.id;
        }
        lastTextByUrl.set(snap.url, snap.text);
        if (lastTextByUrl.size > 20) lastTextByUrl.delete(lastTextByUrl.keys().next().value);
      }

      lastTextHash = snap.textHash;
      lastCaptureAt = now;
      const r = await send({ type: "capture", payload: snap, auto: !!auto });
      if (r && r.ok) {
        stats = r.stats || stats;
        lastRecByUrl.set(snap.url, { id: r.id, at: Date.now() });
        if (lastRecByUrl.size > 20) lastRecByUrl.delete(lastRecByUrl.keys().next().value);
        hudRender(snap.replaceId ? "updated to full page (" + kb(r.bytes) + ")" : "+" + kb(r.bytes) + " saved");
      } else {
        hudRender(r && r.reason ? r.reason : "skipped");
      }
      return r;
    } catch (e) {
      hudRender("error: " + e.message);
      return { ok: false, reason: e.message };
    } finally {
      busy = false;
    }
  }

  function send(msg) {
    return new Promise((res) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r); });
      } catch (e) { res({ ok: false, reason: String(e) }); }
    });
  }

  /* ---------------- HUD ---------------- */
  let hudEls = {};
  function buildHud() {
    if (document.getElementById(HUD_ID) || !document.body) return;
    const d = document.createElement("div");
    d.id = HUD_ID;
    d.style.cssText =
      "position:fixed;z-index:2147483647;bottom:16px;right:16px;width:212px;background:#0f2740;color:#fff;" +
      "font:12px -apple-system,Segoe UI,sans-serif;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.45);" +
      "padding:10px 11px;user-select:none";
    d.innerHTML =
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">' +
      '<span id="auc-dot" style="width:9px;height:9px;border-radius:50%;background:#6b7280;display:inline-block"></span>' +
      '<b style="flex:1;font-size:12px">Universal Capture <span style="opacity:.45;font-weight:400">v' + VERSION + "</span></b>" +
      '<span id="auc-pos" title="move to top / bottom" style="cursor:pointer;opacity:.55;padding:0 4px;font-size:11px">&#8597;</span>' +
      '<span id="auc-min" title="collapse" style="cursor:pointer;opacity:.6;padding:0 4px">&minus;</span>' +
      '<span id="auc-hide" title="hide (bring back from the toolbar popup)" style="cursor:pointer;opacity:.6;padding:0 2px 0 4px">&times;</span></div>' +
      '<div id="auc-body">' +
      '<div id="auc-stat" style="font-size:11px;opacity:.9;line-height:1.5;margin-bottom:7px">Idle</div>' +
      '<button id="auc-rec" style="width:100%;margin:2px 0;padding:7px;border:0;border-radius:6px;background:#1a7f37;color:#fff;font-weight:700;cursor:pointer;font-size:12px">Start recording</button>' +
      '<button id="auc-cap" style="width:100%;margin:2px 0;padding:7px;border:0;border-radius:6px;background:#1f6feb;color:#fff;font-weight:700;cursor:pointer;font-size:12px">Capture this page</button>' +
      '<button id="auc-vault" style="width:100%;margin:2px 0;padding:7px;border:0;border-radius:6px;background:#374151;color:#fff;cursor:pointer;font-size:12px">Open Vault</button>' +
      '<div id="auc-msg" style="margin-top:6px;font-size:11px;opacity:.75;min-height:14px">Shift+S grab &middot; Shift+E record</div>' +
      "</div>";
    document.body.appendChild(d);
    hudEls = {
      root: d,
      dot: d.querySelector("#auc-dot"),
      stat: d.querySelector("#auc-stat"),
      rec: d.querySelector("#auc-rec"),
      cap: d.querySelector("#auc-cap"),
      vault: d.querySelector("#auc-vault"),
      msg: d.querySelector("#auc-msg"),
      body: d.querySelector("#auc-body"),
      min: d.querySelector("#auc-min"),
      hide: d.querySelector("#auc-hide"),
      pos: d.querySelector("#auc-pos")
    };
    hudEls.rec.onclick = async () => {
      hudFlash("working...");
      const r = await send({ type: "toggleRecording" });
      if (r && r.stats) { stats = r.stats; hudRender(stats.recording ? "recording..." : stopMsg(r)); }
    };
    hudEls.cap.onclick = () => capture("hud-button", false);
    hudEls.vault.onclick = () => send({ type: "openVault" });
    hudEls.min.onclick = () => {
      const hidden = hudEls.body.style.display === "none";
      hudEls.body.style.display = hidden ? "" : "none";
      hudEls.root.style.width = hidden ? "212px" : "auto";
      hudEls.min.innerHTML = hidden ? "&minus;" : "+";
    };
    hudEls.hide.onclick = () => {
      d.remove();
      hudEls = {};
      send({ type: "setSettings", patch: { hudHidden: true } });
    };
    hudEls.pos.onclick = () => {
      const top = !(settings.hudTop === true);
      settings.hudTop = top;
      applyPos();
      send({ type: "setSettings", patch: { hudTop: top } });
    };
    applyPos();
    hudRender();
  }

  function applyPos() {
    if (!hudEls.root) return;
    if (settings.hudTop) {
      hudEls.root.style.top = "16px";
      hudEls.root.style.bottom = "auto";
    } else {
      hudEls.root.style.bottom = "16px";
      hudEls.root.style.top = "auto";
    }
  }

  function hudRender(msg) {
    if (!hudEls.root) return;
    const rec = !!stats.recording;
    hudEls.dot.style.background = rec ? "#22c55e" : "#6b7280";
    hudEls.dot.style.boxShadow = rec ? "0 0 8px #22c55e" : "none";
    hudEls.rec.textContent = rec ? "Stop recording" : "Start recording";
    hudEls.rec.style.background = rec ? "#b42318" : "#1a7f37";
    hudEls.stat.innerHTML =
      (rec
        ? "<b style='color:#22c55e'>REC</b> this session: <b>" + (stats.sessionCount || 0) + " caps &middot; " + kb(stats.sessionBytes || 0) + "</b><br>"
        : "Idle<br>") +
      "<span style='opacity:.65'>vault total: " + (stats.totalCount || 0) + " caps &middot; " + kb(stats.totalBytes || 0) + "</span>";
    if (msg) hudEls.msg.textContent = msg;
  }
  function hudFlash(m) { if (hudEls.msg) hudEls.msg.textContent = m; }

  /* ---------------- triggers ---------------- */
  function armAuto() {
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onNav);
    window.addEventListener("hashchange", onNav);
    if (!observer) {
      observer = new MutationObserver((muts) => {
        if (!stats.recording || settings.onMutation === false) return;
        if (!muts.some(pageMutation)) return; // ignore our own HUD repainting
        clearTimeout(mutTimer);
        mutTimer = setTimeout(() => capture("mutation", true), 900);
      });
      try { observer.observe(document.body, { childList: true, subtree: true, characterData: true }); } catch (e) {}
    }
  }
  function onClick(e) {
    if (!stats.recording || settings.onClick === false) return;
    if (e && e.target && inHud(e.target)) return; // our own buttons are not page activity
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => capture("click", true), 450);
  }
  function onNav() {
    if (!stats.recording || settings.onNav === false) return;
    setTimeout(() => capture("nav", true), 550);
  }

  // Page-level hotkeys. These do NOT go through chrome.commands, so no other
  // extension can steal them and Chrome can never silently leave them unbound.
  //   Shift+S = capture this page
  //   Shift+E = start / stop recording
  // Both are ignored while typing in a field.
  window.addEventListener("keydown", async (e) => {
    if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = (e.key || "").toLowerCase();
    if (k !== "s" && k !== "e") return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
    e.preventDefault();
    if (k === "s") return capture("shift-s", false);
    const r = await send({ type: "toggleRecording" });
    if (r && r.stats) {
      stats = r.stats;
      hudRender(stats.recording ? "recording started (Shift+E)" : stopMsg(r));
    }
  }, true);

  // what to show after a stop: the folder-bridge result if one was written
  function stopMsg(r) {
    const e = r && r.exported;
    if (!e) return "stopped";
    return e.ok ? "stopped - saved to Downloads folder" : "stopped - folder save failed: " + (e.reason || "?");
  }

  chrome.runtime.onMessage.addListener((msg, s, reply) => {
    if (msg.type === "ping") { reply({ ok: true }); return true; }
    if (msg.type === "doCapture") {
      capture(msg.trigger || "manual", !!msg.auto).then((r) => reply(r));
      return true;
    }
    if (msg.type === "exported") {
      const e = msg.exported || {};
      hudFlash(e.ok ? "saved " + e.captures + " caps to Downloads folder" : "folder save failed: " + (e.reason || "?"));
      return true;
    }
    if (msg.type === "recordingChanged" || msg.type === "settingsChanged") {
      if (msg.stats) stats = msg.stats;
      if (msg.settings) settings = msg.settings;
      const present = !!document.getElementById(HUD_ID);
      if (settings.hudHidden && present) {
        document.getElementById(HUD_ID).remove();
        hudEls = {};
      } else if (!settings.hudHidden && !present) {
        buildHud();
      } else {
        applyPos();
      }
      hudRender(msg.stats && msg.stats.recording ? "recording..." : "");
      reply({ ok: true });
      return true;
    }
    return false;
  });

  /* ---------------- boot ---------------- */
  async function boot() {
    const r = await send({ type: "stats" });
    if (r && r.ok) { stats = r.stats; settings = r.settings; }
    const isTop = (window.top === window);
    // v1.14: content script now runs in ALL frames so cross-origin iframes
    // (e.g. HERO's Azure-hosted loan panels) are capturable. But only the TOP
    // frame gets the HUD and drives auto-record, so child frames stay silent
    // helpers that still answer a targeted doCapture with their own document.
    if (isTop && !settings.hudHidden) buildHud();
    if (isTop) armAuto();
    if (isTop && stats.recording && settings.onLoad !== false) setTimeout(() => capture("page-load", true), 700);
  }

  if (document.readyState === "complete" || document.readyState === "interactive") setTimeout(boot, 700);
  else window.addEventListener("load", () => setTimeout(boot, 700));
})();
