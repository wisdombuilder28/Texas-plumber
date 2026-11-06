# Video likes and Views — how it works, how to switch it on, how to measure it

What visitors get on **Recent Work → Videos**, on every video card and in the full-screen player:

- a **heart with a count** ("♡ 24 likes"). Tap to like, tap again to un-like. It stays after a refresh.
- an **eye with a count** ("👁 186 views"). The label is **Views**.

What you get on **Admin → Videos**: each video card shows its title, its **likes** and its **views**. (This is separate from the
Google Analytics numbers on the Overview page; nothing there was touched.)

No comments, followers, profiles or lists of who liked or watched. Nobody is asked to log in.

**In this file:** 1 Updating (this round) · 2 First-time setup · 3 How it works · 4 Speed and timing · 5 What is stored ·
6 Files · 7 If something doesn't work · 8 The tests · 9 Honest limits · 10 For whoever maintains this

---

## 1. Updating a site that already has likes and views (this round)

**Nothing new to set up.**

- **Firestore rules:** unchanged. `firestore.rules` in this project is byte-for-byte the file you already published.
- **Vercel:** no new settings, no new environment variables. `vercel.json` is unchanged.
- **Firebase:** nothing. Anonymous sign-in simply stays on.

Deploy as always (push to GitHub, Vercel redeploys). Phones get the new version on their next visit: the service worker loads pages,
scripts and styles from the network first, and the `*-live.js` files are never cached.

To undo this round: redeploy the previous Vercel deployment. No stored data changes shape, so the older version reads everything fine.

### What this round changes

- **Likes.** The heart answers the instant it is touched. The button is never locked: not while the count loads, and not while a
  like is being saved. The slow part (the save) happens behind the scenes, and the true count is read again in the background.
