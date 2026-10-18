// admin/js/video-upload.js
// Sends a video from the phone straight to the storage bucket, in parts, with progress, a few parts at a time,
// automatic retries and "pick up where it stopped". The server (/api/videos) only hands out the one-time links
// and checks that the whole video arrived; the video itself never passes through it.

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
export const apiStatus = (getToken, signal) => request(getToken, "GET", `${API}?action=status`, null, signal);

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
// One part: PUT to its one-time link, with progress and stall detection
// ---------------------------------------------------------------------------------------------
function putPart(url, blob, { signal, onBytes }) {
  return new Promise((resolve, reject) => {
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
      if (e.lengthComputable) onBytes(Math.min(e.loaded, blob.size));
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
    xhr.send(blob);
  });
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
// Bad signal, or is the storage refusing this browser? (its one-time "upload permission" / CORS rule)
// ---------------------------------------------------------------------------------------------
const BLOCKED_TEXT = "The storage isn't letting this phone send videos to it yet.";

// A "no-cors" request needs no permission, so it only fails when the phone truly can't get to the storage's
// address (no signal, no DNS). If it works while the real upload keeps failing before a single byte leaves,
// the browser is being stopped by the storage's own rule about who may send it files, not by the signal.
async function storageReachable(url, signal) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  const stop = () => ctrl.abort();
  if (signal) signal.addEventListener("abort", stop, { once: true });
  try {
    await fetch(`${origin}/`, { method: "GET", mode: "no-cors", cache: "no-store", credentials: "omit", signal: ctrl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", stop);
  }
}

// ---------------------------------------------------------------------------------------------
// All parts, a few at a time
// ---------------------------------------------------------------------------------------------
async function sendParts(s, blob, indexes, { signal, onProgress, onRetry, retryDelays = PART_RETRY_DELAYS }) {
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

  async function sendOne(i) {
    const piece = blob.slice(i * s.partSize, i * s.partSize + partSize(i));
    for (let attempt = 0; ; attempt++) {
      inFlight.set(i, 0);
      report();
      try {
        await putPart(s.urls[i], piece, {
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
        const sentBefore = inFlight.get(i) || 0;
        inFlight.delete(i);
        report();
        if (error.code === "canceled" || killer.signal.aborted) throw new UploadError("canceled", "Cancelled.");
        // Failing twice either before a single byte leaves (the browser's permission check is refused) or only
        // after the whole part went out (the answer is refused), while the storage can still be reached, is the
        // storage refusing this browser, not a bad signal. A signal that drops cuts a part off half way instead.
        // Say so at once instead of retrying for half a minute.
        const nothingOrEverythingSent = sentBefore === 0 || sentBefore >= piece.size;
        if (error.code === "network" && attempt >= 1 && nothingOrEverythingSent && s.done.size === 0 && (await storageReachable(s.urls[i], killer.signal))) {
          throw new UploadError("blocked", BLOCKED_TEXT);
        }
        if (!error.retryable || attempt >= retryDelays.length) throw error;
        if (onRetry) onRetry({ part: i + 1, attempt: attempt + 1, error });
        await whenOnline(killer.signal);
        await wait(retryDelays[attempt], killer.signal);
      }
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
    await sendParts(s, blob, all.filter((i) => !s.done.has(i)), { signal, onProgress: progress, onRetry, retryDelays });

    for (let round = 0; ; round++) {
      try {
        const done = await apiPost(getToken, { action: "complete", key: s.key, uploadId: s.uploadId, size: blob.size }, signal);
        return { key: s.key, bytes: done.bytes, session: s };
      } catch (error) {
        if (error.code === "canceled") throw error;
        if (error.code === "incomplete" && round < 3 && Array.isArray(error.data && error.data.missing) && error.data.missing.length) {
          for (const n of error.data.missing) s.done.delete(n - 1);
          await sendParts(s, blob, error.data.missing.map((n) => n - 1), { signal, onProgress: progress, onRetry, retryDelays });
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
  const record = (id, ok, text) => {
    const step = { id, ok, text };
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

  const bytes = new Uint8Array(64 * 1024);
  crypto.getRandomValues(bytes.subarray(0, 65536));
  let result;
  try {
    result = await uploadBlob({ blob: new Blob([bytes]), purpose: "test", getToken, retryDelays: [700] });
  } catch (error) {
    if (error.session) await abortUpload(getToken, error.session);
    if (error.code === "blocked") {
      record("upload", false, "This phone's browser was blocked from sending to the storage. That means the one-time “upload permission” setup hasn't been done yet. Use “One-time setup” below.");
    } else if (error.code === "network" || error.code === "stalled") {
      record("upload", false, "The test file didn't get through. Check your signal and run the test again. If it keeps failing with a good signal, use “One-time setup” below.");
    } else if (error.code === "link_rejected") {
      record("upload", false, "The storage refused the upload link. Check STORAGE_KEY_ID and STORAGE_APP_KEY in Vercel, then redeploy.");
    } else {
      record("upload", false, error.message);
    }
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
