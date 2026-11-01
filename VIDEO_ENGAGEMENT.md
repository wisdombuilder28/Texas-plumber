# Video likes and Views — how it works, how to switch it on

What visitors get on **Recent Work → Videos**, on every video card and in the full-screen player:

- a **heart with a count** ("♡ 24 likes"). Tap to like, tap again to un-like. It stays after a refresh.
- an **eye with a count** ("👁 186 views"). The label is **Views**.

What you get on **Admin → Videos**: each video card shows its title, its **likes** and its **views**. (This is separate from the
Google Analytics numbers on the Overview page; nothing there was touched.)

No comments, followers, profiles or lists of who liked or watched. Nobody is asked to log in.

---

## 1. Switching it on (about 5 minutes)

Do these in order. Nothing else needs setting up: **there are no new Vercel settings.**

1. **Publish the new rules first.** Firebase console → Firestore Database → **Rules** → replace everything with the `firestore.rules`
   file from this project → **Publish**. (Everything that was allowed before is still allowed; the file only adds the `likes` and
   `views` parts and protects `viewCount`. The changed part is the `match /videos/{videoId}` block.)
2. **Anonymous sign-in must be on** (it already is if the image likes work): Firebase console → Authentication → Sign-in method →
   **Anonymous** → Enabled.
3. **The server key must be allowed to *write* to Firestore.** Views are saved by `api/engagement.js` using the
   `FIREBASE_SERVICE_ACCOUNT_JSON` that is already in Vercel. The default Firebase key (the one `FIREBASE_SETUP.md` tells you to
   generate) can write, so usually there is nothing to do. **Only if** you made a read-only account for extra safety (the optional tip
   in `VIDEO_SETUP.md` section 8): Google Cloud console → IAM → find the `client_email` from that JSON → pencil icon → **Add role →
   Cloud Datastore User** → Save. (Viewer is not enough: saving a view is a write.) The key must belong to the same Firebase
   project as the website (`n-d-flow-plumbing`).
4. **Deploy** the project (push to GitHub, Vercel redeploys). Existing videos need no changes: a video that has never been watched
   simply shows "0 views".

If you ever need to undo it: redeploy the previous Vercel deployment and publish your old rules. The numbers already saved are
harmless and are picked up again if you switch it back on.

### Check it on a real phone (10 minutes, please do this once)

Use a **private/incognito tab** so you are a brand-new visitor.

1. Recent Work → Videos: every card shows ♡ and 👁 with numbers.
2. Tap ♡: it turns red and the count goes up by 1. Refresh: still red, same count. Tap again: back to normal, count down by 1.
3. Open a video and let it play **at least 6 seconds**. The Views number goes up by 1. Close it, play it again, refresh the page,
   play again: it must **not** go up again.
4. Firebase console → Firestore → `videos` → that video: a number field `viewCount` = 1, and sub-collections `views` (one entry) and,
   if you liked it, `likes` (one entry).
5. Admin → Videos: the same likes and views show on the card. Tap **Refresh** after liking something to update the likes.
6. Recent Work → **Images**: the heart there still works. Admin → Overview still shows its numbers.
7. Pause a video before 5 seconds, or open it and switch to another app/tab: no view is added.

If step 3 never adds a view, see "If something doesn't work" below.

### Rules Playground checks (optional, 5 minutes)

Firebase console → Firestore → Rules → **Rules Playground**. These all use a video that exists, `VID`, and a signed-in (anonymous)
user `U1`. The tool can't produce a "server time" value, so a successful like can't be simulated here; the phone test above covers it.

| Try this | Expected |
|---|---|
| `get` `/videos/VID/likes/U1`, not signed in | **Allowed** (anyone can read a like) |
| `create` `/videos/VID/likes/SOMEONE_ELSE`, signed in as `U1` | **Denied** (can only like as yourself) |
| `create` `/videos/VID/likes/U1`, not signed in | **Denied** |
| `update` `/videos/VID/likes/U1`, signed in as `U1` | **Denied** (no edits to a like) |
| `delete` `/videos/VID/likes/SOMEONE_ELSE`, signed in as `U1` | **Denied** |
| `delete` `/videos/VID/likes/U1`, signed in as `U1` | **Allowed** (un-like) |
| `get` or `create` `/videos/VID/views/U1`, signed in as `U1` or as the admin | **Denied** (only the server touches these) |
| `update` `/videos/VID` as the admin, changing `viewCount` | **Denied** |
| `update` `/videos/VID` as the admin, changing only `title` | **Allowed**, as before |

