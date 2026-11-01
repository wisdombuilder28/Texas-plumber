// api/engagement.js
//
// The public "Views" counter for the Recent Work videos. Zero dependencies (Node's built-in crypto + fetch
// only), same style as api/videos.js and api/analytics.js.
//
// Why this is a server route and not a plain Firestore write from the visitor's browser:
//   * A view counts once per visitor, per video, per 24 hours, and the video's total has to go up in the same
//     breath. Security rules can't do both safely on the free Firebase plan, and a counter that browsers may
//     write is a counter anyone can inflate from the console with the public Firebase key.
//   * Here the server checks the visitor's Firebase login (the silent anonymous one is fine), decides with its
//     OWN clock, and saves the visitor's record and the video's total in ONE atomic write. firestore.rules lets
//     nobody in a browser (the admin included) write `viewCount` or anything under `views`.
//
// Likes are NOT handled here. They work exactly like the image likes: the browser writes one small document per
// visitor and firestore.rules allows exactly one each; the number shown is the number of those documents.
//
// What this file reads and writes in Firestore:
//   videos/{videoId}                 viewCount   (whole number; only this file changes it; missing means 0)
//   videos/{videoId}/views/{uid}     count (views counted for this visitor), firstViewedAt, lastViewedAt
//
// The one request it answers:
//   POST /api/engagement      header  Authorization: Bearer <the visitor's Firebase ID token>
//                             body    { "action": "view", "videoId": "<id of the video>" }
//     200 { ok: true, counted: true,  viewCount: 187, nextEligibleAt: "<time>" }
//                                                             counted; viewCount is the new total (or null)
//     200 { ok: true, counted: false, reason: "recent", viewCount: null, nextEligibleAt: "<time>" }
//                                                             this visitor already has a view in the last 24 h
//                                                             (nextEligibleAt = when the next one would count)
//     400 bad request | 401 not logged in | 404 no such video | 405 | 413 | 501 not set up | 503 busy / Firestore down
//
// Vercel environment variables (nothing new):
//   FIREBASE_SERVICE_ACCOUNT_JSON   already set for analytics and videos. This account must be allowed to WRITE
//                                   to Firestore. The default "firebase-adminsdk" account is.

"use strict";

const crypto = require("crypto");

// ---------------------------------------------------------------------------
// The rules of a view
// ---------------------------------------------------------------------------
const VIEW_WINDOW_MS = 24 * 60 * 60 * 1000; // one counted view per visitor per video in this time
const MAX_ATTEMPTS = 4; //                      tries when two requests collide (the same visitor, or a busy moment)
const MAX_BODY_BYTES = 2048; //                 the real request is about 80 bytes

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/; //       same shape as api/videos.js and the ids the admin page makes
const UID_RE = /^[A-Za-z0-9._:-]{1,128}$/; //   Firebase user ids (anonymous ones are 28 letters and digits)

const DATASTORE = "https://www.googleapis.com/auth/datastore";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SECURE_TOKEN_CERTS =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
const FIRESTORE_API = "https://firestore.googleapis.com/v1";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
class ApiError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

// A problem talking to Firestore. kind: "denied" | "unavailable" | "conflict" | "not_found" | "other"
class StoreError extends Error {
  constructor(kind, httpStatus, googleStatus, message) {
    super(message || googleStatus || `Firestore HTTP ${httpStatus}`);
    this.kind = kind;
    this.httpStatus = httpStatus;
    this.googleStatus = googleStatus;
  }
}

function jsonResponse(status, body, extraHeaders) {
  return {
    status,
    body,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(extraHeaders || {}),
    },
  };
}

function sendNode(res, result) {
  res.statusCode = result.status;
  for (const [key, value] of Object.entries(result.headers || {})) res.setHeader(key, value);
  res.end(JSON.stringify(result.body));
}

function toWebResponse(result) {
  return new Response(JSON.stringify(result.body), { status: result.status, headers: result.headers });
}

function getHeader(req, name) {
  const headers = req.headers;
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) || "";
  const value = headers[name.toLowerCase()] || headers[name];
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

