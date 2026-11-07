#!/usr/bin/env bash
# One-step deploy of the All 4 Paws app from Google Cloud Shell.
# Run:  git clone https://github.com/mrbzk/all4paws-app && bash all4paws-app/cloudshell-deploy.sh
set -e
P=all4pawz-7d3f7
cd "$(dirname "$0")"
echo "== Checking Firebase sign-in"
if ! firebase projects:list >/dev/null 2>&1; then
  echo "Firebase needs you to sign in once. Follow the link it shows, then paste the code back here."
  firebase login --no-localhost
fi
echo "== Registering the web app (skipped if it already exists)"
if ! firebase apps:list WEB --project "$P" 2>/dev/null | grep -q "Booking app"; then
  firebase apps:create WEB "Booking app" --project "$P"
fi
echo "== Making sure the Hosting site exists"
firebase hosting:sites:create "$P" --project "$P" --non-interactive </dev/null >/dev/null 2>&1 || true
echo "== Building and deploying"
python3 build.py src/index.html
firebase deploy --only hosting,firestore:rules --project "$P" --non-interactive
echo ""
echo "Done. Open https://$P.web.app"