---

## 2. How it works

```
 visitor's phone                              Vercel                          Firebase (free Spark plan)
 ───────────────                              ──────                          ──────────────────────────
 Anonymous sign-in (same as images) ─────────────────────────────────────────▶ Auth: one UID per browser
 ♡ tap ── Firestore transaction ─────────────────────────────────────────────▶ videos/{id}/likes/{UID}
 ♡ count ── count query ─────────────────────────────────────────────────────▶ (counts those documents)
 ▶ 5 seconds really watched ── POST /api/engagement (visitor's login token) ─▶ api/engagement.js ──▶ videos/{id}.viewCount
                                                                                                      videos/{id}/views/{UID}
```

**Likes** follow the image-gallery design exactly (see `work-live.js`, and `gallery/{id}/likes` in the rules):

- A like is one small document at `videos/{videoId}/likes/{visitor's UID}`. Because the document name *is* the UID, Firestore
  itself refuses a second like from the same visitor, and nobody can like as somebody else. Un-liking deletes the document.
- The number shown is how many of those documents exist (a count query, about one read however many likes). There is no stored
  counter, so there is nothing to tamper with and nothing that can drift or go wrong when two people tap at once.
- A tap runs as one Firestore transaction that decides from what the database says, not from what the button shows. A double
  tap, or the same visitor in two tabs, can only ever end as "liked" or "not liked". The button changes at once and the real count
  replaces the guess when the database answers. If saving fails, the button goes back and says so; while the count is loading it
  shows "–", and if it can't load, a tap tries again instead of liking.

**Views** are counted by the server, in `api/engagement.js`, because "once per visitor per 24 hours" can't be left to the browser:

- The browser (`video-engagement-live.js`) adds up only *real, visible playback*: the video is actually playing (not paused,
  buffering, seeking or finished), has its picture, and the tab is visible. Seeks add nothing and each stretch is credited the
  smaller of clock time and video time moved. At **5 seconds** it sends one request with the visitor's login token. Opening a video,
  a cover picture loading, a paused or failed video, or a video in a background tab never counts.
