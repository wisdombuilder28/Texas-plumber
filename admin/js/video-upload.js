// admin/js/video-upload.js
// Sends a video from the phone straight to the storage bucket, in parts, with progress, a few parts at a time,
// automatic retries and "pick up where it stopped". The server (/api/videos) only hands out the one-time links
// and checks that the whole video arrived; the video itself never passes through it.
//
// When sending fails, the phone's browser only ever says "network error" (it says the same whether the signal
// dropped, the file couldn't be read, or the storage's permission for this website is missing). So after a part
// has failed twice this file asks the server, which can look at the storage, and tells the admin which of those
// it really is instead of guessing.

const API = "/api/videos";
const PART_RETRY_DELAYS = [800, 1600, 3200, 6400, 8000]; // 6 tries per part
const STALL_MS = 45_000; //                                 a part that sends nothing for this long is retried
const PARALLEL = 3;

export class UploadError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = "UploadError";
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      if (signal) signal.removeEventListener("abort", stop);
      resolve();
    }
    function stop() {
      clearTimeout(timer);
      reject(new UploadError("canceled", "Cancelled."));
    }
    if (signal) {
      if (signal.aborted) return stop();
      signal.addEventListener("abort", stop, { once: true });
    }
  });

function randomId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// An abort signal that also fires after `ms` (and when `parent` fires). Call done() when finished with it.
function timedSignal(parent, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const onAbort = () => ctrl.abort();
  if (parent) {
    if (parent.aborted) ctrl.abort();
    else parent.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    done() {
      clearTimeout(timer);
      if (parent) parent.removeEventListener("abort", onAbort);
    },
  };
}

const kb = (n) => `${Math.round((Number(n) || 0) / 1024)} KB`;
const thisAddress = () => (typeof location !== "undefined" ? location.origin : "");

// ---------------------------------------------------------------------------------------------
// Talking to /api/videos
// ---------------------------------------------------------------------------------------------
async function request(getToken, method, url, body, signal) {
  const token = await getToken();
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal,
      cache: "no-store",
    });
  } catch (error) {
    if (signal && signal.aborted) throw new UploadError("canceled", "Cancelled.");
    throw new UploadError("network", "Couldn't reach the server. Check your connection and try again.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new UploadError(data.code || "server", data.error || `The server refused that (${res.status}).`, { status: res.status, data });
  }
  return data;
}

export const apiPost = (getToken, body, signal) => request(getToken, "POST", API, body, signal);
// `checkCors` also makes the server ask the storage whether each allowed website address may upload.
export const apiStatus = (getToken, signal, { checkCors = false } = {}) => request(getToken, "GET", `${API}?action=status${checkCors ? "&check=cors" : ""}`, null, signal);

