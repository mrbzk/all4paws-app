// ALL4PAWS payment server, using Stripe Connect.
// The business clicks "Connect with Stripe" in Settings, signs in on Stripe's page and allows access.
// Customers then pay straight into the business's own Stripe account. The business never handles a key.
// No webhook needed: when a customer returns from Stripe, or when anyone opens the app, the server asks Stripe
// whether open payments went through, then marks the bookings paid.
//
// The platform (the software owner) sets up once:
//   firebase functions:secrets:set STRIPE_SECRET   (platform account's secret key, sk_test_... or sk_live_...)
//   functions/.env: STRIPE_CLIENT_ID=ca_...         (the platform's public Connect client ID; deploy-functions.sh asks for it)
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();
const REGION = "europe-west2";
const STRIPE_SECRET = defineSecret("STRIPE_SECRET");
const stripeFor = () => require("stripe")(STRIPE_SECRET.value());
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const ACCOUNT_DOC = "stripe/account"; // the connected Stripe account (server-only)
const ORIGINS = ["https://all4pawz-7d3f7.web.app", "https://all4pawz-7d3f7.firebaseapp.com", "http://localhost:8765"];
const originOf = req => { const o = req.rawRequest.headers.origin || ""; return ORIGINS.includes(o) ? o : ORIGINS[0]; };

async function isStaff(auth) {
  if (!auth) return false;
  const d = (await db.doc("config/admins").get()).data() || {};
  const email = String(auth.token.email || "").toLowerCase();
  const confirmed = auth.token.email_verified === true || (auth.token.firebase && auth.token.firebase.sign_in_provider === "google.com");
  return !!(d.staffUids && d.staffUids[auth.uid]) || (confirmed && (d.emails || []).map(x => String(x).toLowerCase()).includes(email));
}
async function requireStaff(auth) { if (!(await isStaff(auth))) throw new HttpsError("permission-denied", "Staff only."); }
// Admins (the default role) manage payments; staff can't connect or disconnect Stripe
async function requireOwner(auth) {
  await requireStaff(auth);
  const d = (await db.doc("config/admins").get()).data() || {};
  const em = ((d.staffUids || {})[auth.uid] || String(auth.token.email || "")).toLowerCase();
  if ((d.roles || {})[em] === "staff") throw new HttpsError("permission-denied", "Only admins can change payment settings.");
}
async function mainCfg() { return (await db.doc("config/main").get()).data() || {}; }
async function connected() { const d = await db.doc(ACCOUNT_DOC).get(); return d.exists && d.data().accountId ? d.data() : null; }
function depositFor(price, st) {
  if (st.depositType === "percent") return round2((Number(price) || 0) * (Number(st.depositValue) || 0) / 100);
  return round2(Math.min(Number(st.depositValue) || 0, Number(price) || 0));
}
const CLIENT_ID = () => /^ca_[A-Za-z0-9]+$/.test(process.env.STRIPE_CLIENT_ID || "") ? process.env.STRIPE_CLIENT_ID : "";
const keyMode = () => { let k = ""; try { k = STRIPE_SECRET.value() || ""; } catch (e) {} return !k ? "" : /_live_/.test(k) ? "live" : "test"; };

// ---------- Connect with Stripe ----------

// Staff: start connecting. Returns Stripe's sign-in page to send the browser to.
exports.stripeConnectStart = onCall({ region: REGION, secrets: [STRIPE_SECRET] }, async req => {
  await requireOwner(req.auth);
  if (!keyMode()) throw new HttpsError("failed-precondition", "The payment server has no platform key yet.");
  const cfg = await mainCfg(); const clientId = CLIENT_ID();
  if (!clientId) throw new HttpsError("failed-precondition", "The payment server is missing its Connect client ID.");
  const state = crypto.randomBytes(24).toString("hex");
  await db.doc("stripe/state_" + req.auth.uid).set({ state, at: Date.now() });
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, scope: "read_write", state, redirect_uri: originOf(req) + "/admin" });
  if (cfg.businessName) q.set("stripe_user[business_name]", cfg.businessName);
  q.set("stripe_user[country]", "GB");
  return { url: "https://connect.stripe.com/oauth/authorize?" + q.toString() };
});