- The server checks the login token (Google's signature, project, expiry), takes the visitor's UID **from the token only**, and in
  **one atomic Firestore write** both records "this visitor watched at time T" (`views/{UID}`) and adds 1 to `viewCount`. The
  write is conditional, so ten requests at once from the same visitor still add exactly one, and thirty different visitors at
  once add exactly thirty. Within 24 hours of the last counted view the answer is "not counted"; after 24 hours the same visitor
  counts again. The server's clock decides, never the browser's.
- Visitors' browsers can't change `viewCount` at all (not even the admin's), and can't read or write `views`. The server key lives
  only in Vercel; no secret is in any page.
- The browser also remembers (in `localStorage`, key `ndf-video-views-v1`) when the next view is due, so a refresh or a replay
  doesn't even ask. That is only a shortcut; the server enforces the rule.
- A failed request never touches playback. Temporary failures are retried quietly (after 15 s, then 45 s); answers that won't
  change ("no such video", "not set up") are not retried.
- `videos-live.js` loads the likes/views script on its own. If it can't load, the video list and player work exactly as before,
  just without the heart and the number.

The existing Google Analytics event `work_video_play` is unchanged. It measures plays for analytics; the public **Views** number is
a stricter count (5 s, visible, once per visitor per day), so the two numbers will differ.

**Cost on the free plan.** A card reads its like count only when it scrolls near the screen: about 2 reads per card (the count and
"did I like it") and counts are reused for a minute. Each counted view is 2 writes. Firebase's free daily allowance is 50,000
reads and 20,000 writes, far above what a local business site will use. Videos load six at a time, as before.

### What is stored

| Where | Fields | Written by |
|---|---|---|
| `videos/{id}` (existing document) | **new:** `viewCount` (whole number; absent until the first view) | only `api/engagement.js` |
| `videos/{id}/likes/{UID}` **(new)** | `likedAt` (time) | the visitor, only their own |
| `videos/{id}/views/{UID}` **(new)** | `count`, `firstViewedAt`, `lastViewedAt` | only `api/engagement.js`; closed to browsers |

### Files

New: `video-engagement-live.js` (likes + view timing in the browser), `api/engagement.js` (the Views endpoint),
`VIDEO_ENGAGEMENT.md`, `tests/` (automated tests, not part of the website), `.vercelignore` (asks Vercel to leave `tests/` out of the deployment; harmless if it doesn't).
Changed: `firestore.rules` (the `videos` block only), `videos-live.js` (additions only), `work-videos.css` and `work-videos.html`
(styles + cache number), `admin/videos.html`, `admin/js/videos-admin.js`, `admin/videos.css` (the stats), `vercel.json` (a 10-second
limit for the new function), `package.json` (test commands only; no dependencies).
Unchanged: the image gallery and its likes, `storage.rules`, `api/videos.js` (uploads and playback), `api/analytics.js` and the
dashboard, `sw.js`, `styles.css`, `firebase-config.js`.

---

## 3. If something doesn't work

| What you see | Most likely cause |
|---|---|
| The count shows "–" with a dashed outline and never loads | The new rules aren't published yet, or the phone is offline. Publish the rules; tap the button to retry. |
| Tapping ♡ shows "Couldn't save that" | Rules not published, **Anonymous** sign-in switched off, or no connection. |
| Views never go up | Open `https://nd-flow-plumbing.vercel.app/api/engagement` in a browser. It should answer `Use POST.` (status 405): then the function is deployed. If it is a 404, redeploy. Then look in Vercel → Logs for `/api/engagement`: **501** = `FIREBASE_SERVICE_ACCOUNT_JSON` is missing, **500 store_denied** = step 3 above (the key can't write), **401** = the key belongs to a different Firebase project than the website. |
| Views go up by 1, then not again | That is the rule: once per visitor per video per 24 hours. Use a private tab (a new visitor) to test again. |
| The admin page shows "– likes" | The like count couldn't be read: check the rules, then tap **Refresh**. |

---

## 4. The tests

Automated tests are in `tests/`. They run on a developer's computer, never on the website.

- `npm test` runs `tests/engagement.test.js`: the Views endpoint against a faithful stand-in for Google (real signature checks;
  atomic conditional writes), covering counting, the 24-hour boundary, many visitors and many simultaneous requests, lost
  responses, forged and expired logins, bad input, Google/Firestore failures, and that no secret ever appears in a response or log.
- `npm run test:browser` runs `tests/e2e/run.js`: real Chromium on the real pages with a real playing video and the real
  endpoint: likes (like, unlike, refresh, several visitors, double taps, two tabs, failures, slow connection), views (5 seconds,
  pausing, seeking, hidden tab, refresh and replay, 24 hours, several visitors, failed video, failing server), the admin stats, and
  that the video player, the image likes and the page without the new script still work. It needs Playwright with Chromium and
  ffmpeg (it says so if they are missing).

**What these do not prove:** they never evaluate `firestore.rules` (Firebase's Rules Playground and the phone test above do), they
run against stand-ins for Firebase and Google rather than your real project, and they say nothing about real phones, real networks or
Backblaze.

## 5. Honest limits

- **Anonymous means resettable.** Clearing the browser's data, or a private tab, makes a new visitor who can like once and add a
  view once a day. That stops accidental and casual inflation, not a determined person on purpose. If that ever matters, the next
  step is Firebase **App Check** (a separate service to set up).
- **The 5-second rule is checked by the browser.** The server enforces the login and "once per 24 hours", but can't see the video
  being watched, so someone calling the endpoint directly could skip the watching (still only once per anonymous identity per day).
- **Totals are read when the page opens** (plus the visitor's own like or view at once). Other people's likes and views show on the
  next visit; there are no live listeners, which keeps reads low.
- **Your own watching counts.** An admin signed in on the public site is a visitor like any other (once a day per video).
- **Deleting a video** from the admin removes the video, but Firestore keeps its small `likes` and `views` entries (they are
  unreachable and tiny). They can be removed in the Firebase console if you like.
- Like documents are publicly readable and named after anonymous UIDs, exactly like the image likes. No names or personal details
  are stored anywhere.

## 6. For whoever maintains this

- Thresholds: `VIEW_SECONDS` in `video-engagement-live.js` (5 s); the 24 hours is `VIEW_WINDOW_MS` in `api/engagement.js` (the server's
  rule). Change both consistently with this guide.
- Keep `firestore.rules` (the `videos` block) in sync with `video-engagement-live.js` (a like is exactly `{likedAt: request.time}`).
- The admin page never writes `viewCount` (it edits titles/captions with `updateDoc`); the rules refuse it anyway. If a future change
  saves a whole video document again with `setDoc`, make sure it keeps `viewCount`.
