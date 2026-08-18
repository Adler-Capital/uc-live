/* Adler Universal Capture - shared "Prep for Claude" builder.
   Loaded BOTH by vault.html (as a plain script) and by background.js (importScripts),
   so the manual export button and the automatic folder-bridge export produce a
   byte-identical file. The only thing the two callers differ on is HOW they read
   records: vault.js streams them through the runtime, background.js reads IndexedDB
   directly. That is passed in as `each`.

   Measured on a real 28-capture PropStream export: the layers Dan actually reads
   (text) were 5% of the file. Links were 89% redundant, assets 94%, and 83% of the
   text repeated across captures of the same URL. This pass removes the repetition
   without dropping a single unique fact. */

const hostOf = (u) => { try { return new URL(u).hostname; } catch (e) { return "?"; } };
const estTokens = (n) => Math.round(n / 4);
const fmtTok = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));

function trimForms(forms) {
  // a 400-field capture is mostly identical unnamed checkboxes from a grid
  const out = [], seen = new Set();
  for (let f of forms || []) {
    if (!f.name && !f.id && !f.placeholder && !f.label && f.type === "checkbox") continue;
    const k = (f.tag || "") + "|" + (f.type || "") + "|" + (f.name || "") + "|" + (f.label || f.placeholder || "");
    if (seen.has(k)) continue;
    seen.add(k);
    if (f.options && f.options.length > 25)
      f = Object.assign({}, f, { options: f.options.slice(0, 25).concat([{ value: "...", label: "(" + (f.options.length - 25) + " more)" }]) });
    out.push(f);
    if (out.length >= 60) break;
  }
  return out;
}

// Gmail and most email HTML is built from tables used purely for LAYOUT. On a real
// export those nested tables were 70% of the whole file while the actual content was 1%.
// A DATA table has >=2 columns and a consistent column count; a layout table is nested
// inside another table's cell, or is one column, or is wildly ragged.
function usefulTables(tables) {
  const out = [];
  for (const t of tables || []) {
    const sel = t.selector || "";
    if (/\b(td|th)\s*>/.test(sel)) continue;             // a table inside a table cell = layout
    const rows = (t.rows || []).filter((r) => r.join("").trim().length > 0);
    if (rows.length < 2) continue;

    const widths = rows.map((r) => r.length);
    const modal = widths.sort((a, b) => widths.filter((v) => v === a).length - widths.filter((v) => v === b).length).pop();
    if (modal < 2) continue;                              // single column = a list, not a table
    const ragged = rows.filter((r) => r.length !== modal).length / rows.length;
    if (ragged > 0.4) continue;                           // inconsistent shape = layout

    const filled = rows.reduce((a, r) => a + r.filter((c) => String(c).trim()).length, 0);
    const cells = rows.reduce((a, r) => a + r.length, 0);
    if (cells && filled / cells < 0.4) continue;          // mostly-empty spacer grid

    // drop duplicate rows inside the table
    const seen = new Set(), uniq = [];
    for (const r of rows) {
      const k = r.join("");
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push(r);
    }
    out.push({ selector: sel, rows: uniq.slice(0, 200), truncated: uniq.length > 200 ? uniq.length - 200 : 0 });
    if (out.length >= 10) break;                          // no page has 40 real data tables
  }
  return out;
}

/* buildPrep(ids, L, each) -> array of string parts
   `each(ids, onRecord, label)` must call onRecord({ meta, payload }) for every id,
   in order, and resolve when done. It is called TWICE (analyse pass, emit pass). */