// Staff: finish connecting after Stripe sends the browser back with a code.
exports.stripeConnectFinish = onCall({ region: REGION, secrets: [STRIPE_SECRET] }, async req => {
  await requireOwner(req.auth);
  const code = String((req.data || {}).code || ""); const state = String((req.data || {}).state || "");
  const ref = db.doc("stripe/state_" + req.auth.uid); const saved = (await ref.get()).data();
  await ref.delete().catch(() => {});
  if (!saved || !state || saved.state !== state || Date.now() - saved.at > 20 * 60 * 1000) throw new HttpsError("permission-denied", "That sign-in link expired. Click Connect with Stripe again.");
  if (!/^ac_[A-Za-z0-9]+$/.test(code)) throw new HttpsError("invalid-argument", "Stripe didn't send a valid sign-in code.");
  const stripe = stripeFor();
  let tok;
  try { tok = await stripe.oauth.token({ grant_type: "authorization_code", code }); }
  catch (e) { throw new HttpsError("failed-precondition", e.message || "Stripe refused the connection."); }
  let name = tok.stripe_user_id;
  try { const a = await stripe.accounts.retrieve(tok.stripe_user_id); name = (a.settings && a.settings.dashboard && a.settings.dashboard.display_name) || (a.business_profile && a.business_profile.name) || a.email || a.id; } catch (e) {}
  await db.doc(ACCOUNT_DOC).set({ accountId: tok.stripe_user_id, name, live: !!tok.livemode, connectedAt: new Date().toISOString(), connectedBy: req.auth.token.email || req.auth.uid });
  return { connected: true, account: name, live: !!tok.livemode };
});

// Staff: disconnect the Stripe account.
exports.stripeDisconnect = onCall({ region: REGION, secrets: [STRIPE_SECRET] }, async req => {
  await requireOwner(req.auth);
  const acct = await connected(); const clientId = CLIENT_ID();
  if (acct && clientId) { try { await stripeFor().oauth.deauthorize({ client_id: clientId, stripe_user_id: acct.accountId }); } catch (e) {} }
  await db.doc(ACCOUNT_DOC).delete();
  return { connected: false };
});

// Staff: what is connected?
exports.stripeStatus = onCall({ region: REGION, secrets: [STRIPE_SECRET] }, async req => {
  await requireOwner(req.auth);
  const mode = keyMode();
  if (!mode) return { connected: false, server: false, reason: "The payment server has no platform key yet." };
  if (!CLIENT_ID()) return { connected: false, server: false, reason: "The payment server is missing its Connect client ID." };
  const acct = await connected();
  if (!acct) return { connected: false, server: true, live: mode === "live" };
  if (acct.live !== (mode === "live")) return { connected: false, server: true, live: mode === "live", reason: "Stripe was connected in " + (acct.live ? "live" : "test") + " mode but the server is now in " + mode + " mode. Disconnect, then connect again." };
  return { connected: true, server: true, live: acct.live, account: acct.name };
});

// ---------- Payments ----------

// Customer: start a Stripe Checkout for a deposit, one booking, or everything they owe.
exports.createCheckout = onCall({ region: REGION, secrets: [STRIPE_SECRET] }, async req => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Please sign in first.");
  const kind = String((req.data || {}).kind || "");
  const bookingId = String((req.data || {}).bookingId || "");
  if (!["deposit", "booking", "balance"].includes(kind)) throw new HttpsError("invalid-argument", "Unknown payment type.");

  const cfg = await mainCfg(); const st = cfg.stripe || {};
  const acct = await connected();
  if (st.mode !== "checkout" || !acct) throw new HttpsError("failed-precondition", "Card payments aren't switched on yet.");

  const found = await db.collection("clients").where("uid", "==", req.auth.uid).limit(1).get();
  if (found.empty) throw new HttpsError("failed-precondition", "Finish setting up your account first.");
  const client = Object.assign({ id: found.docs[0].id }, found.docs[0].data());

  let amount = 0; let label = ""; let ids = [];
  if (kind === "balance") {
    const bs = await db.collection("bookings").where("clientId", "==", client.id).get();
    const owed = bs.docs.map(d => Object.assign({ id: d.id }, d.data())).filter(b => b.status === "completed" && !b.paid);
    amount = round2(owed.reduce((t, b) => t + (Number(b.price) || 0) - (Number(b.depositPaid) || 0), 0));
    label = "Payment"; ids = owed.map(b => b.id);
  } else {
    const snap = await db.doc("bookings/" + bookingId).get();
    if (!snap.exists || snap.data().clientId !== client.id) throw new HttpsError("permission-denied", "That booking isn't on your account.");
    const b = snap.data();
    if (b.paid || b.status === "cancelled") throw new HttpsError("failed-precondition", "Nothing to pay on that booking.");
    if (kind === "deposit") {
      if (Number(b.depositPaid) > 0) throw new HttpsError("failed-precondition", "The deposit is already paid.");
      if ((Number(b.price) || 0) < (Number(st.depositMin) || 0) || st.depositFor === "none") throw new HttpsError("failed-precondition", "No deposit is needed for this booking.");
      amount = depositFor(b.price, st); label = "Deposit";
    } else {
      amount = round2((Number(b.price) || 0) - (Number(b.depositPaid) || 0)); label = "Booking";
    }
    ids = [bookingId];
  }
  const pence = Math.round(amount * 100);
  if (pence < 30) throw new HttpsError("failed-precondition", "There's nothing to pay right now.");

  const origin = originOf(req); const biz = cfg.businessName || "ALL4PAWS";
  const metadata = { clientId: client.id, kind, bookingIds: ids.join(",").slice(0, 490) };
  // A direct charge on the business's own connected Stripe account: the money goes to them.
  const session = await stripeFor().checkout.sessions.create({
    mode: "payment",
    customer_email: client.email || undefined,
    client_reference_id: client.id,
    line_items: [{ quantity: 1, price_data: { currency: "gbp", unit_amount: pence, product_data: { name: biz + " " + label.toLowerCase() } } }],
    metadata,
    payment_intent_data: { metadata, description: biz + " " + label.toLowerCase() + " for " + client.name },
    success_url: origin + "/portal?paid=1&cs={CHECKOUT_SESSION_ID}",
    cancel_url: origin + "/portal?paid=0"
  }, { stripeAccount: acct.accountId });
  await db.doc("checkouts/" + session.id).set({ clientId: client.id, kind, bookingIds: ids, amount, accountId: acct.accountId, status: "open", createdAt: new Date().toISOString() });
  return { url: session.url };
});