// Reads the request body as JSON. Handles the three shapes a body can arrive in: a Web-style Request (has text()),
// Vercel's Node request (body already parsed, or a string/Buffer) and a plain Node stream.
async function readJsonBody(req) {
  let raw = "";

  if (typeof req.text === "function") {
    // A Web Request: its `body` is a stream, so text() has to be used and must be looked at first.
    raw = await req.text();
  } else {
    // On Vercel the body is parsed the first time it is read, and a body that isn't valid JSON makes that read throw.
    // That is the sender's mistake (400), not a server fault.
    let preset;
    try {
      preset = req.body;
    } catch {
      throw new ApiError(400, "bad_json", "The request wasn't valid JSON.");
    }
    if (preset && typeof preset === "object" && !Buffer.isBuffer(preset)) {
      // Already parsed. Still refuse anything oversized.
      if (JSON.stringify(preset).length > MAX_BODY_BYTES) throw new ApiError(413, "too_big", "Request is too big.");
      return preset;
    }
    if (typeof preset === "string") {
      raw = preset;
    } else if (Buffer.isBuffer(preset)) {
      raw = preset.toString("utf8");
    } else if (typeof req.on === "function") {
      raw = await new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            reject(new ApiError(413, "too_big", "Request is too big."));
            return;
          }
          chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
      });
    }
  }

  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw new ApiError(413, "too_big", "Request is too big.");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, "bad_json", "The request wasn't valid JSON.");
  }
}

// A Firestore document id that is safe to put in a path: no slashes, and not one of the names Firestore reserves.
function safeSegment(value) {
  return value !== "." && value !== ".." && !/^__.*__$/.test(value);
}

// ---------------------------------------------------------------------------
// Google sign-in for this server (the service account) and checking a visitor's Firebase login.
// Same method as api/videos.js and api/analytics.js, kept here so the video upload code is never touched.
// ---------------------------------------------------------------------------
function normalizePrivateKey(privateKey) {
  return String(privateKey || "").replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();
}