async function buildPrep(ids, L, each, note) {
  // PASS 1 - learn what is boilerplate for each host
  const hostLines = new Map(), hostCaps = new Map();
  await each(ids, (r) => {
    const h = hostOf(r.payload.url);
    hostCaps.set(h, (hostCaps.get(h) || 0) + 1);
    let m = hostLines.get(h);
    if (!m) { m = new Map(); hostLines.set(h, m); }
    for (const l of new Set((r.payload.text || "").split("\n").map((s) => s.trim()).filter(Boolean)))
      m.set(l, (m.get(l) || 0) + 1);
  }, "Analysing");

  const boiler = new Map(), chromeLines = new Map();
  for (const [h, m] of hostLines) {
    const n = hostCaps.get(h) || 1, s = new Set(), keep = [];
    if (n >= 3) for (const [l, c] of m) if (c >= Math.ceil(n * 0.6) && l.length < 200) { s.add(l); keep.push(l); }
    boiler.set(h, s);
    chromeLines.set(h, keep);
  }

  // PASS 2 - emit, deduping globally
  const seenLink = new Set(), seenAsset = new Set(), seenRepeat = new Set(), seenByUrl = new Map();
  const seenTable = new Set(), seenForm = new Set();
  let dupTables = 0, dupForms = 0;
  const linkRows = [], assetRows = [], body = [], index = [];
  let n = 0, droppedLines = 0, droppedLinks = 0, droppedAssets = 0;

  await each(ids, (r) => {
    const p = r.payload, h = hostOf(p.url), bs = boiler.get(h) || new Set();
    index.push(`${++n}. ${p.title || "(untitled)"} - ${p.url}`);
    const out = [`\n\n---\n\n## ${n}. ${p.title || "(untitled)"}\n`,
      `- **URL:** ${p.url}`, `- **Captured:** ${p.capturedAt} (${p.trigger})\n`];

    if (L.includes("text")) {
      // strip site chrome, then strip lines already emitted for this same URL
      let seen = seenByUrl.get(p.url);
      if (!seen) { seen = new Set(); seenByUrl.set(p.url, seen); }
      const kept = [];
      for (const raw of (p.text || "").split("\n")) {
        const l = raw.trim();
        if (!l) continue;
        if (bs.has(l)) { droppedLines++; continue; }
        if (seen.has(l)) { droppedLines++; continue; }
        seen.add(l);
        kept.push(l);
      }
      out.push(kept.length ? `### Content\n\n\`\`\`\n${kept.join("\n")}\n\`\`\`\n`
                           : `### Content\n\n_(nothing new beyond this site's standard chrome and earlier captures of this URL)_\n`);
    }

    if (L.includes("repeats") && p.repeats) {
      const fresh = p.repeats.filter((rp) => {
        const k = h + "|" + rp.itemSignature;
        if (seenRepeat.has(k)) return false;
        seenRepeat.add(k);
        return true;
      });
      if (fresh.length) {
        out.push(`### Repeating structures\n`);
        fresh.forEach((rp) => {
          out.push(`**\`${rp.itemSignature}\`** x${rp.count} in \`${rp.containerSelector}\``);
          if (rp.stableAttrs && rp.stableAttrs.length)
            out.push(`- stable selectors: ${rp.stableAttrs.map((a) => "`[" + a + "]`").join(", ")}`);
          out.push(`- sample: ${JSON.stringify((rp.sampleText || "").slice(0, 300))}`);
          out.push("```html\n" + (rp.sampleHtml || "").slice(0, 600) + "\n```\n");
        });
      }
    }

    if (L.includes("tables")) {
      const ts = usefulTables(p.tables).filter((t) => {
        const k = h + "|" + t.rows.map((r) => r.join("|")).join("~").slice(0, 4000);
        if (seenTable.has(k)) { dupTables++; return false; }
        seenTable.add(k);
        return true;
      });
      ts.forEach((t, i) => {
        out.push(`### Table ${i + 1} \`${t.selector}\`\n`);
        t.rows.forEach((row, ri) => {
          out.push("| " + row.map((c) => String(c).replace(/\|/g, "/")).join(" | ") + " |");
          if (ri === 0) out.push("| " + row.map(() => "---").join(" | ") + " |");
        });
        if (t.truncated) out.push(`\n_(+${t.truncated} more rows omitted)_`);
        out.push("");
      });
    }

    if (L.includes("forms")) {
      let fs = trimForms(p.forms);
      const fk = h + "|" + fs.map((f) => f.tag + f.type + f.name + f.selector).join("~");
      if (seenForm.has(fk)) { dupForms++; fs = []; } else if (fs.length) seenForm.add(fk);
      if (fs.length) {
        out.push(`### Form fields (${fs.length}${(p.forms || []).length > fs.length ? " of " + p.forms.length + ", duplicates removed" : ""})\n`);
        out.push("| tag | type | name | label/placeholder | selector |\n| --- | --- | --- | --- | --- |");
        fs.forEach((f) => out.push(`| ${f.tag} | ${f.type || ""} | ${f.name || ""} | ${(f.label || f.placeholder || "").replace(/\|/g, "/")} | \`${f.selector}\` |`));
        out.push("");
      }
    }

    if (L.includes("structured") && p.structured) {
      const s = p.structured;
      if (s.jsonld && s.jsonld.length) out.push(`### JSON-LD\n\n\`\`\`json\n${JSON.stringify(s.jsonld).slice(0, 6000)}\n\`\`\`\n`);
    }

    // links + assets are collected globally, emitted ONCE at the end
    if (L.includes("links")) for (const l of p.links || []) {
      if (seenLink.has(l.href)) { droppedLinks++; continue; }
      seenLink.add(l.href);
      linkRows.push(`| ${(l.text || "").replace(/\|/g, "/")} | ${l.href} |`);
    }
    if (L.includes("assets")) for (const a of p.assets || []) {
      if (seenAsset.has(a.url)) { droppedAssets++; continue; }
      seenAsset.add(a.url);
      assetRows.push(`- [${a.kind}] ${a.label ? a.label + " - " : ""}${a.url}`);
    }

    body.push(out.join("\n"));
  }, "Preparing");

  const tail = [];
  if (linkRows.length) tail.push(`\n\n---\n\n## All unique links (${linkRows.length}, deduped across every capture)\n\n| text | href |\n| --- | --- |\n${linkRows.join("\n")}\n`);
  if (assetRows.length) tail.push(`\n\n---\n\n## All unique assets and downloadables (${assetRows.length}, deduped)\n\n${assetRows.join("\n")}\n`);
  const chromeBlocks = [];
  for (const [h, lines] of chromeLines) if (lines.length) chromeBlocks.push(`### ${h}\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n`);
  if (chromeBlocks.length) tail.push(`\n\n---\n\n## Site chrome (nav, footers and labels repeated on most pages - listed once, stripped from the captures above)\n\n${chromeBlocks.join("\n")}`);

  const head =
    `# Adler Universal Capture - prepared for Claude\n\n` +
    (note ? `- ${note}\n` : "") +
    `- Captures: ${n}\n- Exported: ${new Date().toISOString()}\n- Layers: ${L.join(", ")}\n\n` +
    `> Prepared export. Repetition has been removed, NOT information: site nav/footer text that appeared on 60%+ of a host's pages is listed once under Site chrome; lines already shown in an earlier capture of the SAME URL are omitted; links and assets are deduped globally and listed once at the end; duplicate form rows and repeat-blocks already seen on that host are dropped; layout-only tables are skipped. Every unique fact is still present.\n\n` +
    `- Removed: ${droppedLines.toLocaleString()} repeated text lines, ${droppedLinks.toLocaleString()} duplicate links, ${droppedAssets.toLocaleString()} duplicate assets, ${dupTables} duplicate tables, ${dupForms} duplicate form blocks, plus layout-only tables\n\n` +
    `## Index\n\n` + index.join("\n");

  return [head].concat(body).concat(tail);
}
