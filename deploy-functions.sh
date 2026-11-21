#!/usr/bin/env bash
# Deploys the ALL4PAWS payment server (Stripe) to Firebase Functions.
# Needs: the Blaze plan on the Firebase project, and npm (Google Cloud Shell has it).
# Run from the app folder:  bash deploy-functions.sh
set -e
P=all4pawz-7d3f7
cd "$(dirname "$0")"

if ! command -v npm >/dev/null 2>&1; then
  echo "This step needs npm, which this computer doesn't have."
  echo "Open https://shell.cloud.google.com, then run:"
  echo "  git clone https://github.com/mrbzk/all4paws-app 2>/dev/null; cd all4paws-app && git pull && bash deploy-functions.sh"
  exit 1
fi

echo "== Checking Firebase sign-in"
if ! firebase projects:list >/dev/null 2>&1; then
  firebase login --no-localhost
fi

echo "== Checking the Stripe keys are stored on the server"
for S in STRIPE_SECRET STRIPE_WEBHOOK_SECRET; do
  if ! firebase functions:secrets:access "$S" --project "$P" >/dev/null 2>&1; then
    echo ""
    echo "The secret $S isn't set yet. Paste it when asked (it won't show on screen)."
    [ "$S" = STRIPE_SECRET ] && echo "Find it in Stripe: Developers > API keys > Secret key (starts sk_test_ or sk_live_)."
    [ "$S" = STRIPE_WEBHOOK_SECRET ] && echo "Find it in Stripe: Developers > Webhooks > your endpoint > Signing secret (starts whsec_). If you haven't made the webhook yet, type 'later' and run this script again afterwards."
    firebase functions:secrets:set "$S" --project "$P"
  fi
done

echo "== Installing server packages"
(cd functions && npm install --omit=dev --no-audit --no-fund)

echo "== Deploying the payment server"
firebase deploy --only functions --project "$P" --non-interactive

echo ""
echo "Done. Your Stripe webhook address is:"
echo "  https://europe-west2-$P.cloudfunctions.net/stripeWebhook"