function parseServiceAccount(raw) {
  if (!raw) return null;
  let text = String(raw).trim().replace(/^\uFEFF/, "");
  if (
    (text.startsWith("'") && text.endsWith("'") && !text.startsWith("'{")) ||
    (text.startsWith('"') && text.endsWith('"') && !text.startsWith('"{'))
  ) {
    text = text.slice(1, -1);
  }
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = JSON.parse(Buffer.from(text, "base64").toString("utf8"));
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) return null;
  parsed.private_key = normalizePrivateKey(parsed.private_key);
  if (!parsed.private_key.includes("BEGIN PRIVATE KEY")) return null;
  return parsed;
}

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function signJwt(payload, privateKey) {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(data);
  signer.end();
  const signature = signer.sign(privateKey, "base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${data}.${signature}`;
}

async function getGoogleAccessToken(ctx, serviceAccount) {
  const now = Math.floor(ctx.now().getTime() / 1000);
  const cached = ctx.cache.google;
  if (cached && cached.exp > now + 60 && cached.email === serviceAccount.client_email) return cached.token;
  const assertion = signJwt(
    {
      iss: serviceAccount.client_email,
      sub: serviceAccount.client_email,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
      scope: DATASTORE,
    },
    serviceAccount.private_key
  );
  let res;
  try {
    res = await ctx.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    });
  } catch (error) {
    throw new StoreError("unavailable", 0, "NETWORK", `Could not reach Google sign-in: ${error && error.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    // A busy or unreachable Google is worth trying again later; a refused key is a setup problem.
    const kind = res.status === 429 || res.status >= 500 ? "unavailable" : "denied";
    throw new StoreError(kind, res.status, String(data.error || ""), `Google access token failed: ${data.error_description || data.error || `token HTTP ${res.status}`}`);
  }
  ctx.cache.google = {
    token: data.access_token,
    exp: now + Number(data.expires_in || 3600),
    email: serviceAccount.client_email,
  };
  return ctx.cache.google.token;
}

// Not being able to FETCH Google's certificates is our problem (or Google's), never the visitor's: it is tagged so
// the visitor is told "try again later" and not "sign in again".
function certsUnavailable(message) {
  const error = new Error(message);
  error.infrastructure = true;
  return error;
}

async function getSecureTokenCerts(ctx) {
  if (ctx.cache.certs && ctx.now().getTime() < ctx.cache.certsUntil) return ctx.cache.certs;
  let res;
  try {
    res = await ctx.fetch(SECURE_TOKEN_CERTS);
  } catch (error) {
    throw certsUnavailable(`Could not fetch Firebase signing certs: ${error && error.message}`);
  }
  if (!res.ok) throw certsUnavailable(`Could not fetch Firebase signing certs (HTTP ${res.status})`);
  try {
    ctx.cache.certs = await res.json();
  } catch {
    throw certsUnavailable("Firebase signing certs came back unreadable");
  }
  const cacheControl = (res.headers && res.headers.get && res.headers.get("cache-control")) || "";
  const maxAge = Number((/max-age=(\d+)/.exec(cacheControl) || [])[1] || 3600);
  ctx.cache.certsUntil = ctx.now().getTime() + maxAge * 1000;
  return ctx.cache.certs;
}

function decodeJwt(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("Malformed Firebase ID token");
  const [headerPart, payloadPart, signaturePart] = parts;
  return {
    header: JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")),
    payload: JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")),
    data: `${headerPart}.${payloadPart}`,
    signature: signaturePart,
  };
}

async function verifyFirebaseIdToken(ctx, token, projectId) {
  const decoded = decodeJwt(token);
  const now = Math.floor(ctx.now().getTime() / 1000);
  const { header, payload } = decoded;
  if (header.alg !== "RS256") throw new Error("Unexpected token algorithm");
  if (payload.aud !== projectId) throw new Error("Token audience does not match this Firebase project");
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error("Token issuer does not match this Firebase project");
  if (typeof payload.sub !== "string" || !payload.sub) throw new Error("Token is missing a user id");
  if (Number(payload.exp || 0) <= now) throw new Error("Token has expired");
  if (Number(payload.iat || 0) > now + 60) throw new Error("Token is not yet valid");
  if (payload.auth_time && Number(payload.auth_time) > now + 60) throw new Error("Token sign-in time is in the future");
  const certs = await getSecureTokenCerts(ctx);
  const cert = certs[header.kid];
  if (!cert) throw new Error("Unknown token signing key");
  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(decoded.data);
  verifier.end();
  if (!verifier.verify(cert, decoded.signature, "base64url")) throw new Error("Token signature is invalid");
  return payload;
}

// Who is asking? Any Firebase login of THIS project counts: the silent anonymous one every visitor gets, or an admin.
// The id comes from the verified token, never from the request body, so nobody can count a view as someone else.
async function verifyVisitor(ctx, req, serviceAccount) {
  const match = /^Bearer\s+(\S+)$/i.exec(getHeader(req, "authorization").trim());
  if (!match) throw new ApiError(401, "auth", "Refresh the page and try again.");
  let payload;
  try {
    payload = await verifyFirebaseIdToken(ctx, match[1], serviceAccount.project_id);
  } catch (error) {
    if (error && error.infrastructure) {
      console.error("Visitor token could not be checked:", error.message);
      throw new ApiError(503, "unavailable", "Views are unavailable for a moment.");
    }
    console.error("Visitor token rejected:", error && error.message);
    throw new ApiError(401, "auth", "Refresh the page and try again.");
  }
  const uid = String(payload.user_id || payload.sub || "");
  if (!UID_RE.test(uid) || !safeSegment(uid)) throw new ApiError(401, "auth", "Refresh the page and try again.");
  return uid;
}

// ---------------------------------------------------------------------------
// Firestore over its REST API, signed in as the service account (so security rules are not involved here)
// ---------------------------------------------------------------------------
function resourceName(serviceAccount, path) {
  return `projects/${serviceAccount.project_id}/databases/(default)/documents/${path}`;
}

function documentUrl(serviceAccount, path) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${FIRESTORE_API}/projects/${encodeURIComponent(serviceAccount.project_id)}/databases/(default)/documents/${encoded}`;
}

function classifyFailure(httpStatus, googleStatus) {
  if (httpStatus === 401 || httpStatus === 403 || googleStatus === "PERMISSION_DENIED" || googleStatus === "UNAUTHENTICATED") return "denied";
  if (httpStatus === 404 || googleStatus === "NOT_FOUND") return "not_found";
  if (httpStatus === 409 || googleStatus === "ALREADY_EXISTS" || googleStatus === "ABORTED" || googleStatus === "FAILED_PRECONDITION") return "conflict";
  if (httpStatus === 429 || httpStatus >= 500 || googleStatus === "UNAVAILABLE" || googleStatus === "DEADLINE_EXCEEDED" || googleStatus === "RESOURCE_EXHAUSTED") return "unavailable";
  return "other";
}

async function storeFetch(ctx, url, init) {
  try {
    return await ctx.fetch(url, init);
  } catch (error) {
    throw new StoreError("unavailable", 0, "NETWORK", `Could not reach Firestore: ${error && error.message}`);
  }
}

async function failureFrom(res) {
  const data = await res.json().catch(() => ({}));
  const googleStatus = String((data && data.error && data.error.status) || "");
  const message = String((data && data.error && data.error.message) || "");
  return new StoreError(classifyFailure(res.status, googleStatus), res.status, googleStatus, message);
}

// One document, or null if it doesn't exist.
async function firestoreGet(ctx, serviceAccount, accessToken, path) {
  const res = await storeFetch(ctx, documentUrl(serviceAccount, path), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw await failureFrom(res);
  return res.json();
}

// Several writes that all happen, or none do. Resolves { ok: true, data } or { ok: false, error: StoreError }.
async function firestoreCommit(ctx, serviceAccount, accessToken, writes) {
  const url = `${FIRESTORE_API}/projects/${encodeURIComponent(serviceAccount.project_id)}/databases/(default)/documents:commit`;
  const res = await storeFetch(ctx, url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ writes }),
  });
  if (res.ok) return { ok: true, data: await res.json().catch(() => ({})) };
  return { ok: false, error: await failureFrom(res) };
}

