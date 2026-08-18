const $ = (id) => document.getElementById(id);
const kb = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB");
const send = (m) => new Promise((r) => chrome.runtime.sendMessage(m, (x) => { void chrome.runtime.lastError; r(x); }));
const say = (m) => ($("status").textContent = m || "");

const TOGGLES = ["onClick", "onNav", "onMutation", "keepRawHtml", "keepCleanHtml"];

function paint(stats, settings) {
  const on = !!stats.recording;
  $("dot").className = "dot" + (on ? " on" : "");
  $("mode").textContent = on ? "RECORDING" : "Idle";
  $("rec").textContent = on ? "Stop recording" : "Start recording";
  $("rec").className = on ? "on" : "";
  $("sessCount").textContent = stats.sessionCount || 0;
  $("sessBytes").textContent = kb(stats.sessionBytes || 0);
  $("totCount").textContent = stats.totalCount || 0;
  $("totBytes").textContent = kb(stats.totalBytes || 0);
  if (settings) {
    TOGGLES.forEach((k) => ($(k).checked = settings[k] !== false));
    $("showHud").checked = settings.hudHidden !== true; // stored inverted
    $("autoExport").checked = settings.autoExport !== false;
    $("folderName").textContent = settings.exportFolder || "adler-captures";
    $("lastExport").textContent = settings.lastExportAt
      ? "· last " + new Date(settings.lastExportAt).toLocaleString()
      : "· nothing saved yet";
  }
}

async function refresh() {
  const r = await send({ type: "stats" });
  if (r && r.ok) paint(r.stats, r.settings);
  const p = await send({ type: "pageStatus" });
  if (p && p.ok) {
    const el = $("page");
    el.className = "pagestat " + p.state;
    el.textContent =
      p.state === "ready" ? "● this page is ready to capture"
      : p.state === "blocked" ? "✖ Chrome blocks extensions on this page"
      : p.state === "cold" ? "○ arming this page - try again in a second"
      : p.label;
  }
}

// Chrome silently leaves a suggested shortcut UNBOUND if another extension already
// holds it. Show what is actually registered instead of what the manifest asked for.
function paintKeys() {
  if (!chrome.commands || !chrome.commands.getAll) return;
  chrome.commands.getAll((cmds) => {
    const box = $("keys");
    const rows = (cmds || []).filter((c) => c.name !== "_execute_action");
    const unbound = rows.filter((c) => !c.shortcut);
    box.innerHTML =
      rows
        .map((c) => {
          const label = c.name === "capture_now" ? "capture" : "record";
          return c.shortcut
            ? `<span class="ok">● ${c.shortcut} — global ${label}</span>`
            : `<span class="bad">○ global ${label} — not set (another extension took the key)</span>`;
        })
        .join("<br>") +
      (unbound.length ? '<br><button id="fixkeys">Set Chrome shortcuts</button>' : "");
    const b = $("fixkeys");
    if (b) b.onclick = () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  try { $("ver").textContent = "v" + chrome.runtime.getManifest().version; } catch (e) {}
  paintKeys();
  refresh();
  setInterval(refresh, 1500);

  $("rec").onclick = async () => {
    say("Working...");
    const r = await send({ type: "toggleRecording" });
    if (r && r.stats) {
      paint(r.stats);
      const e = r.exported;
      say(r.stats.recording ? "Recording. Browse normally."
        : e ? (e.ok ? "Stopped. Saved " + e.captures + " caps to " + e.file : "Stopped. Folder save failed: " + e.reason)
        : "Stopped.");
    }
    refresh();
  };
  $("bridge").onclick = async () => {
    say("Preparing the whole vault...");
    const r = await send({ type: "exportToFolder" });
    say(r && r.ok ? "Saved " + r.captures + " caps -> " + r.file : "Failed: " + ((r && r.reason) || "unknown"));
    refresh();
  };
  $("cap").onclick = async () => {
    say("Capturing...");
    const r = await send({ type: "captureActiveTab" });
    say(r && r.ok ? "Saved " + kb(r.bytes) + "." : "Skipped: " + ((r && r.reason) || "unknown"));
    refresh();
  };
  $("vault").onclick = () => send({ type: "openVault" });

  TOGGLES.forEach((k) => {
    $(k).onchange = async () => {
      await send({ type: "setSettings", patch: { [k]: $(k).checked } });
      say("Saved.");
    };
  });

  $("autoExport").onchange = async () => {
    await send({ type: "setSettings", patch: { autoExport: $("autoExport").checked } });
    say($("autoExport").checked ? "Auto-save on." : "Auto-save off.");
  };

  $("showHud").onchange = async () => {
    await send({ type: "setSettings", patch: { hudHidden: !$("showHud").checked } });
    say($("showHud").checked ? "Panel shown." : "Panel hidden.");
  };
});

document.getElementById("openBridge") && (document.getElementById("openBridge").onclick = () => send({ type: "openBridge" }).then(() => window.close()));
