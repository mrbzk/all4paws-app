#!/usr/bin/env bash
# Deploys the app to the all4paws Firebase project (ID all4pawz-7d3f7).
# First time only: npm install -g firebase-tools && firebase login
set -e
cd "$(dirname "$0")"
python3 build.py src/index.html
firebase deploy --only hosting,firestore:rules --project all4pawz-7d3f7
echo "Live at https://all4pawz-7d3f7.web.app"