- **Views.** The slow steps now happen *before* the 5th second (the visitor's login token and a "wake-up" of the server), steps
  that don't depend on each other run side by side, a first-time visitor skips a read, and the Views number shows a faint "+1" the
  moment the 5 seconds are up while the server confirms it. Nothing about *what counts* changed (see section 3).
- **Mobile full-screen player.** One compact caption block (label, title, two-line description with Read more, one like/view
  capsule), kept clear of the seek bar (section 3).
- **Timing is built in.** Every step that can make a like or a view feel slow is timed, safely (section 4).
- **Tests.** The `tests/` folder the project refers to is back and extended: 74 server tests and 62 browser tests (section 8).

### Check it on a real phone (10 minutes, please do this once)

Use a **private/incognito tab** so you are a brand-new visitor. Do it on the phone your visitors use most (and on an iPhone if you
can: Safari behaves a little differently from Chrome, and these tests could only imitate it).

1. **Recent Work → Videos.** Tap a heart as soon as the cards appear. It must turn red **at once** and the count must go up by 1.
   Refresh: still red, same count. Tap again: back to normal, count down by 1.
2. **Quick double tap** (like, then un-like a moment later). It must end in the state of the *last* tap.
3. **Switch on airplane mode and tap a heart.** It turns red, then goes back within about 12 seconds with "Couldn't save that. Check
   your connection and try again." The button must never become stuck or greyed out. Switch airplane mode off, tap again: it saves.
4. **Open a video and let it play.** At 5 seconds of real playing the Views number shows +1 (slightly faded for a moment, then
   solid). Close it, play it again, refresh and play again: the number must **not** go up again.
5. **Full-screen player.** Check that the label, title, description (with Read more / Show less) and the like/view capsule sit
   above the seek bar and never cover it; swipe to the next video; seek; change speed; mute; close. Turn the phone sideways.
6. **Timing panel.** Add `?timing=1` to the Videos page address and play a video for 6+ seconds. Read section 4 and keep a screenshot of
   the panel; it is the real measurement of your site.
7. Firebase console → Firestore → `videos` → that video: `viewCount` = 1 higher, a `views` entry, and (if you liked it) a `likes` entry.
8. **Admin → Videos** shows the same likes and views (tap **Refresh** after liking something). **Recent Work → Images**: the heart
   there still works. Admin → Overview still shows its numbers.
9. Pause a video before 5 seconds, or open it and switch to another app/tab: no view is added.

---

## 2. First-time setup (only if likes and views were never switched on)

Do these in order. Nothing else needs setting up: **there are no new Vercel settings.**

1. **Publish the rules first.** Firebase console → Firestore Database → **Rules** → replace everything with the `firestore.rules`
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

## 3. How it works

```
 visitor's phone                              Vercel                          Firebase (free Spark plan)
 ───────────────                              ──────                          ──────────────────────────
 page opens: anonymous sign-in + login token ready ───────────────────────────▶ Auth: one UID per browser
 ♡ tap ── Firestore transaction ─────────────────────────────────────────────▶ videos/{id}/likes/{UID}
 ♡ count ── count query (background, after a save) ──────────────────────────▶ (counts those documents)
 video opens ── POST /api/engagement {"action":"warm"} ─▶ api/engagement.js   (touches no Firebase data)
 ▶ 5 seconds really watched ── POST /api/engagement {"action":"view"} ─▶ api/engagement.js ──▶ videos/{id}.viewCount
                                                                                                videos/{id}/views/{UID}
```

### Likes

Same design as the image gallery (see `work-live.js`, and `gallery/{id}/likes` in the rules):

- A like is one small document at `videos/{videoId}/likes/{visitor's UID}`. Because the document name *is* the UID, Firestore itself
  refuses a second like from the same visitor, and nobody can like as somebody else. Un-liking deletes the document. The rules are
  unchanged: exactly one like document per visitor per video.
- The number shown is how many of those documents exist (a count query, about one read however many likes). There is no stored
  counter, so there is nothing to tamper with and nothing that can drift when two people tap at once.
- **A tap shows at once.** The heart and the number change before anything has been sent. The save then runs as one Firestore
  transaction that decides from what the database says, not from what the button shows, so a double tap, or the same visitor in two
  tabs, can only ever end as "liked" or "not liked".
- **The button is never locked.** Tap again while a save is running and the *latest* tap wins (the save catches up to it; one save at
  a time, never a pile-up).
- **The real count comes back in the background.** After a save, the count is read again, but nothing waits for it. A read that was
  already on its way when the visitor tapped again is thrown away, so a late answer can never overwrite a newer tap.
- **Failure puts things back.** If saving fails (offline, refused, or no answer within 12 seconds), the heart and the number go back
  to what the database holds and a short message appears for 5 seconds. A save that was given up on can never write afterwards, and
  about 1.5 seconds later the page reads the truth again (in case it landed after all) and corrects the heart.
- **No waiting at the start.** The visitor's anonymous sign-in starts the moment the page loads, and the count and "did I like it"
  are read at the same time, not one after the other. A card reads them only when it scrolls near the screen; counts are reused for a
  minute.
- **One deliberate detail:** if a heart is tapped *before* the count has ever loaded, the heart fills at once but the number appears when
  the save has finished and the real count has been read (about three round trips to the database in a row). That avoids showing a
  number that is off by one.

### Views

Counted by the server (`api/engagement.js`), because "once per visitor per 24 hours" can't be left to the browser. **The rules are
exactly the ones from before:**

- The browser (`video-engagement-live.js`) adds up only *real, visible playback*: the video is actually playing (not paused,
  buffering, seeking or finished), has its picture, and the tab is visible. Seeks add nothing and each stretch is credited the smaller
  of clock time and video time moved. At **5 seconds** it sends one request with the visitor's login token. Opening a video, a cover
  picture loading, a paused or failed video, or a video in a background tab never counts.
- The server checks the login token (Google's signature, project, expiry), takes the visitor's UID **from the token only**, and in
  **one atomic Firestore write** both records "this visitor watched at time T" (`views/{UID}`) and adds 1 to `viewCount`. The write is
  conditional, so ten requests at once from the same visitor still add exactly one, and thirty different visitors at once add exactly
  thirty. Within 24 hours of the last counted view the answer is "not counted"; after 24 hours the same visitor counts again. The
  server's clock decides, never the browser's.
- Visitors' browsers can't change `viewCount` at all (not even the admin's), and can't read or write `views`. The server key lives
  only in Vercel; no secret is in any page.
- The browser also remembers (in `localStorage`, key `ndf-video-views-v1`) when the next view is due, so a refresh or a replay doesn't
  even ask. That is only a shortcut; the server enforces the rule.

**What is different now is the order of events, so the slow parts are out of the way before the 5 seconds are up:**

1. *Page opens:* the anonymous sign-in and the visitor's login token are prepared straight away.
2. *A video opens in the player:* the page sends `{"action":"warm"}` (at most once every 4 minutes, and not if this browser already
   knows the next view isn't due). It counts nothing and touches no Firebase data. Its only job is to make the server instance start up,
   fetch Google's certificates and sign itself in to Google, so that is done before it matters.
3. *5 seconds of real playing:* the number shows **+1 right away**, faded ("updating"), and the real request goes out. It is one short
   request, because the login token, the server and the connection are already prepared.
4. *The server's answer arrives:* the faded +1 becomes the server's real total. If the server says **"not counted"** (this visitor
   already has a view in the last 24 hours) or the request **fails**, the +1 is taken back. An unsuccessful view is never left
   looking like a counted one. Temporary failures are retried quietly (after 15 s, then 45 s); answers that won't change (400, 401,
   404, 405, 413, 501) are not retried. A failed request never touches playback.
5. *On the server* (`api/engagement.js`): check the login → fetch Google's certificates and make the server's own Google sign-in **at
   the same time**, and only if the instance doesn't already hold them → for a first-time visitor, **one write that is only allowed
   if the visitor's record doesn't exist yet** (no read first); for anybody else, read the record, then one atomic write.
   If two requests collide, it looks again and retries (up to 4 times).

About the **"returning" hint:** if this browser has counted this video before, the request carries `"returning": true`, and the server
reads the visitor's record first instead of trying the write first. It only changes the *order* of the steps. The decision, the
protections and the answer are identical whether the hint is sent, missing or wrong (only the literal `true` is believed).

The existing Google Analytics event `work_video_play` is unchanged. It measures plays for analytics; the public **Views** number is a
stricter count (5 s, visible, once per visitor per day), so the two numbers will differ.

**Cost on the free plan.** A card reads its like count only when it scrolls near the screen: about 2 reads per card. After a like is
saved there is one more count read (in the background). Each counted view is 2 writes; a first-time visitor's view needs no read first;
the `warm` request touches no Firebase data at all. It is one extra very short run of the server function per visitor per few minutes
of watching; if the site ever grows to thousands of visitors a day, keep an eye on Vercel's usage page. Firebase's free daily
allowance is 50,000 reads and 20,000 writes, far above what a local business site will use.

### The full-screen player on a phone

Over the video, bottom-left, on a soft dark fade:

- a small **label** (category · date), the **title** (clear, but not the loudest thing on screen), and a **two-line description**
  that ends in **Read more** / **Show less**. An opened description scrolls inside its own area.
- **one capsule** with ♥ count and 👁 count in a translucent dark pill. Only the heart is tappable (the capsule is 36 px tall but the
  touch area is about 49 px). The eye is information only. On phones the capsule shows numbers only (screen readers still hear
  "likes" and "views"); from 640 px wide it also shows the words. Liked and not-liked look clearly different.
- Text and capsule are at most 34 rem wide (36 rem from 640 px), centred on large screens, with a dark fade so white text stays
  readable on both bright and dark video frames.
- The block sits **above** the seek bar row (time, duration, speed, mute) and never overlaps it. Safe areas (notch, home bar) are respected.
- A phone turned sideways (under 520 px tall): one line of title, one of description and the capsule at the right edge of the same
  band, so the picture keeps its room. A very small phone held upright (also under 520 px tall) gets a one-line description.
- **Unchanged:** full-screen playback, the close button, the position counter, swipe to the next/previous video, the seek bar, time and
  duration, speed, mute.

If `video-engagement-live.js` can't load, the video list and player work exactly as before, just without the heart and the number.

---

## 4. Speed and timing

### 4.1 Where to look (three places, all safe to leave on)

Only numbers and a few fixed words are recorded. **No login token, key, visitor id (UID) or video id ever appears in any of them.**

1. **On the phone or computer.** Add `?timing=1` to the Videos page address, for example
   `https://nd-flow-plumbing.vercel.app/work-videos.html?timing=1`. A small panel shows the latest records (also inside the
   full-screen player), and each record is written to the browser console as `[ndf-timing]`. `?timing=0` switches it off again; it
   stays on for that tab. The same records are always kept in `window.NDF_TIMINGS` (the last 40), even without the panel.
2. **In the browser's Network panel** (desktop Chrome → DevTools → Network): the `engagement` request → Timing → *Server Timing*.
3. **In Vercel → your project → Logs:** filter by the path `/api/engagement`. One line per request, for example
   `{"evt":"engagement","action":"view","status":200,"counted":true,"cold":false,"region":"iad1","ms":{"verify":0.4,"oauth":0,"certs":0,"read":0,"commit":41.2,"total":43.5}}`

### 4.2 The eight timing points (what each record is called)

| # | What is timed | Where to read it |
|---|---|---|
| 1 | Anonymous sign-in ready | record `auth` → `ready_ms` (page load until a visitor identity exists) |
| 2 | Firebase login-token acquisition | `token_ms` on the `warm` and `view` records |
| 3 | Waiting for `/api/engagement` | `request_ms` (sending until the answer starts to arrive); `network_ms` = the part that was not the server working |
| 4 | Visitor-token verification | server `verify` |
| 5 | Google OAuth token for the server | server `oauth` (`oauth_is`: `cached` or `fetched`) |
| 6 | Firestore visitor-record read | server `read` (`read_is`: `skipped` for a first-time visitor) |
| 7 | Firestore atomic commit | server `commit` |
| 8 | Total server time | server `total` (also `cold_is` = a server instance that had just started, and `region_is`) |

Also recorded: server `certs` (Google's certificate list, needed to check a login; `cached`/`fetched`), and on the page
`like-count`, `like-own`, `like-save` (`ok` 1/0) and `like-refresh` (milliseconds for each Firestore step of a like), `play-start`
(`startup_ms`: how long the video itself took to start playing), and on the `view` record `counted` (1/0), `answered_after_ms` (from
the 5th second until the server's answer was in) and `ok`.

What you *feel* between opening a video and the number changing is `startup_ms` (the video starting, which has nothing to do with the
server) plus the 5 seconds. The faded +1 shows at that moment; the server's confirmation arrives `answered_after_ms` later and only
turns it solid.

### 4.3 Reading a `view` record

| You see | It probably means |
|---|---|
| big `startup_ms` | The video was slow to start (storage, signal, phone). Not the counter. |
| big `token_ms` | The login token had to be renewed over the phone's connection. Rare; most likely on the first video after a long time. |
| big `network_ms`, small server `total` | The connection between phone and Vercel (signal, distance). Compare Wi-Fi and mobile data. |
| `cold_is: yes` with big `oauth`/`certs` | The server instance had just started. The `warm` record sent when the video opened should have taken this; the occasional cold `view` happens when Vercel starts another instance. |
| `read` or `commit` of 100 ms or more | The server is far from the database. See the region check below. |
| `counted: 0` | Not counted on purpose: this visitor already has a view in the last 24 hours (the faded +1 is then taken back). |
| `ok: 0` and a `status` | The server answered with an error (see section 7). |

The thresholds are rules of thumb, not measurements of your project. Collect a handful of `view` records (a few videos, Wi-Fi and
mobile data) and judge by those.

### 4.4 Region check (two minutes, once)

The server function and the database should be close, because each view makes one or two calls from the function to Firestore and
every call pays the distance twice. **I could not look at either setting from here, so no region change is recommended yet.** Check:

1. **Where does the function run?** Vercel → your project → **Settings → Functions → Function Region**. This project's
   `vercel.json` sets no `regions`, so that dashboard setting applies (Vercel's default for new projects is Washington, D.C., `iad1`).
   Every `/api/engagement` answer also reports it: `region` in the Server-Timing header, in the `view` record (`region_is`) and in
   the Vercel log line.
2. **Where does the database run?** Firebase console → ⚙ **Project settings → General → Default GCP resource location**. It is chosen
   once when Firestore is created and can't be changed later. Nothing in this project's files records it.
3. **Decide with the numbers from section 4.3**, not by guessing:
   - `read` and `commit` both small (tens of milliseconds): leave everything as it is.
   - `read`/`commit` around 100 ms or more: the two are probably on different continents. Set the Vercel **Function Region** to the
     one nearest the database and redeploy. On Vercel's free Hobby plan a project has a single function region; changing it is a
     setting, not a new service, and costs nothing. (Vercel's documentation: https://vercel.com/docs/functions/configuring-functions/region)
   - **Do not** move or re-create the Firebase project or the database for this.

Likes talk to Firestore directly from the visitor's phone, so the Vercel region has no effect on them.

### 4.5 Measured before and after (SIMULATED: read this first)

I could not use your live site, your Firebase project or a real phone from here. These tables come from `npm run bench:server` and
`npm run bench:browser`: the real code runs against stand-ins for Firebase and Google that answer after a **fixed, assumed delay**
(browser ↔ Firestore 150 ms per call; browser ↔ Vercel 60 ms; a fresh login token 250 ms; the server's Google sign-in 120 ms, certificates 60 ms;
Firestore read 25 ms and write 40 ms, or 100 ms and 140 ms for "far away"). They show **which steps wait for each other and what that costs if each takes
about that long. They are not your site's speed.** I also could not reproduce the 6–9 seconds you saw; the `?timing=1` records
(section 4.1) are what will show where your real seconds go. The "before" column is the version in the zip you sent me,
measured the same way.

**Server, one request** (median of 15 runs; "steps" = calls to Google that wait for each other):

| Situation | Firestore near the server | Firestore far from the server |
|---|---|---|
| First view ever, server just started | 249 → **164** ms (4 → 2 steps) | 424 → **263** ms |
| First view, server already running | 67 → **42** ms (2 → 1) | 242 → **142** ms |
| Returning visitor, last counted over 24 h ago | 67 → 67 ms (2 → 2) | 243 → 243 ms |
| Same visitor within 24 h, from a browser that doesn't know it counted* | 27 → 68 ms (1 → 2) | 102 → 243 ms |

\* A normal browser keeps a note and never asks in this case, so visitors don't see it. It is the price of the one-step first view
for first-time visitors, shown here so it isn't hidden. The new `warm` request costs about 122 ms in the near case (one step) and
is sent while the visitor is still looking at the first frames.

**Like button** (every Firestore call 150 ms):

| What | Before | After |
|---|---|---|
| Tap right after the cards appear | not accepted for ~130 ms (button waiting for the loads) | accepted at once |
| Heart changes | 16–17 ms | ~10 ms |
| Button usable again after a save | ~483 ms (3 round trips in a row) | ~325 ms (2) |
| Number, if tapped after the page settled | 16 ms | 10 ms |
| Number, if tapped before the count loaded | not tappable ~136 ms, then at once | heart at once, number after ~485 ms (on purpose, see section 3) |
| Like then un-like 80 ms later | ends **liked** (second tap lost) | ends **not liked** (last tap wins) |

**Views** (milliseconds after the video starts playing; the rule is 5000):

| Situation | Before: number changes at | After: faded +1 at → confirmed at |
|---|---|---|
| Server just started, login token not ready | 5674 | 5090 → 5192 |
| Server just started, token ready | 5418 | 5092 → 5195 |
| Server running, token ready | 5226 | 5091 → 5203 |

To repeat these: `npm run bench:server`, `npm run bench:browser` (needs Playwright with Chromium). `npm run bench:server -- --engagement
path/to/another/engagement.js` measures any other version the same way.

---

## 5. What is stored

| Where | Fields | Written by |
|---|---|---|
| `videos/{id}` (existing document) | `viewCount` (whole number; absent until the first view) | only `api/engagement.js` |
| `videos/{id}/likes/{UID}` | `likedAt` (time) | the visitor, only their own |
| `videos/{id}/views/{UID}` | `count`, `firstViewedAt`, `lastViewedAt` | only `api/engagement.js`; closed to browsers |

Nothing about this changed in this round.

## 6. Files

**Changed this round:** `video-engagement-live.js` (likes engine, view timing and the faded +1, timing records), `api/engagement.js`
(faster step order, the `warm` request, the `returning` hint, Server-Timing and one log line per request), `videos-live.js` (the
player's caption block, Read more, capsule), `work-videos.css` (its styles) and `work-videos.html` (only the stylesheet's cache
number, now `?v=5`), `package.json` (two new scripts, `bench:server` and `bench:browser`; no dependencies), and this file.

**Tests (restored and extended):** `tests/engagement.test.js`, `tests/e2e/run.js`, `tests/e2e/server.js`, `tests/e2e/sdk/` (stand-ins
for the Firebase scripts), `tests/helpers/fake-google.js` (stand-in for Google's services), and new `tests/bench/server-latency.js` and
`tests/bench/browser-latency.js`. `.vercelignore` keeps `tests/` out of the deployment.

**Not touched:** `firestore.rules`, `storage.rules`, `vercel.json`, `sw.js`, `styles.css`, `firebase-config.js`, `api/videos.js`
(uploads and playback), `api/analytics.js` and the dashboard, the image gallery and its likes, all admin files, and every page other than
`work-videos.html`.

---

## 7. If something doesn't work

| What you see | Most likely cause |
|---|---|
| The count shows "–" with a dashed outline and never loads | The rules aren't published yet, or the phone is offline. Publish the rules; tap the button to retry. |
| Tapping ♡ shows "Couldn't save that" and the heart goes back | Rules not published, **Anonymous** sign-in switched off, or no connection (or no answer within 12 seconds). |
| Views never go up | Open `https://nd-flow-plumbing.vercel.app/api/engagement` in a browser. It should answer `Use POST.` (status 405): then the function is deployed. If it is a 404, redeploy. Then look in Vercel → Logs for `/api/engagement`: **501** = `FIREBASE_SERVICE_ACCOUNT_JSON` is missing, **500 store_denied** = setup step 3 above (the key can't write), **401** = the key belongs to a different Firebase project than the website. |
| The faded +1 appears and then goes away | The server answered "not counted" (this visitor already has a view in the last 24 hours) or couldn't be reached. With `?timing=1`, `counted: 0` means already counted; `ok: 0` with a `status` is an error from the list above. |
| Views go up by 1, then not again | That is the rule: once per visitor per video per 24 hours. Use a private tab (a new visitor) to test again. |
| The Views number seems slow | Use `?timing=1` and read section 4.3 before changing anything. |
| The admin page shows "– likes" | The like count couldn't be read: check the rules, then tap **Refresh**. |

---

## 8. The tests

Automated tests are in `tests/`. They run on a developer's computer, never on the website.

- `npm test` runs `tests/engagement.test.js`: **74 tests** of the Views endpoint against a faithful stand-in for Google (real signature
  checks; atomic conditional writes), covering counting, the 24-hour boundary, many visitors and many simultaneous requests, lost
  responses, forged and expired logins, bad input, Google/Firestore failures, the step order and the `returning` hint (right, missing
  and wrong), the warm-up request (touches nothing), Server-Timing and the log line, and that no secret or identifier ever appears in a
  response or a log.
- `npm run test:browser` runs `tests/e2e/run.js`: **62 tests** in real Chromium on the real pages with a real playing video and the real
  endpoint. Likes (instant tap, never locked, double taps, last tap wins, two tabs, failures, giving up after 12 s, a save that lands but
  whose answer never comes, slow connection, a stale count read arriving late), views (5 seconds, pausing, seeking, hidden tab, refresh and
  replay, 24 hours, several visitors, two reports at once, failed video, failing server, the faded +1 and taking it back, the warm-up,
  the hint), the timing records, the admin stats, and the full-screen player at phone widths 320, 360, 390 and 430 px, sideways phones, a
  notch, bright and dark frames, Read more, the capsule, the seek bar, swipe, desktop, and that the image likes and the page without the
  new script still work. It needs Playwright with Chromium and ffmpeg (it says so if they are missing). It takes several minutes,
  because it plays real video; `node --test-name-pattern="phone" tests/e2e/run.js` runs only the tests whose names match (the option
  must come *before* the file name, otherwise everything runs).
- `npm run bench:server` and `npm run bench:browser` print the simulated timings in section 4.5 (they are measurements of the
  stand-ins, not tests).

During development each important behaviour was also checked by deliberately breaking it and confirming that a test fails; that tooling
is not part of the project.

**What these do not prove:** they never evaluate `firestore.rules` (Firebase's Rules Playground and the phone test above do), they run
against stand-ins for Firebase and Google rather than your real project, "phone" means desktop Chromium with a phone's screen size and
touch events (not iOS Safari or an Android browser), and they say nothing about real networks, real Vercel regions, or Backblaze.

## 9. Honest limits

- **Anonymous means resettable.** Clearing the browser's data, or a private tab, makes a new visitor who can like once and add a view
  once a day. That stops accidental and casual inflation, not a determined person on purpose. If that ever matters, the next step is
  Firebase **App Check** (a separate service to set up).
- **The 5-second rule is checked by the browser.** The server enforces the login and "once per 24 hours", but can't see the video being
  watched, so someone calling the endpoint directly could skip the watching (still only once per anonymous identity per day).
- **The faded +1 is a guess until the server answers.** It is taken back if the server says "not counted" or can't be reached.
- **Totals are read when the page opens**, plus the visitor's own like or view at once, and the count is read again after the visitor's
  own like is saved. Other people's likes and views show on the next visit; a second tab that was already open keeps the number it
  loaded. There are no live listeners, which keeps reads low.
- **A like that gets no answer within 12 seconds shows as failed** and the heart goes back; if it landed late, the page corrects itself
  about 1.5 seconds later.
- **Server timing is per server instance.** The first request after a quiet spell is a cold start (`cold: yes`); Vercel may run more than
  one instance, so the log lines, not a single reading, are the truth.
- **The simulated before/after numbers are not your site's speed** (section 4.5). Your own `?timing=1` records are.
- **Your own watching counts.** An admin signed in on the public site is a visitor like any other (once a day per video).
- **Deleting a video** from the admin removes the video, but Firestore keeps its small `likes` and `views` entries (they are
  unreachable and tiny). They can be removed in the Firebase console if you like.
- Like documents are publicly readable and named after anonymous UIDs, exactly like the image likes. No names or personal details are
  stored anywhere.

## 10. For whoever maintains this

- Thresholds: `VIEW_SECONDS` in `video-engagement-live.js` (5 s); the 24 hours is `VIEW_WINDOW_MS` in `api/engagement.js` (the server's
  rule). Change both consistently with this guide. Also in `video-engagement-live.js`: `SAVE_TIMEOUT_MS` (12 s give-up for a like),
  `VIEW_RETRY_MS` (15 s, 45 s), `WARM_EVERY_MS` (4 min), `TIMING_KEEP` (40 records).
- The player's text: `CAPTION_PREVIEW`, `CAPTION_LINES` and `CAPTION_LINES_SHORT` in `videos-live.js`; sizes in the overlay block of
  `work-videos.css`. After changing the CSS, raise the `?v=` number in `work-videos.html`.
- Keep `firestore.rules` (the `videos` block) in sync with `video-engagement-live.js` (a like is exactly `{likedAt: request.time}`).
- The server never trusts the `returning` hint for anything but the order of its steps. Keep it that way.
- Never add a login token, key, visitor id or video id to a timing record or a log line (`clean()` in `video-engagement-live.js` and
  `logTiming()` in `api/engagement.js` are written to make that hard; the tests check it).
- The admin page never writes `viewCount` (it edits titles/captions with `updateDoc`); the rules refuse it anyway. If a future change
  saves a whole video document again with `setDoc`, make sure it keeps `viewCount`.
