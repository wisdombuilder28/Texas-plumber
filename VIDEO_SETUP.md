# Video setup — do this once

About 15 minutes, all in a browser, all from your phone. No bank card, no PayPal.

What you get: a **Videos** page in the admin. You pick a video from the phone, it is made smaller on the
phone, uploaded to Backblaze (free 10 GB), and shown on **Recent Work**. The client never has to touch anything.

---

## 1. Put the files in the project

Project root = the folder that has `work.html` in it.

| File | Where it goes | What to do |
|---|---|---|
| `videos-live.js` | project root | new file |
| `work-videos.css` | project root | new file |
| `work.html` | project root | **replace** the old one |
| `vercel.json` | project root | **replace** the old one |
| `firestore.rules` | project root | **replace** the old one (and publish it, step 4) |
| `videos.js` | `api/` folder | new file (next to `analytics.js`) |
| `videos.html` | `admin/` folder | new file |
| `videos.css` | `admin/` folder | new file |
| `dashboard.html` | `admin/` folder | **replace** the old one |
| `gallery.html` | `admin/` folder | **replace** the old one |
| `videos-admin.js` | `admin/js/` folder | new file |
| `video-upload.js` | `admin/js/` folder | new file |
| `video-engine.bundle.js` | `admin/js/` folder | new file (big, about 450 KB, that's normal) |

Also **delete** `admin/video-test.html` (the old test page). It is not behind the login.

Push to GitHub as usual. Don't test yet: do steps 2 to 4 first.

---

## 2. Backblaze (the free storage)

1. Go to **backblaze.com** → B2 Cloud Storage → **Sign up**. Email and password. Their sign-up page says
   *"No credit card required."* Confirm your email.
2. **Buckets** → **Create a Bucket**.
   - Name: something unique, e.g. `ndflow-videos-2026` (small letters, numbers, dashes).
   - Choose **Private**. (Private is what keeps the videos from being scraped; the site gives visitors a temporary link when they press play.)
   - Leave Object Lock off → **Create a Bucket**.
   - On the bucket, copy the **Endpoint** (looks like `s3.us-west-004.backblazeb2.com`).
3. **Application Keys** → **Add a New Application Key**.
   - Name: `ndflow-videos`
   - Allow Access to Bucket(s): pick **your bucket** (not "All").
   - Access: **Read and Write**.
   - **Create New Key**, then copy the **keyID** and the **applicationKey** straight away.
     The applicationKey is shown **once**. If you lose it, just make another key.
   - If Backblaze says you must generate the *Master Application Key* first, do that, then come back to this step.

---

## 3. Vercel — four settings

Vercel → your project → **Settings** → **Environment Variables**. Add these four (all environments):

| Name | Value |
|---|---|
| `STORAGE_ENDPOINT` | the Endpoint from step 2 |
| `STORAGE_BUCKET` | the bucket name |
| `STORAGE_KEY_ID` | the keyID |
| `STORAGE_APP_KEY` | the applicationKey |

Then **Deployments** → the latest one → **⋯** → **Redeploy**. (New settings only work after a redeploy.)

These keys live only in Vercel. Never paste them into GitHub, into a file, or into a chat.

Optional: `STORAGE_CAP_GB` = a number, if you want uploads to stop at something other than 9 GB.

**Already there, nothing to add:** the Videos page also uses `FIREBASE_SERVICE_ACCOUNT_JSON` (the same setting your dashboard's visitor numbers use) to check that you are the admin. If your dashboard shows numbers, this is already set. If the Videos page ever says *"FIREBASE_SERVICE_ACCOUNT_JSON is missing or invalid"*, that is the one to fix (Part 2, steps 4 and 7 in `FIREBASE_SETUP.md`).

---

## 4. Firebase — publish the new rules

Firebase console → Firestore Database → **Rules** → replace everything with the new `firestore.rules` → **Publish**.

(Same as Part 1, step 5 in `FIREBASE_SETUP.md`. Without this, the video uploads fine but "saving to the list" is refused.)

---

## 5. Test it

1. Open `/admin` → **Videos**.
2. Scroll down to **Storage setup & test** (tap it to open it) → **Test storage**.
3. All green ticks = ready.

**If the test says uploads are blocked** (the browser isn't allowed to send files to Backblaze yet), do the one-time fix in the box underneath:

1. Backblaze → **Application Keys** → **Master Application Key** → **Generate New Master Application Key** → **Yes! Generate Master Key**. Copy the key ID and the key.
2. Paste them into the two boxes on the Videos page → **Turn on uploads**. (They're used once, never saved, and the boxes are wiped afterwards.)
3. Back in Backblaze, generate a **new** master key again. That makes the one you pasted useless.
4. Press **Test storage** again.

**If the test says something else**, it tells you what to check. The usual ones:
- *"isn't set up yet"* → one of the four Vercel settings is missing, or you didn't redeploy.
- *"didn't accept the key"* → the keyID or applicationKey was copied wrongly. Copy them again (or make a new key).
- *"isn't allowed to do that"* → the key was made for a different bucket, or without Read and Write. Make a new key for your bucket (step 2.3).
- *"can't find that bucket"* → `STORAGE_BUCKET` in Vercel is spelled differently from the real bucket name.
- *"This account isn't an admin"* → the login you used has no entry in the `admins` collection (Part 1, step 6 in `FIREBASE_SETUP.md`).
- *"Your session expired"* → refresh the page and sign in again.

After you change anything in Vercel, redeploy again.

---

## 6. Post the first video

**Videos** → **Add a video** → pick one from the phone → give it a title → **Make it smaller** → check it → **Upload and post**.

Keep the screen open and on the page while it works. A 5–10 minute video takes a few minutes to shrink and then to upload, depending on the phone and the network.

---

## Good to know

- **Space.** Backblaze gives 10 GB free. The page stops accepting uploads at 9 GB so it never hits the wall. On the normal setting (720p, Balanced) a video takes about 16 MB per minute: roughly 80 MB for 5 minutes, 160 MB for 10 minutes. At 3–7 videos a week the free space lasts somewhere between 2 and 9 months (about 3 to 4 months for five 7-minute videos a week). Choosing **Smaller** quality stretches it by about a third. When it gets close, delete old videos on the Videos page (it really frees the space).
- **Free downloads.** Backblaze gives free downloads up to 3 times what's stored, per month.
- **Limits.** Each video can be up to 12 minutes and 400 MB *after* shrinking. The original on the phone can be up to 4 GB.
- **Who can upload.** Only someone logged into the admin.
- **Whose account.** The videos sit in the Backblaze account you create here. If the client later wants it moved to his own account, it's the same four settings in Vercel (a different storage account can be swapped in the same way; existing videos would have to be moved across).