// Public: a short-lived link to watch one video (no login needed).
export async function playLink(key, signal) {
  let res;
  try {
    res = await fetch(`${API}?action=play&key=${encodeURIComponent(key)}`, { signal, cache: "no-store" });
  } catch (error) {
    if (signal && signal.aborted) throw new UploadError("canceled", "Cancelled.");
    throw new UploadError("network", "Couldn't reach the server. Check your connection.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) throw new UploadError(data.code || "server", data.error || "This video isn't available right now.", { status: res.status });
  return data.url;
}

// ---------------------------------------------------------------------------------------------
// One part: PUT to its one-time link, with progress and stall detection.
// `data` is the part's bytes, already read into memory (see readPart).
// ---------------------------------------------------------------------------------------------
function putPart(url, data, { signal, onBytes }) {
  return new Promise((resolve, reject) => {
    const size = data.byteLength;
    const xhr = new XMLHttpRequest();
    let stalled = false;
    let last = Date.now();
    const watch = setInterval(() => {
      if (Date.now() - last > STALL_MS) {
        stalled = true;
        xhr.abort();
      }
    }, 5000);
    const finish = () => {
      clearInterval(watch);
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => xhr.abort();
    if (signal) {
      if (signal.aborted) {
        finish();
        return reject(new UploadError("canceled", "Cancelled."));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => {
      last = Date.now();
      if (e.lengthComputable) onBytes(Math.min(e.loaded, size));
    };
    xhr.onload = () => {
      finish();
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      const retryable = xhr.status === 408 || xhr.status === 429 || xhr.status >= 500;
      const code = xhr.status === 403 ? "link_rejected" : xhr.status === 404 ? "upload_gone" : retryable ? "storage_busy" : "storage_refused";
      reject(new UploadError(code, `Storage answered ${xhr.status}.`, { status: xhr.status, retryable }));
    };
    xhr.onerror = () => {
      finish();
      reject(new UploadError("network", "The connection dropped.", { retryable: true }));
    };
    xhr.onabort = () => {
      finish();
      if (signal && signal.aborted) reject(new UploadError("canceled", "Cancelled."));
      else reject(new UploadError(stalled ? "stalled" : "network", stalled ? "The connection stopped moving." : "The connection dropped.", { retryable: true }));
    };
    xhr.send(data);
  });
}

// A part is read into memory once and sent from there (and re-sent from there if it has to be retried). Sending
// straight from a file the phone's picker handed over can fail with a bare "network error" if Android has meanwhile
// taken back access to that file, and then there would be no way to tell it apart from a bad signal.
async function readPart(blob, start, size) {
  let data;
  try {
    data = await blob.slice(start, start + size).arrayBuffer();
  } catch (cause) {
    throw new UploadError("file_unreadable", "This phone couldn't read the video file any more.", { retryable: false, readError: String((cause && cause.name) || cause) });
  }
  if (data.byteLength !== size) {
    throw new UploadError("file_unreadable", "The video file changed while it was being sent.", { retryable: false, readError: `read ${data.byteLength} of ${size} bytes` });
  }
  return data;
}

async function whenOnline(signal) {
  if (typeof navigator === "undefined" || navigator.onLine !== false) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(done, 120_000);
    function done() {
      clearTimeout(timer);
      window.removeEventListener("online", done);
      if (signal) signal.removeEventListener("abort", stop);
      resolve();
    }
    function stop() {
      clearTimeout(timer);
      window.removeEventListener("online", done);
      reject(new UploadError("canceled", "Cancelled."));
    }
    window.addEventListener("online", done, { once: true });
    if (signal) signal.addEventListener("abort", stop, { once: true });
  });
}

// ---------------------------------------------------------------------------------------------
// Why did sending fail? The phone can't tell, so the server is asked.
// ---------------------------------------------------------------------------------------------

// A "no-cors" request needs no permission, so it only fails when this phone truly can't get to the storage's address
// (no signal, a VPN, a private-DNS or ad-blocking filter...).
async function storageReachable(url, signal) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  const t = timedSignal(signal, 6000);
  try {
    await fetch(`${origin}/`, { method: "GET", mode: "no-cors", cache: "no-store", credentials: "omit", signal: t.signal });
    return true;
  } catch {
    return false;
  } finally {
    t.done();
  }
}

async function askServer(getToken, signal) {
  const t = timedSignal(signal, 9000);
  try {
    return await apiStatus(getToken, t.signal, { checkCors: true });
  } catch {
    return null; // can't ask (no connection to the website either): carry on as an ordinary connection problem
  } finally {
    t.done();
  }
}

// Returns { code: "wrong_address" | "blocked" | null, message, here, allowed, storageAllows, reachable }.
//   wrong_address  this page is open at an address the storage was never set up to accept uploads from
//   blocked        the storage says "no" to this page's address (the one-time permission is missing)
//   neither        the storage accepts this address, so it's the connection (or the phone) after all
async function diagnose(getToken, firstUrl, signal) {
  const [reachable, status] = await Promise.all([storageReachable(firstUrl, signal), askServer(getToken, signal)]);
  const here = thisAddress();
  const cors = status && status.cors;
  const allowed = cors && Array.isArray(cors.origins) ? cors.origins : [];
  if (allowed.length && here && !allowed.includes(here)) {
    return {
      code: "wrong_address",
      here,
      allowed,
      message: `This page is open at ${here}, but videos can only be sent from ${allowed.join(" or ")}. Open the admin from that address and add the video there. (If ${here} really is your website's address, add it to STORAGE_CORS_ORIGINS in Vercel and run the one-time setup again.)`,
    };
  }
  const check = cors && Array.isArray(cors.checks) ? cors.checks.find((c) => c.origin === here) : null;
  if (check && check.ok === false) {
    return {
      code: "blocked",
      here,
      allowed,
      checkStatus: check.status,
      message: `The storage hasn't been given permission to take uploads from ${here} yet (when the website's server asked it, the answer was no).`,
    };
  }
  return { code: null, here, allowed, reachable, storageAllows: !!(check && check.ok === true) };
}

// A short line of facts to put under an error message, so a screenshot is enough to see what happened.
function attemptDetail({ part, parts, attempt, sent, size, error }) {
  const nav = typeof navigator !== "undefined" ? navigator : {};
  const link = nav.connection && nav.connection.effectiveType ? `, ${nav.connection.effectiveType}` : "";
  return [
    `part ${part} of ${parts}`,
    `try ${attempt + 1}`,
    `${kb(sent)} of ${kb(size)} sent`,
    error.status ? `storage said ${error.status}` : error.readError ? `file: ${error.readError}` : error.code,
    `${nav.onLine === false ? "offline" : "online"}${link}`,
    `page at ${thisAddress()}`,
  ].join(" · ");
}

// ---------------------------------------------------------------------------------------------
// All parts, a few at a time
// ---------------------------------------------------------------------------------------------
async function sendParts(s, blob, indexes, { getToken, signal, onProgress, onRetry, retryDelays = PART_RETRY_DELAYS }) {
  const queue = [...indexes];
  const inFlight = new Map(); // part index -> bytes sent so far
  const partSize = (i) => Math.min(s.partSize, blob.size - i * s.partSize);
  const report = () => {
    let bytes = 0;
    for (const i of s.done) bytes += partSize(i);
    for (const [i, sent] of inFlight) if (!s.done.has(i)) bytes += sent;
    onProgress(Math.min(bytes, blob.size), blob.size);
  };
  const killer = new AbortController();
  const stop = () => killer.abort();
  if (signal) {
    if (signal.aborted) throw new UploadError("canceled", "Cancelled.");
    signal.addEventListener("abort", stop, { once: true });
  }
  let failure = null;
  let diagnosis = null; // asked once per run: every part that fails shares the same answer

  async function sendOne(i) {
    const size = partSize(i);
    let data;
    try {
      data = await readPart(blob, i * s.partSize, size);
    } catch (error) {
      error.detail = attemptDetail({ part: i + 1, parts: s.urls.length, attempt: 0, sent: 0, size, error });
      throw error;
    }
    try {
      for (let attempt = 0; ; attempt++) {
        inFlight.set(i, 0);
        report();
        try {
          await putPart(s.urls[i], data, {
            signal: killer.signal,
            onBytes: (n) => {
              inFlight.set(i, n);
              report();
            },
          });
          s.done.add(i);
          inFlight.delete(i);
          report();
          return;
        } catch (error) {
          const sent = inFlight.get(i) || 0;
          inFlight.delete(i);
          report();
          if (error.code === "canceled" || killer.signal.aborted) throw new UploadError("canceled", "Cancelled.");
          const detail = () => attemptDetail({ part: i + 1, parts: s.urls.length, attempt, sent, size, error });

          // The second time a part fails with a bare "network error" before any part has got through, stop guessing:
          // ask the server whether the storage would take uploads from this website at all.
          if (error.code === "network" && attempt >= 1 && s.done.size === 0) {
            if (!diagnosis) diagnosis = diagnose(getToken, s.urls[i], killer.signal);
            const verdict = await diagnosis;
            if (killer.signal.aborted) throw new UploadError("canceled", "Cancelled.");
            if (verdict.code) {
              throw new UploadError(verdict.code, verdict.message, { here: verdict.here, allowed: verdict.allowed, checkStatus: verdict.checkStatus, detail: detail() });
            }
            error.storageAllows = verdict.storageAllows;
            error.unreachable = verdict.reachable === false;
          }
          if (!error.retryable || attempt >= retryDelays.length) {
            error.detail = detail();
            throw error;
          }
          if (onRetry) onRetry({ part: i + 1, attempt: attempt + 1, error });
          await whenOnline(killer.signal);
          await wait(retryDelays[attempt], killer.signal);
        }
      }
    } finally {
      data = null; // let go of the memory as soon as this part is finished (or given up on)
    }
  }

  async function worker() {
    while (!failure && queue.length && !killer.signal.aborted) {
      const i = queue.shift();
      try {
        await sendOne(i);
      } catch (error) {
        if (!failure) failure = error;
        killer.abort(); // stop the other parts too: the whole upload needs a fresh start from the page
        return;
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
  } finally {
    if (signal) signal.removeEventListener("abort", stop);
  }
  if (signal && signal.aborted) throw new UploadError("canceled", "Cancelled.");
  if (failure) throw failure;
}

// ---------------------------------------------------------------------------------------------
// Does the finished video exist already? (used when the "all done" answer got lost on a bad connection)
// ---------------------------------------------------------------------------------------------
async function objectExists(key, signal) {
  try {
    const url = await playLink(key, signal);
    const res = await fetch(url, { headers: { Range: "bytes=0-0" }, signal });
    if (res.body && res.body.cancel) res.body.cancel().catch(() => {});
    return res.status === 206 || res.status === 200;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// The whole upload. Pass the `session` from a failed attempt to carry on without re-sending finished parts.
// ---------------------------------------------------------------------------------------------
export async function uploadBlob(options) {
  const { blob, mime, durationSec, getToken, signal, onProgress, onRetry, purpose, session, retryDelays } = options;
  const s = session || { id: randomId(), key: null, uploadId: null, partSize: 0, urls: [], done: new Set() };
  const speed = [];
  const progress = (bytes, total) => {
    const now = Date.now();
    speed.push([now, bytes]);
    while (speed.length > 2 && now - speed[0][0] > 8000) speed.shift();
    const [t0, b0] = speed[0];
    const rate = now > t0 ? ((bytes - b0) / (now - t0)) * 1000 : 0;
    if (onProgress) onProgress({ bytes, total, fraction: total ? bytes / total : 0, bytesPerSecond: Math.max(0, rate), secondsLeft: rate > 1024 ? (total - bytes) / rate : null });
  };
  const sendOptions = { getToken, signal, onProgress: progress, onRetry, retryDelays };

  try {
    if (!s.uploadId) {
      const init = await apiPost(
        getToken,
        purpose === "test" ? { action: "init", purpose: "test", id: s.id, size: blob.size } : { action: "init", id: s.id, size: blob.size, durationSec, mime },
        signal
      );
      Object.assign(s, { key: init.key, uploadId: init.uploadId, partSize: init.partSize, urls: init.urls, done: new Set() });
    }

    const all = Array.from({ length: s.urls.length }, (_, i) => i);
    await sendParts(s, blob, all.filter((i) => !s.done.has(i)), sendOptions);

    for (let round = 0; ; round++) {
      try {
        const done = await apiPost(getToken, { action: "complete", key: s.key, uploadId: s.uploadId, size: blob.size }, signal);
        return { key: s.key, bytes: done.bytes, session: s };
      } catch (error) {
        if (error.code === "canceled") throw error;
        if (error.code === "incomplete" && round < 3 && Array.isArray(error.data && error.data.missing) && error.data.missing.length) {
          for (const n of error.data.missing) s.done.delete(n - 1);
          await sendParts(s, blob, error.data.missing.map((n) => n - 1), sendOptions);
          continue;
        }
        if (error.code === "network" && round < 3) {
          await wait(1500 * (round + 1), signal);
          continue;
        }
        // "No such upload" can mean an earlier "complete" worked but its answer never reached us.
        if (error.status === 404 && (await objectExists(s.key, signal))) return { key: s.key, bytes: blob.size, session: s };
        throw error;
      }
    }
  } catch (error) {
    if (!(error instanceof UploadError)) throw error;
    error.session = s; // so the page can try again without starting over
    throw error;
  }
}

// Stops an unfinished upload and frees what was already sent. Safe to call twice.
export async function abortUpload(getToken, session) {
  if (!session || !session.uploadId || !session.key) return;
  try {
    await apiPost(getToken, { action: "abort", key: session.key, uploadId: session.uploadId });
  } catch {
    /* the server also cleans unfinished uploads on its own */
  }
}

export async function deleteStored(getToken, key) {
  return apiPost(getToken, { action: "delete", key });
}

// ---------------------------------------------------------------------------------------------
// "Test storage": a tiny real upload, completed and deleted again, one plain-English line per step
// ---------------------------------------------------------------------------------------------
export async function runStorageTest(getToken, onStep) {
  const steps = [];
  const record = (id, ok, text, extra) => {
    const step = { id, ok, text, ...extra };
    steps.push(step);
    if (onStep) onStep(step);
    return step;
  };

  let status;
  try {
    status = await apiStatus(getToken);
  } catch (error) {
    record("server", false, error.message);
    return steps;
  }
  record("server", true, "The website's server answered.");
  if (!status.configured) {
    record("settings", false, `These settings are missing in Vercel: ${(status.missing || []).join(", ") || status.problem || "unknown"}.`);
    return steps;
  }
  record("settings", true, `Settings found (${status.provider}, bucket “${status.bucket}”).`);
  if (!status.storageOk) {
    record("storage", false, status.problem || "The server couldn't reach the storage.");
    return steps;
  }
  record("storage", true, "The server can reach the storage and the key works.");

  // The real test: this phone's browser sends a small file, the way it will send a video.
  const bytes = new Uint8Array(64 * 1024);
  crypto.getRandomValues(bytes.subarray(0, 65536));
  let result;
  try {
    result = await uploadBlob({ blob: new Blob([bytes]), purpose: "test", getToken, retryDelays: [700] });
  } catch (error) {
    if (error.session) await abortUpload(getToken, error.session);
    if (error.code === "blocked") {
      record("upload", false, `${error.message} Use “One-time setup” below, then test again.`);
    } else if (error.code === "wrong_address") {
      record("upload", false, error.message);
    } else if (error.code === "network" || error.code === "stalled") {
      record(
        "upload",
        false,
        error.storageAllows
          ? "The storage does accept uploads from this website, but the test file still didn't get through. So the problem is this phone's connection: switch between Wi-Fi and mobile data, turn off any VPN, private DNS or ad-blocker, and test again."
          : error.unreachable
            ? "This phone can't reach the storage's address right now. Check your signal, switch between Wi-Fi and mobile data, turn off any VPN, private DNS or ad-blocker, and test again."
            : "The test file didn't get through. Check your signal and run the test again. If it keeps failing with a good signal, use “One-time setup” below."
      );
    } else if (error.code === "link_rejected") {
      record("upload", false, "The storage refused the upload link. Check STORAGE_KEY_ID and STORAGE_APP_KEY in Vercel, then redeploy.");
    } else {
      record("upload", false, error.message);
    }
    if (error.detail) record("details", false, `Details: ${error.detail}`, { note: true });
    return steps;
  }
  record("upload", true, "This phone's browser can send files to the storage.");
  try {
    await deleteStored(getToken, result.key);
    record("cleanup", true, "Test file removed. Everything works.");
  } catch (error) {
    record("cleanup", false, `Upload works, but removing the test file failed: ${error.message}`);
  }
  return steps;
}
