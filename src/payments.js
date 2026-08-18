// UC Live — payments layer (ExtensionPay / Stripe). Bundled, no remote code.
// Requires ExtPay.js in the extension root (one-time download, see STORE-SETUP.md).
// Registered extension id on extensionpay.com: "universal-capture"  (change if you pick another).
let extpay = null;
try { extpay = ExtPay("universal-capture"); extpay.startBackground(); } catch (e) { /* ExtPay.js not present yet */ }

// Anyone can CAPTURE for free (the read-only Universal Capture stays free forever).
// The LIVE BRIDGE (AI drives your browser) is the paid feature.
let __isDev = null;
function __checkDev() {
  return new Promise((res) => {
    try { chrome.management.getSelf((info) => { __isDev = (info && info.installType === "development"); res(__isDev); }); }
    catch (e) { __isDev = false; res(false); }
  });
}
async function ucPaidStatus() {
  if (__isDev === null) await __checkDev();
  if (__isDev) return { ok: true, reason: "dev-install" }; // unpacked dev copy is always unrestricted
  if (!extpay) return { ok: true, reason: "no-extpay" };
  try {
    const u = await extpay.getUser();
    if (u.paid) return { ok: true, reason: "paid" };
    if (u.trialStartedAt) {
      const days = (Date.now() - new Date(u.trialStartedAt)) / 86400000;
      if (days < 7) return { ok: true, reason: "trial", daysLeft: Math.ceil(7 - days) };
      return { ok: false, reason: "trial_expired" };
    }
    return { ok: false, reason: "free" };
  } catch (e) { return { ok: false, reason: "error", error: e.message }; }
}
function ucOpenPayment() { if (extpay) extpay.openPaymentPage(); }
function ucOpenTrial()   { if (extpay) extpay.openTrialPage("7-day free trial"); }
if (typeof self !== "undefined") { self.ucPaidStatus = ucPaidStatus; self.ucOpenPayment = ucOpenPayment; self.ucOpenTrial = ucOpenTrial; }
