# Nicole's Dog Co. app (installable PWA)

This folder is the installable version of the booking platform. It is the same app as the claude.ai prototype, plus what a phone needs to install it and use it offline.

## What's in phase 1

- **Installable.** Android and desktop Chrome or Edge show an "Install" button. On iPhone the app shows the steps (Safari > Share > Add to Home Screen). Once installed it opens full screen with its own icon.
- **Works offline.** The app and its fonts are saved on the device after the first visit. Without a connection it still opens, shows a "You're offline" banner, and keeps your changes on the device until the connection returns (with the database connected).
- **Updates itself.** When a new version is published, the app shows "A new version is ready" with a Refresh button.
- **Home screen shortcuts.** Long-press the icon for Book, Messages and Back office.
- **Database ready.** Connects to Firebase (Firestore for data, Storage for photos) when you add your settings. Without them it runs with sample data.

## Files

| File | What it does |
| --- | --- |
| `index.html` | The app. Built from `src/index.html` by `build.py`. |
| `manifest.webmanifest` | App name, colours, icons and shortcuts. |
| `sw.js` | Service worker: offline cache and updates. |
| `offline.html` | Shown if someone opens the app offline before it was ever loaded. |
| `icons/` | App icons, including maskable icons for Android and the iPhone icon. |
| `firebase-config.js` | Paste your Firebase settings here. |
| `firebase.json`, `firestore.rules`, `storage.rules` | Hosting and database setup for Firebase. |
| `src/index.html` | The shared source. The claude.ai prototype is published from this same file. |
| `build.py` | Makes `index.html` from `src/index.html`. |

## Try it on your computer

```
cd dogco-pwa
python3 -m http.server 8080
```

Open http://localhost:8080 in Chrome. The Install button appears after a few seconds.

## Put it online (Firebase project: all4paws, ID all4pawz-7d3f7)

This package is already linked to the **all4paws** project (`.firebaserc`). On Firebase Hosting the app reads the project's settings by itself, so there is nothing to paste.

**One-time setup in the Firebase console** (https://console.firebase.google.com/project/all4pawz-7d3f7):
1. **Build > Firestore Database > Create database.** Pick a European location such as `europe-west2` (London) and start in production mode. The rules in this package replace the defaults when you deploy.
2. **Project settings > General > Your apps > Add app > Web (</>).** Give it a nickname such as "Booking app" and tick **Also set up Firebase Hosting**. You can skip the code snippets it shows.

**Deploy from your computer** (needs Node.js and Python 3):
```
npm install -g firebase-tools
firebase login
cd dogco-pwa
./deploy.sh
```
On Windows run the two lines inside `deploy.sh` instead: `python build.py src/index.html` then `firebase deploy --only hosting,firestore:rules --project all4pawz-7d3f7`.

The app is then live at **https://all4pawz-7d3f7.web.app**. Open it, go to **Back office > Settings** and press **Load sample data** to try everything.

**Photos.** By default photos are saved, resized, in the database, which works on the free Spark plan. For full-quality photos, upgrade to the Blaze plan, set up **Build > Storage**, add `window.FIREBASE_EXTRA = { useStorage: true };` to `firebase-config.js`, and deploy with `firebase deploy --only hosting,firestore:rules,storage --project all4pawz-7d3f7` (add `"storage": { "rules": "storage.rules" }` to `firebase.json` first).

**Your own address.** Firebase console > **Hosting > Add custom domain**, for example `bookings.all4paws.co.uk`, then follow the DNS steps.

## Important before real customers use it

The included `firestore.rules` and `storage.rules` are **for testing only**: anyone with the link can read and change data, and they stop working on 7 December 2026. Use sample data only until phase 2 adds logins and proper rules.

## Publishing changes

1. Edit `src/index.html` (or ask Claude to).
2. Run `python3 build.py src/index.html`.
3. Change `VERSION` at the top of `sw.js` (for example to `dogco-2026-11-20-1`) so phones pick up the update.
4. `./deploy.sh`.

## Next phases

- **Phase 2: logins and security.** Separate logins for Nicole and Lauren (staff), email-link sign-in for customers so each customer only sees their own dogs, bookings and messages, and locked-down database rules.
- **Phase 3: notifications.** Push notifications for new messages, booking requests and approval decisions (Firebase Cloud Messaging plus a small cloud function). On iPhone these work once the app is installed on the home screen (iOS 16.4 or later).
- **Later.** Card payments, reminders, GPS walk tracking.
