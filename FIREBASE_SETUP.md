# Setup guide — do this once

Three parts: Firebase (auth + gallery), then Analytics (GA4). About 30 minutes total.
Nothing here needs a computer or a terminal — every step is done in a browser, so it
all works from your phone too.

## Part 1 — Firebase project

### 1. Create the project
1. Go to console.firebase.google.com → **Add project**.
2. Name it (e.g. "nd-flow-plumbing") → you can skip Google Analytics here, that's handled in Part 2 → Create.

### 2. Register a web app
1. On the project overview page, click the **</>** (web) icon.
2. Nickname it "nd-flow-website" → Register app.
3. Copy the `firebaseConfig` object shown.
4. Paste those values into `firebase-config.js` at the project root, replacing the `YOUR_...` placeholders.

### 3. Turn on Email/Password sign-in
1. Build → Authentication → Get started.
2. Sign-in method tab → Email/Password → Enable → Save.

### 4. Create the one admin account
1. Authentication → Users tab → Add user.
2. Enter the business owner's email and a strong password.
3. Copy the **User UID** shown after it's created — needed in step 6.

There is no public sign-up page anywhere in this project, by design. This is the only way an account gets created — that's what keeps the dashboard private.

### 5. Create Firestore
1. Build → Firestore Database → Create database.
2. Start in **production mode**. Pick any region (ideally one close to your visitors).
3. Rules tab → replace the contents with everything in `firestore.rules` → Publish.

### 6. Add yourself to the `admins` collection
1. Firestore → Data tab → Start collection → Collection ID: `admins`.
2. Document ID: paste the **User UID** from step 4.
3. Add one field, e.g. `email` (string) = the admin's email → Save.

Skipping this is the #1 way people get stuck: login succeeds, but every gallery upload/delete fails with a permissions error — every rule in this project (gallery, storage, and later the analytics endpoint) checks membership in this collection, not just "is logged in."

### 7. Turn on Storage
1. Build → Storage → Get started → production mode.
2. **Heads up:** Firebase now requires the pay-as-you-go **Blaze plan** to use Storage at all, even at zero cost — you'll be asked to add a billing method. A small gallery stays well inside the free monthly quota (5 GB stored, 1 GB/day downloaded), so this shouldn't cost anything, but a card on file is required.
3. Rules tab → replace the contents with everything in `storage.rules` → Publish. (First time you publish rules using `firestore.exists()`, the console prompts you to enable a permission — click Enable.)

### 8. Deploy and test
Push these files to GitHub as usual — Vercel redeploys automatically. Then visit:

`https://your-site.vercel.app/admin` (redirects to the login page)

Sign in with the email/password from step 4. You should land on the Overview page, and "Gallery" in the sidebar should let you upload/view/delete photos immediately — that part works as soon as Part 1 above is done. The public gallery section on the homepage updates automatically the moment you upload or delete something, no redeploy needed.

The stat cards on Overview will say "Not connected yet" until you finish Part 2 below — that's expected, not broken.

---

## Part 2 — Analytics (GA4)

This wires up the four numbers on the Overview page: Total Visitors, Visitors Today, Visitors This Month, Page Views.

### 1. Create the GA4 property
1. Go to analytics.google.com → Admin (gear icon) → Create Property.
2. Name it, fill in the basics → Create.
3. Under "Data collection", choose **Web** → enter your site URL → Create stream.
4. Copy the **Measurement ID** (looks like `G-XXXXXXXXXX`).

### 2. Add the Measurement ID to the site
Open `index.html` and replace **both** occurrences of `G-XXXXXXXXXX` with the real Measurement ID from step 1 above.

### 3. Get the Property ID
Admin → Property Settings (top of the property column) → copy the **Property ID** — a plain number like `123456789`. This is different from the Measurement ID and is what the server needs.

### 4. Generate a service account key
1. Firebase Console → Project settings (gear icon) → Service accounts tab.
2. Generate new private key → confirm → a `.json` file downloads. Keep this private — never commit it to GitHub.

### 5. Give that service account access to GA4
1. Open the downloaded JSON file, copy the `client_email` value (looks like an email ending in `.iam.gserviceaccount.com`).
2. In GA4: Admin → Property Access Management → the blue "+" → Add users.
3. Paste that email, set role to **Viewer** → Add.

### 6. Enable the Data API
1. Go to console.cloud.google.com, make sure the project selector (top bar) shows the same project as your Firebase project.
2. APIs & Services → Library → search "Google Analytics Data API" → Enable.

### 7. Add environment variables in Vercel
Vercel project → Settings → Environment Variables → add two:

| Name | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | The entire contents of the JSON file from step 4, pasted as-is |
| `GA4_PROPERTY_ID` | The numeric Property ID from step 3 |

### 8. Redeploy
Vercel → Deployments → redeploy the latest one (or just push any small commit) so the new environment variables take effect. The Overview page should now show real numbers within a few seconds of loading.

Note: GA4 has some reporting delay (usually a few hours) — don't worry if very recent visits don't show up immediately.
