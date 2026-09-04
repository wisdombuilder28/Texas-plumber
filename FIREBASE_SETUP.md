# Setup guide — do this once

Two parts: Firebase (auth + gallery), then Analytics (GA4), optional. About 20 minutes for Part 1.
Nothing here needs a computer or a terminal — every step is done in a browser, so it
all works from your phone too.

Everything in Part 1 runs on Firebase's free **Spark** plan. No billing account, no card,
ever — gallery photos are stored as compressed image data directly inside Firestore
documents instead of Firebase Storage, specifically to avoid the billing requirement
Storage now has.

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
3. On the same tab, also enable **Anonymous**. The public "Recent Work" like buttons use a silent anonymous session so each visitor can like a photo once. If this is off, likes fail even though the rest of the site works.

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

Skipping this is the #1 way people get stuck: login succeeds, but every gallery upload/delete fails with a permissions error — every rule in this project (gallery, and later the analytics endpoint) checks membership in this collection, not just "is logged in."

### 7. Deploy and test
Push these files to GitHub as usual — Vercel redeploys automatically. Then visit:

`https://your-site.vercel.app/admin` (redirects to the login page)

Sign in with the email/password from step 4. You should land on the Overview page, and "Gallery" in the sidebar should let you upload/view/delete photos immediately — that part works as soon as steps 1-6 above are done. The public gallery section on the homepage updates automatically the moment you upload or delete something, no redeploy needed.

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
The Measurement ID is already set to `G-9LBTZMCXGV` on every public page. If you create a new GA4 property, replace **both** `G-9LBTZMCXGV` occurrences in each public HTML file (`index.html`, `about.html`, `contact.html`, `services.html`, `why-us.html`, `who-we-serve.html`, `work.html`).

### 3. Get the Property ID
Admin → Property Settings (top of the property column) → copy the **Property ID** — a plain number like `123456789`. This is different from the Measurement ID (`G-...`) and is what the server needs. Putting the G- ID here is a common reason the dashboard stays empty.

### 4. Generate a service account key
1. Firebase Console → Project settings (gear icon) → Service accounts tab.
2. Generate new private key → confirm → a `.json` file downloads. Keep this private — never commit it to GitHub.

### 5. Give that service account access to GA4
1. Open the downloaded JSON file, copy the `client_email` value (looks like an email ending in `.iam.gserviceaccount.com`).
2. In GA4: Admin → Property Access Management → the blue "+" → Add users.
3. Paste that email, set role to **Viewer** → Add.

Do **not** skip this. Without Viewer access, the API authenticates but GA4 returns permission denied.

### 6. Enable the Data API
1. Go to console.cloud.google.com, make sure the project selector (top bar) shows the same project as your Firebase project.
2. APIs & Services → Library → search "Google Analytics Data API" → Enable.

### 7. Add environment variables in Vercel
Vercel project → Settings → Environment Variables → add two (Production + Preview):

| Name | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | The entire contents of the JSON file from step 4, pasted as-is (starts with `{` and includes `"private_key"`) |
| `GA4_PROPERTY_ID` | The numeric Property ID from step 3 — digits only, no `properties/` prefix |

After saving, **redeploy**. Env vars do not apply to an already-running deployment.

### 8. Redeploy
Push these files (especially `api/analytics.js`) and wait for Vercel to finish. Then hard-refresh `/admin/dashboard.html`.

The Overview cards should show numbers. Zero is a real number — it means the API is working but GA4 has no recorded visits yet (new properties can take a few hours).

---

## If Overview still has no numbers

The dashboard talks to `/api/analytics`. A blank/error state is almost always one of these:

1. **Function crash (old code).** The previous `api/analytics.js` loaded `firebase-admin` and `@google-analytics/data` on boot and Vercel returned `FUNCTION_INVOCATION_FAILED`. The rewritten file has **no npm dependencies**. Confirm the new file is what's deployed.
2. **Wrong Property ID.** Must be the numeric ID from GA4 Property settings, not `G-9LBTZMCXGV`.
3. **Service account not a GA4 Viewer.** The `client_email` inside the JSON must be added under GA4 → Property Access Management.
4. **Analytics Data API not enabled** on the same Google Cloud project.
5. **No `admins/{yourUid}` document** in Firestore. Login can succeed and gallery can even appear to load, but the analytics endpoint will return "Admin access required".
6. **Firestore rules not republished** after updating `firestore.rules`.
7. **GA4 reporting delay.** Brand-new hits can take a few hours to appear. "Today" can stay at 0 until then.

Vercel → your project → Logs (or the failed `/api/analytics` deployment) will show the exact error string the dashboard now surfaces on the Overview page.