function timestampMs(value) {
  const ms = value && typeof value.timestampValue === "string" ? Date.parse(value.timestampValue) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function wholeNumber(value) {
  const n = value && value.integerValue != null ? Number.parseInt(value.integerValue, 10) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Counting a view
// ---------------------------------------------------------------------------
// The whole decision happens against ONE read of the visitor's record, and the writes only go through if that
// record is still exactly as it was read (a "precondition"). So two requests racing each other (a double tap, two
// tabs, a retry after a dropped connection) can never both count: the loser fails the precondition, reads again,
// sees the first one's record, and answers "recent". The video's total goes up in the SAME commit as the visitor's
// record, so the total and the records can't drift apart either, and it uses Firestore's own increment, so
// different visitors counting at the same moment never overwrite each other.
async function countView(ctx, serviceAccount, uid, videoId) {
  const accessToken = await getGoogleAccessToken(ctx, serviceAccount);
  const viewPath = `videos/${videoId}/views/${uid}`;
  const videoPath = `videos/${videoId}`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const now = ctx.now();
    const existing = await firestoreGet(ctx, serviceAccount, accessToken, viewPath);
    const fields = (existing && existing.fields) || {};

    // The race protection below hangs on the record's update time. Firestore always sends one; if it ever doesn't,
    // stop rather than risk counting twice.
    if (existing && !existing.updateTime) throw new StoreError("other", 200, "", "A visitor record came back without an update time.");

    const last = timestampMs(fields.lastViewedAt);
    if (existing && last !== null && now.getTime() - last < VIEW_WINDOW_MS) {
      return { counted: false, reason: "recent", viewCount: null, nextEligibleAt: new Date(last + VIEW_WINDOW_MS).toISOString() };
    }

    const iso = now.toISOString();
    const writes = [
      {
        update: {
          name: resourceName(serviceAccount, viewPath),
          fields: {
            count: { integerValue: String((wholeNumber(fields.count) || 0) + 1) },
            firstViewedAt: timestampMs(fields.firstViewedAt) !== null ? fields.firstViewedAt : { timestampValue: iso },
            lastViewedAt: { timestampValue: iso },
          },
        },
        // First view: the record must not exist yet. Coming back after 24 h: it must be unchanged since we read it.
        currentDocument: existing ? { updateTime: existing.updateTime } : { exists: false },
      },
      {
        // "Change nothing except add 1 to viewCount": a pure transform (the `transform` operation of Firestore's v1 write
        // API). It has no `update` part at all, so there is nothing in it that could overwrite the video's own fields
        // (title, key, cover picture ...), whatever a server might make of an update with no fields. Firestore applies
        // the increment itself, so visitors counting at the same moment never overwrite each other's +1.
        transform: {
          document: resourceName(serviceAccount, videoPath),
          fieldTransforms: [{ fieldPath: "viewCount", increment: { integerValue: "1" } }],
        },
        // The video must exist. If it doesn't, nothing at all is written (no stray visitor records).
        currentDocument: { exists: true },
      },
    ];

    const result = await firestoreCommit(ctx, serviceAccount, accessToken, writes);
    if (result.ok) {
      return {
        counted: true,
        viewCount: await newTotal(ctx, serviceAccount, accessToken, videoPath, result.data),
        nextEligibleAt: new Date(now.getTime() + VIEW_WINDOW_MS).toISOString(),
      };
    }

    // Only "something it depended on changed or isn't there" is worth another go; anything else is a real problem.
    const kind = result.error.kind;
    if (kind !== "not_found" && kind !== "conflict") throw result.error;
    // Either the video is gone, or another request got in first. Look at the video once to tell which (whatever
    // status code Firestore used to say "refused").
    const video = await firestoreGet(ctx, serviceAccount, accessToken, videoPath);
    if (!video) throw new ApiError(404, "no_video", "That video doesn't exist.");
    if (attempt < MAX_ATTEMPTS) await ctx.sleep(15 * attempt + Math.floor(Math.random() * 25));
  }
  throw new ApiError(503, "busy", "Busy right now. Please try again in a moment.");
}

// The new total comes back inside the commit's answer (what the increment produced). If for some reason it
// doesn't, one extra read finds it; and if that fails too the browser just shows its own total plus one.
async function newTotal(ctx, serviceAccount, accessToken, videoPath, commitData) {
  const results = commitData && Array.isArray(commitData.writeResults) ? commitData.writeResults : [];
  const transformed = results[1] && Array.isArray(results[1].transformResults) ? results[1].transformResults[0] : null;
  const fromCommit = wholeNumber(transformed);
  if (fromCommit !== null) return fromCommit;
  try {
    const video = await firestoreGet(ctx, serviceAccount, accessToken, videoPath);
    return wholeNumber(video && video.fields && video.fields.viewCount);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------
async function handle(ctx, req) {
  const method = (req.method || "GET").toUpperCase();
  if (method !== "POST") throw new ApiError(405, "method", "Use POST.");

  const body = await readJsonBody(req);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "bad_json", "The request wasn't valid JSON.");
  if (body.action !== "view") throw new ApiError(400, "bad_action", "Unknown action.");
  const videoId = typeof body.videoId === "string" ? body.videoId : "";
  if (!ID_RE.test(videoId) || !safeSegment(videoId)) throw new ApiError(400, "bad_video", "That isn't a video id.");

  const serviceAccount = parseServiceAccount(ctx.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  if (!serviceAccount) throw new ApiError(501, "not_configured", "Views aren't set up on the server yet.");

  const uid = await verifyVisitor(ctx, req, serviceAccount);
  const result = await countView(ctx, serviceAccount, uid, videoId);
  return jsonResponse(200, { ok: true, ...result });
}

function makeHandler(deps = {}) {
  const ctx = {
    env: deps.env || process.env,
    fetch: deps.fetch || ((...args) => fetch(...args)),
    now: deps.now || (() => new Date()),
    sleep: deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    cache: { google: null, certs: null, certsUntil: 0 }, // kept between calls while the server instance stays warm
  };

  return async function handler(req, res) {
    let result;
    try {
      result = await handle(ctx, req);
    } catch (error) {
      if (error instanceof ApiError) {
        result = jsonResponse(
          error.status,
          { error: error.message, code: error.code, ...error.extra },
          error.status === 405 ? { Allow: "POST" } : undefined
        );
      } else if (error instanceof StoreError) {
        // Details go to the server log only, never to the visitor.
        console.error("Engagement store error:", error.kind, error.httpStatus, error.googleStatus, error.message);
        if (error.kind === "unavailable") {
          result = jsonResponse(503, { error: "Views are unavailable for a moment.", code: "store_unavailable" });
        } else if (error.kind === "denied") {
          result = jsonResponse(500, { error: "The server isn't allowed to save views yet.", code: "store_denied" });
        } else {
          result = jsonResponse(500, { error: "Something went wrong on the server.", code: "store" });
        }
      } else {
        console.error("Unexpected engagement endpoint error:", error && error.message);
        result = jsonResponse(500, { error: "Something went wrong on the server.", code: "server" });
      }
    }
    if (res && typeof res.setHeader === "function") {
      sendNode(res, result);
      return;
    }
    return toWebResponse(result);
  };
}

const handler = makeHandler();
handler.makeHandler = makeHandler;
handler._internals = {
  VIEW_WINDOW_MS,
  MAX_ATTEMPTS,
  ID_RE,
  UID_RE,
  parseServiceAccount,
  verifyFirebaseIdToken,
  classifyFailure,
  signJwt,
};

module.exports = handler;