// Marks bookings paid (or records the deposit) for a completed Checkout. Safe to run more than once.
async function applyPaid(s, livemode) {
  const payRef = db.collection("payments").doc(s.id);
  if ((await payRef.get()).exists) return false;
  const m = s.metadata || {};
  const ids = String(m.bookingIds || "").split(",").filter(Boolean);
  const amount = round2((s.amount_total || 0) / 100); const at = new Date().toISOString();
  for (const id of ids) {
    const ref = db.doc("bookings/" + id); const snap = await ref.get(); if (!snap.exists) continue;
    if (m.kind === "deposit") await ref.update({ depositPaid: amount, depositAt: at, stripeDeposit: s.id });
    else await ref.update({ paid: true, paidAt: at, paidBy: "card", stripePayment: s.id });
  }
  await payRef.set({ clientId: m.clientId || "", kind: m.kind || "", bookingIds: ids, amount, at, email: (s.customer_details && s.customer_details.email) || "", live: !!livemode });
  return true;
}

// Asks Stripe about open payments and records the ones that went through.
// A customer checks their own; staff check everyone's. Pass sessionId right after returning from Stripe.
exports.confirmCheckout = onCall({ region: REGION, secrets: [STRIPE_SECRET] }, async req => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Please sign in first.");
  const staff = await isStaff(req.auth);
  let mine = null;
  if (!staff) {
    const found = await db.collection("clients").where("uid", "==", req.auth.uid).limit(1).get();
    if (found.empty) return { paid: 0 };
    mine = found.docs[0].id;
  }
  const want = String((req.data || {}).sessionId || "");
  let docs = [];
  if (want) { const d = await db.doc("checkouts/" + want).get(); if (d.exists) docs = [d]; }
  else docs = (await (mine ? db.collection("checkouts").where("clientId", "==", mine) : db.collection("checkouts")).where("status", "==", "open").limit(50).get()).docs;
  const stripe = stripeFor(); let paid = 0;
  for (const d of docs) {
    const c = d.data();
    if (mine && c.clientId !== mine) continue;
    if (c.status !== "open") { if (c.status === "paid" && want) paid++; continue; }
    let s;
    try { s = await stripe.checkout.sessions.retrieve(d.id, {}, c.accountId ? { stripeAccount: c.accountId } : undefined); } catch (e) { continue; }
    if (s.payment_status === "paid" || s.payment_status === "no_payment_required") {
      await applyPaid(s, s.livemode); await d.ref.update({ status: "paid", checkedAt: new Date().toISOString() }); paid++;
    } else if (s.status === "expired") {
      await d.ref.update({ status: "expired", checkedAt: new Date().toISOString() });
    }
  }
  return { paid };
});
