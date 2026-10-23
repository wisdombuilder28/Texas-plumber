# Video setup — do this once

About 15 minutes, all in a browser, all from your phone. No bank card, no PayPal.

What you get: a **Videos** page in the admin. You pick a video from the phone, it is made smaller on the
phone, uploaded to a **private** Backblaze bucket (free 10 GB), and shown on **Recent Work**.

> **Always open the admin at `https://nd-flow-plumbing.vercel.app/admin`.**
> The storage is set up to accept uploads from that exact address and no other. Vercel's “Visit” button opens a
> different, long address (`nd-flow-plumbing-xxxx.vercel.app`) and uploads from there fail. The Videos page warns
> you in yellow when you are on the wrong address.

---

## 1. The files

Project root = the folder that has `work.html` in it.

| File | Where it goes |
|---|---|
| `api/videos.js` | `api/` folder (next to `analytics.js`) |
| `admin/videos.html`, `admin/videos.css` | `admin/` folder |
| `admin/js/videos-admin.js`, `video-upload.js`, `video-engine.bundle.js` | `admin/js/` folder (the bundle is big, about 450 KB, that's normal) |
| `videos-live.js`, `work-videos.css`, `work.html` | project root (the public Recent Work page) |
| `vercel.json`, `firestore.rules` | project root |

Push to GitHub as usual.

---

## 2. Backblaze (the free storage)

1. **backblaze.com** → B2 Cloud Storage → **Sign up**. Their sign-up page says *“No credit card required.”* Confirm your email. Turn on **two-factor verification** for this account (in **My Settings**). It holds all the videos.
2. **Buckets** → **Create a Bucket**.
   - Name: something unique, e.g. `ndflow-videos-2026`.
   - Choose **Private**. Never make it public: the site gives visitors a temporary link when they press play.
   - Leave Object Lock off → **Create a Bucket**.
   - Copy the **Endpoint** (looks like `s3.us-west-004.backblazeb2.com`).
3. **Application Keys** → **Add a New Application Key**.
   - Name: `ndflow-videos`.
   - Allow access to Bucket(s): pick **your bucket** (not “All”).
   - Access: **Read and Write**.
   - **Create New Key**, then copy the **keyID** and the **applicationKey** straight away. The applicationKey is shown **once**. If you lose it, make another key.
4. Optional but wise: **Caps & Alerts** → set a daily download cap and a daily storage cap, so a surprise can never turn into a bill.

---

## 3. Vercel — the settings

Vercel → your project → **Settings** → **Environment Variables**.

| Name | Value |
|---|---|
| `STORAGE_ENDPOINT` | the Endpoint from step 2 |
| `STORAGE_BUCKET` | the bucket name |
| `STORAGE_KEY_ID` | the keyID |
| `STORAGE_APP_KEY` | the applicationKey |

For **every** one of them (and for `FIREBASE_SERVICE_ACCOUNT_JSON`, which the Videos page also uses to check that you are the admin):

- **Environments: Production only.** Don't tick Preview or Development. Preview deployments run any branch's code, so a key given to them is a key given to every branch.
- **Switch on “Secret”** (some Vercel screens call it **Sensitive**). A Secret can never be read back, not even by you. To change one later, delete it and add it again.

Then **Deployments** → the latest one → **⋯** → **Redeploy**. New settings only work after a redeploy.

Optional settings:

- `STORAGE_CAP_GB` — a number, if you want uploads to stop at something other than 9 GB.
- `STORAGE_CORS_ORIGINS` — extra website addresses allowed to upload, separated by commas, each like `https://www.mycompany.com` (only `https://`, no path, no `*`). Needed only if the site gets its own domain and you want to upload from it. Run the one-time setup (step 6) again after changing it.

These keys live only in Vercel. Never paste them into GitHub, into a file, or into a chat.

---

## 4. Firebase — publish the rules

Firebase console → Firestore Database → **Rules** → replace everything with the `firestore.rules` file → **Publish**.

(Without this, the video uploads fine but “saving to the list” is refused, and the public page can't read the list.)

---

## 5. Test it

1. Open `https://nd-flow-plumbing.vercel.app/admin` → **Videos**.
2. Scroll to **Storage setup & test** (tap it) → **Test storage**.
3. Five green ticks = ready. Under a red line there is a grey **Details** line: screenshot it if you ever need help.

If the second-to-last line says the storage **hasn't been given permission to take uploads**, do step 6.

---

## 6. The one-time upload permission (CORS)

The browser only sends a video to Backblaze if Backblaze says “yes, that website may upload”. That is a **CORS rule** on the bucket.
Setting it needs Backblaze's **master key**, once. The master key can do everything in your account, so it never goes into the website:
it sits in two private Vercel settings, only the server reads it, and you remove it straight afterwards.

1. Backblaze → **Application Keys** → **Generate New Master Application Key**. Copy the Key ID and the Application Key (shown once).
2. Vercel → **Settings → Environment Variables** → add `B2_SETUP_MASTER_KEY_ID` and `B2_SETUP_MASTER_KEY`. **Production only, Secret on.**
3. **Redeploy.**
4. Open `https://nd-flow-plumbing.vercel.app/admin/videos.html` → **Storage setup & test** → **Configure upload permissions**.
5. It reports what it did, line by line: the rule for `https://nd-flow-plumbing.vercel.app` is saved; your other rules were kept; the bucket is still private; the storage itself confirms it accepts uploads.
6. **Right away:** delete both `B2_SETUP_…` settings in Vercel → **Redeploy** → in Backblaze tap **Generate New Master Application Key** again. That cancels the temporary key. (`STORAGE_KEY_ID` and `STORAGE_APP_KEY` are not affected.)
7. **Test storage** again.

The page keeps a yellow warning on top until the `B2_SETUP_…` settings are gone.

What the setup does and doesn't do:

- It adds **one** rule, named `nd-flow-browser-upload`, allowing uploads (`PUT`) and playback (`GET`) from your website address only.
- It keeps every other CORS rule you have, and never touches cleanup (lifecycle) rules or whether the bucket is public. If a cleanup rule would hide your videos after some days, it tells you.
- Running it twice changes nothing the second time.
- The browser never receives the key, and the server refuses any request that tries to send one.

---

## 7. If something goes wrong

The page explains most problems itself. The usual ones:

| What it says | What it means | What to do |
|---|---|---|
| *“isn't set up yet”* | A Vercel setting is missing, or you didn't redeploy | Check the four settings (step 3), redeploy |
| *“didn't accept the key”* | keyID or applicationKey copied wrongly | Copy them again, or make a new key |
| *“isn't allowed to do that”* | The key is for another bucket, or not Read and Write | Make a new key for your bucket (step 2.3) |
| *“can't find that bucket”* | `STORAGE_BUCKET` is spelled differently from the real name | Fix it in Vercel, redeploy |
| *“hasn't been given permission to take uploads from …”* | The CORS rule from step 6 is missing | Do step 6 |
| *“This page is open at …, but videos can only be uploaded from …”* | You opened the admin from the wrong address | Open `https://nd-flow-plumbing.vercel.app/admin` |
| *“The storage does accept this website, so the problem is your signal”* | The phone lost the connection | Switch Wi-Fi ↔ mobile data, turn off VPN / private DNS / ad-blocker, tap **Try again**. Nothing is re-sent that already arrived |
| *“couldn't read the video file any more”* | Android took back access to the file | Tap **Remove**, pick the video again |
| *“The phone's video encoder stopped…”* | This phone's encoder failed twice | Pick **480p** or **Smaller**, or re-save the video in CapCut first |
| *“isn't allowed to change bucket settings”* | A normal app key was put in the `B2_SETUP_…` settings | Use the **master** key (step 6.1) |
| *“didn't accept the setup key stored in Vercel”* | Master key copied wrongly, or already replaced | Generate a new master key, put both values in again, redeploy |
| *“This account isn't an admin”* | No `admins/{your uid}` entry in Firestore | Part 1, step 6 of `FIREBASE_SETUP.md` |
| *“Your session expired”* | Signed out | Refresh and sign in again |

After you change anything in Vercel, redeploy again.

---

## 8. Security checklist

Tick these once. They are what keeps the videos, the storage and the admin safe.

- [ ] The admin has a strong, unique password, and only **one** document sits in the Firestore `admins` collection (yours).
- [ ] Backblaze account: two-factor verification on; Caps & Alerts set.
- [ ] The bucket is **Private** (the setup warns you if it isn't).
- [ ] `STORAGE_*` and `FIREBASE_SERVICE_ACCOUNT_JSON` are **Production only** and **Secret**.
- [ ] No `B2_SETUP_…` settings in Vercel, and the Backblaze master key was regenerated after the setup.
- [ ] The latest `firestore.rules` is published (the Rules tab in Firebase Firestore shows the `videos` section).
- [ ] You always use `https://nd-flow-plumbing.vercel.app/admin`.

Good to know:

- **Who can do what.** Only someone signed in as the admin (checked on the server, against the `admins` list) can upload or delete. Anyone can *watch* a video on Recent Work: when someone presses play, the server hands out a temporary link (valid for hours). That is by design.
- **Keys are 24 random characters** and are never listed publicly, but a link that was shared can be opened by whoever has it until it expires. Videos you don't want public shouldn't be posted.
- **The service account** in `FIREBASE_SERVICE_ACCOUNT_JSON` is powerful if it is the default Firebase one. Keeping it Production-only and Secret is the main protection. For extra care, create a separate service account with only “Cloud Datastore Viewer” and GA4 “Viewer”.

---

## 9. Post the first video

**Videos** → **Add a video** → pick one from the phone → give it a title → **Make it smaller** → check it → **Upload and post**.

Keep the screen on and stay on the page while it works. A 5–10 minute video takes a few minutes to shrink and then to upload, depending on the phone and the network.

If you upload a video **as it is** (the option under “Picture size and quality”), the phone's hidden details stay inside the file, including where it was filmed. Making it smaller removes them.

---

## 10. If a visitor says a video won't play

The grey box on the video now says what went wrong, and ends with a small code like `(error 4)`. Ask the visitor to read you the message or send a screenshot, and ask which phone and browser they use.

| What it says | What it means | What to do |
|---|---|---|
| *“Your device couldn't reach the video server…”* | Their phone or computer can't connect to the storage: weak or blocked network, private DNS, VPN, data saver, ad-blocker | Switch Wi-Fi ↔ mobile data, turn off VPN / private DNS / ad-blocker, tap **Try again** |
| *“The connection dropped while the video was loading…”* | The signal dropped part-way | Tap **Try again** |
| *“This video couldn't be played right now…”* | The storage answered, but the phone couldn't play the video (a format that phone can't play), or Backblaze is refusing downloads | Open the page in Chrome. Check Backblaze **Caps & Alerts**: if the daily download limit was reached, downloads stop until it resets. If only one phone fails, write down the phone model, the browser and the code |
| *“This video couldn't load. Please tap Try again.”* | Our own server didn't hand out the video link | Tap **Try again**. If it keeps happening, look at Vercel → **Logs** for `/api/videos` |

The page tries up to three links by itself before it shows a message, so a message means it really did fail more than once.

A phone that visited before gets the newest version of the site on its next visit: open the site, wait a few seconds, then reload once before testing again. The site's offline helper (`sw.js`) never touches videos: they stream straight from the storage.

---

## Good to know

- **Space.** Backblaze gives 10 GB free. The page stops accepting uploads at 9 GB so it never hits the wall. On the normal setting (720p, Balanced) a video takes about 16 MB per minute: roughly 80 MB for 5 minutes, 160 MB for 10 minutes. Choosing **Smaller** quality stretches it by about a third. When it gets close, delete old videos on the Videos page (it really frees the space).
- **Free downloads.** Backblaze gives free downloads up to 3 times what's stored, per month.
- **Limits.** Each video can be up to 12 minutes and 400 MB *after* shrinking. The original on the phone can be up to 4 GB.
- **Picture sizes.** Phones' video encoders like sizes that are a multiple of 16, so the smaller copy is rounded to that (for example 854×480 becomes 848×480). Nobody can see the difference.
- **If the phone's MP4 encoder fails**, the page says “Trying another way…” and makes a WebM copy instead. WebM plays in Chrome, Edge, Firefox and on Android; some older iPhones may not play it.
- **The video player (Recent Work page).** Tapping a video opens it full screen. Swipe left or right (or use the arrow keys / on-screen arrows on a computer) to play the next or previous video; tap the video to pause. The title and description sit over the bottom of the picture, and long descriptions open with **Read more**. The player only loads the video on screen and the one next to it, and starts loading the next one after the current one is playing smoothly, so a slow connection is never shared between two videos.
- **How fast a video starts.** The page asks for each play link before the tap, shows the cover picture instantly and starts the video the moment the link is in hand. After that the speed is the visitor's connection to Backblaze, and the file size matters most: **Smaller** quality (or 480p) starts noticeably faster on a weak connection than 720p / 1080p. Videos shrunk on the Videos page are saved with their index at the front of the file, which lets them start before they have fully downloaded; a video uploaded with the "as is" option keeps whatever layout the phone gave it.
- **Whose account.** The videos sit in the Backblaze account you create here. If the client later wants it moved to his own account, it's the same settings in Vercel (existing videos would have to be moved across).
