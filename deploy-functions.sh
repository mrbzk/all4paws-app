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

echo "== Checking the platform Stripe key is stored on the server"
if ! firebase functions:secrets:access STRIPE_SECRET --project "$P" >/dev/null 2>&1; then
  echo ""
  echo "Paste the PLATFORM Stripe secret key when asked (it won't show on screen)."
  echo "This is the No Loss Leads Stripe account, not ALL4PAWS's. ALL4PAWS connects with the button in Settings."
  echo "Find it in Stripe: Developers > API keys > Secret key (starts sk_test_ or sk_live_)."
  firebase functions:secrets:set STRIPE_SECRET --project "$P"
fi

echo "== Installing server packages"
(cd functions && npm install --omit=dev --no-audit --no-fund)

echo "== Deploying the payment server"
firebase deploy --only functions --project "$P" --non-interactive

echo ""
echo "Done. In the app, open Settings > Integrations > Stripe, add the Connect client ID, save, then click Connect with Stripe."
