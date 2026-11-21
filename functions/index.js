// ALL4PAWS server functions: Stripe Checkout for deposits, bookings and balances, and a webhook that marks
// bookings paid when Stripe confirms the payment.
// Secrets (set once from a terminal, never stored in code or chat):
//   firebase functions:secrets:set STRIPE_SECRET          (your Stripe secret key, sk_test_... or sk_live_...)
//   firebase functions:secrets:set STRIPE_WEBHOOK_SECRET  (the webhook signing secret, whsec_...)
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const REGION = "europe-west2";
const STRIPE_SECRET = defineSecret("STRIPE_SECRET");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");
const stripeFor = () => require("stripe")(STRIPE_SECRET.value());
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

async function isStaff(auth) {
  if (!auth) return false;
  const d = (await db.doc("config/admins").get()).data() || {};
  const email = String(auth.token.email || "").toLowerCase();
  const confirmed = auth.token.email_verified === true || (auth.token.firebase && auth.token.firebase.sign_in_provider === "google.com");
  return !!(d.staffUids && d.staffUids[auth.uid]) || (confirmed && (d.emails || []).map(x => String(x).toLowerCase()).includes(email));
}

function depositFor(price, st) {
  if (st.depositType === "percent") return round2((Number(price) || 0) * (Number(st.depositValue) || 0) / 100);
  return round2(Math.min(Number(st.depositValue) || 0, Number(price) || 0));
}

// Staff: is Stripe connected, and to which account (test or live)?
exports.stripeStatus = onCall({ region: REGION, secrets: [STRIPE_SECRET] }, async req => {
  if (!(await isStaff(req.auth))) throw new HttpsError("permission-denied", "Staff only.");
  let key = "";
  try { key = STRIPE_SECRET.value(); } catch (e) { key = ""; }
  if (!key) return { connected: false, reason: "No Stripe key set" };
  try {
    const acct = await stripeFor().accounts.retrieve();
    return { connected: true, live: key.startsWith("sk_live_") || key.startsWith("rk_live_"), account: acct.settings && acct.settings.dashboard && acct.settings.dashboard.display_name || acct.business_profile && acct.business_profile.name || acct.id };
  } catch (e) {
    return { connected: false, reason: e.message || "Stripe rejected the key" };
  }
});

// Customer: start a Stripe Checkout for a deposit, one booking, or everything they owe.
exports.createCheckout = onCall({ region: REGION, secrets: [STRIPE_SECRET] }, async req => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Please sign in first.");
  const kind = String((req.data || {}).kind || "");
  const bookingId = String((req.data || {}).bookingId || "");
  if (!["deposit", "booking", "balance"].includes(kind)) throw new HttpsError("invalid-argument", "Unknown payment type.");

  const cfg = (await db.doc("config/main").get()).data() || {};
  const st = cfg.stripe || {};
  if (st.mode !== "checkout") throw new HttpsError("failed-precondition", "Card payments aren't switched on yet.");

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
      amount = depositFor(b.price, st); label = "Deposit";
    } else {
      amount = round2((Number(b.price) || 0) - (Number(b.depositPaid) || 0)); label = "Booking";
    }
    ids = [bookingId];
  }
  const pence = Math.round(amount * 100);
  if (pence < 30) throw new HttpsError("failed-precondition", "There's nothing to pay right now.");

  const origin = /^https:\/\/[a-z0-9.-]+$/i.test(req.rawRequest.headers.origin || "") ? req.rawRequest.headers.origin : "https://all4pawz-7d3f7.web.app";
  const metadata = { clientId: client.id, kind, bookingIds: ids.join(",").slice(0, 490) };
  const session = await stripeFor().checkout.sessions.create({
    mode: "payment",
    customer_email: client.email || undefined,
    client_reference_id: client.id,
    line_items: [{ quantity: 1, price_data: { currency: "gbp", unit_amount: pence, product_data: { name: (cfg.businessName || "ALL4PAWS") + " " + label.toLowerCase() } } }],
    metadata,
    payment_intent_data: { metadata, description: (cfg.businessName || "ALL4PAWS") + " " + label.toLowerCase() + " for " + client.name },
    success_url: origin + "/portal?paid=1",
    cancel_url: origin + "/portal?paid=0"
  });
  return { url: session.url };
});

// Stripe calls this when a payment completes. It checks Stripe's signature, then marks the bookings paid.
exports.stripeWebhook = onRequest({ region: REGION, secrets: [STRIPE_SECRET, STRIPE_WEBHOOK_SECRET] }, async (req, res) => {
  let event;
  try { event = stripeFor().webhooks.constructEvent(req.rawBody, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET.value()); }
  catch (e) { res.status(400).send("Signature check failed"); return; }

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const s = event.data.object; const m = s.metadata || {};
    if (s.payment_status === "paid") {
      const payRef = db.collection("payments").doc(s.id);
      if (!(await payRef.get()).exists) {
        const ids = String(m.bookingIds || "").split(",").filter(Boolean);
        const amount = round2((s.amount_total || 0) / 100); const at = new Date().toISOString();
        for (const id of ids) {
          const ref = db.doc("bookings/" + id); const snap = await ref.get(); if (!snap.exists) continue;
          if (m.kind === "deposit") await ref.update({ depositPaid: amount, depositAt: at, stripeDeposit: s.id });
          else await ref.update({ paid: true, paidAt: at, paidBy: "card", stripePayment: s.id });
        }
        await payRef.set({ clientId: m.clientId || "", kind: m.kind || "", bookingIds: ids, amount, at, email: (s.customer_details && s.customer_details.email) || "", live: !!event.livemode });
      }
    }
  }
  res.json({ received: true });
});
