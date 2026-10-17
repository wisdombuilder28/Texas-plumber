// api/videos.js
//
// Video storage API for the admin "Videos" page, plus a small public endpoint that makes
// short-lived play links. Zero dependencies (Node's built-in crypto + fetch only), same style as
// api/analytics.js.
//
// How uploads work: a video is far bigger than a Vercel function can receive (4.5 MB), so the
// phone uploads it straight to the storage bucket. This function is the gatekeeper: it checks that
// the person is a logged-in admin, then hands the phone one-time, expiring upload links.
//
// Storage is any S3-compatible service (Backblaze B2 today; Cloudflare R2 etc. later, just by
// changing the STORAGE_* variables in Vercel). The bucket stays PRIVATE. Visitors get a temporary
// signed link for a video each time they press play (action=play).
//
// Vercel environment variables:
//   FIREBASE_SERVICE_ACCOUNT_JSON  already set for analytics (used to check the admin list)
//   STORAGE_ENDPOINT               e.g. s3.us-west-004.backblazeb2.com   (from the bucket page)
//   STORAGE_BUCKET                 the bucket name
//   STORAGE_KEY_ID                 application key ID   (a normal key limited to that one bucket)
//   STORAGE_APP_KEY                application key secret
//   STORAGE_CAP_GB   (optional)    stop accepting uploads above this many GB. Default 9.
//   STORAGE_REGION   (optional)    only for services whose region can't be read from the endpoint
//   STORAGE_PROVIDER (optional)    label saved with each video. Default "b2".
//   STORAGE_CORS_ORIGINS (optional) extra https sites allowed to upload (comma separated), e.g.
//                                  a custom domain. The one-time "Storage setup" adds the live
//                                  site and the page you run it from automatically.

"use strict";

const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Limits. The admin page reads these from ?action=status, so this is the one place to change them.
// ---------------------------------------------------------------------------
const MB = 1024 * 1024;
const LIMITS = {
  maxUploadBytes: 400 * MB, // biggest shrunk video we accept
  maxSeconds: 12 * 60, //      longest video (the client's go up to 10 minutes)
  slackSeconds: 5,
  partSize: 8 * MB, //         uploads are cut into parts of this size (storage minimum is 5 MB)
  testMaxBytes: 1 * MB, //     the built-in storage test uploads a tiny file
};

const VIDEO_KEY = /^videos\/[A-Za-z0-9_-]{8,64}\.(mp4|webm)$/;
const TEST_KEY = /^test\/[A-Za-z0-9_-]{8,64}\.bin$/;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MIME_EXT = { "video/mp4": "mp4", "video/webm": "webm" };

const UPLOAD_LINK_SECONDS = 12 * 3600; // upload links stay valid this long
const PLAY_LINK_SECONDS = 6 * 3600; //    play links stay valid this long
const PLAY_WINDOW_MS = 3600 * 1000; //    ...and are re-used for an hour so browsers can cache the video

const DATASTORE = "https://www.googleapis.com/auth/datastore";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SECURE_TOKEN_CERTS =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

let cachedGoogleToken = null;
let cachedCerts = null;
let cachedCertsUntil = 0;

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

function jsonResponse(status, body) {
  return {
    status,
    body,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
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

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  let raw = "";
  if (typeof req.body === "string") raw = req.body;
  else if (Buffer.isBuffer(req.body)) raw = req.body.toString("utf8");
  else if (typeof req.text === "function") raw = await req.text(); // Web Request style
  else if (typeof req.on === "function") {
    raw = await new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > 1024 * 1024) {
          reject(new ApiError(413, "too_big", "Request is too big."));
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new ApiError(400, "bad_json", "The request wasn't valid JSON.");
  }
}

// ---------------------------------------------------------------------------
// Storage settings (from Vercel environment variables)
// ---------------------------------------------------------------------------
function deriveRegion(host) {
  let m = /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/i.exec(host);
  if (m) return m[1];
  if (/\.r2\.cloudflarestorage\.com$/i.test(host)) return "auto";
  m = /^s3[.-]([a-z0-9-]+)\.amazonaws\.com$/i.exec(host);
  if (m) return m[1];
  return null;
}

function readStorageConfig(env) {
  const raw = String(env.STORAGE_ENDPOINT || "").trim();
  const bucket = String(env.STORAGE_BUCKET || "").trim();
  const keyId = String(env.STORAGE_KEY_ID || "").trim();
  const secret = String(env.STORAGE_APP_KEY || "").trim();
  const missing = [];
  if (!raw) missing.push("STORAGE_ENDPOINT");
  if (!bucket) missing.push("STORAGE_BUCKET");
  if (!keyId) missing.push("STORAGE_KEY_ID");
  if (!secret) missing.push("STORAGE_APP_KEY");
  if (missing.length) return { ok: false, missing };

  // People paste the endpoint with or without https:// and sometimes with the bucket on the end.
  const host = raw.replace(/^https?:\/\//i, "").split("/")[0].trim().toLowerCase();
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(host)) {
    return { ok: false, missing: [], bad: "STORAGE_ENDPOINT doesn't look like a web address (example: s3.us-west-004.backblazeb2.com)." };
  }
  if (!/^[A-Za-z0-9._-]{3,63}$/.test(bucket)) {
    return { ok: false, missing: [], bad: "STORAGE_BUCKET should be just the bucket name (letters, numbers and dashes)." };
  }
  const region = String(env.STORAGE_REGION || "").trim() || deriveRegion(host.split(":")[0]);
  if (!region) {
    return { ok: false, missing: [], bad: "Can't work out the region from STORAGE_ENDPOINT. Add a STORAGE_REGION variable." };
  }
  const capGb = Number(env.STORAGE_CAP_GB);
  return {
    ok: true,
    host,
    bucket,
    keyId,
    secret,
    region,
    provider: String(env.STORAGE_PROVIDER || "b2").trim().slice(0, 20) || "b2",
    capBytes: Math.round((Number.isFinite(capGb) && capGb > 0 ? capGb : 9) * 1e9),
  };
}

// ---------------------------------------------------------------------------
// AWS Signature V4 (what every S3-compatible service uses)
// ---------------------------------------------------------------------------
const sha256hex = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

// RFC 3986 "unreserved" characters stay as they are; everything else becomes %XX.
function enc(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
function encPath(key) {
  return String(key).split("/").map(enc).join("/");
}
function canonQuery(pairs) {
  return pairs
    .map(([k, v]) => [enc(k), enc(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}
function amzDate(date) {
  return date.toISOString().replace(/[-:]|\.\d{3}/g, ""); // 20130524T000000Z
}
function signingKey(secret, dateStamp, region) {
  return hmac(hmac(hmac(hmac("AWS4" + secret, dateStamp), region), "s3"), "aws4_request");
}

// Signs a request with an Authorization header. `headers` must already contain host, x-amz-date
// and x-amz-content-sha256; `path` must already be URI-encoded.
function signV4({ method, host, path, query = [], headers, payloadHash, region, keyId, secret, t }) {
  const hdrs = {};
  for (const [k, v] of Object.entries(headers)) hdrs[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");
  hdrs.host = host;
  const names = Object.keys(hdrs).sort();
  const canonicalHeaders = names.map((n) => `${n}:${hdrs[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [method, path, canonQuery(query), canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const dateStamp = t.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", t, scope, sha256hex(canonicalRequest)].join("\n");
  const signature = hmac(signingKey(secret, dateStamp, region), stringToSign).toString("hex");
  return {
    signature,
    signedHeaders,
    canonicalRequest,
    authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// Makes a link that works without any password until it expires (used for uploads and playback).
function presignRaw({ method, host, path, query = [], expires, region, keyId, secret, now }) {
  const t = amzDate(now);
  const dateStamp = t.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const params = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${keyId}/${scope}`],
    ["X-Amz-Date", t],
    ["X-Amz-Expires", String(expires)],
    ["X-Amz-SignedHeaders", "host"],
    ...query,
  ];
  const cq = canonQuery(params);
  const canonicalRequest = [method, path, cq, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", t, scope, sha256hex(canonicalRequest)].join("\n");
  const signature = hmac(signingKey(secret, dateStamp, region), stringToSign).toString("hex");
  return `https://${host}${path}?${cq}&X-Amz-Signature=${signature}`;
}

function objectPath(cfg, key) {
  return key ? `/${enc(cfg.bucket)}/${encPath(key)}` : `/${enc(cfg.bucket)}`;
}

function presign(cfg, { method, key, query = [], expires, now }) {
  return presignRaw({
    method,
    host: cfg.host,
    path: objectPath(cfg, key),
    query,
    expires,
    region: cfg.region,
    keyId: cfg.keyId,
    secret: cfg.secret,
    now,
  });
}

// ---------------------------------------------------------------------------
// Tiny XML helpers (the storage replies in XML)
// ---------------------------------------------------------------------------
const xmlDecode = (s) =>
  String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
const xmlEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function xmlTag(xml, tag) {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? xmlDecode(m[1]) : null;
}
function xmlBlocks(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]);
}

// ---------------------------------------------------------------------------
// Talking to the storage (S3 API)
// ---------------------------------------------------------------------------
class StorageError extends Error {
  constructor(status, code, message, network) {
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code || "";
    this.network = !!network;
  }
}

// Plain-English version of whatever the storage said, safe to show in the admin page.
function explainStorageError(e) {
  if (e instanceof ApiError) return e.message;
  if (!(e instanceof StorageError)) return "Something unexpected went wrong talking to the storage.";
  if (e.network) {
    return "Can't reach the storage. Check STORAGE_ENDPOINT in Vercel (it should look like s3.us-west-004.backblazeb2.com).";
  }
  const c = e.code;
  if (c === "InvalidAccessKeyId" || c === "SignatureDoesNotMatch" || e.status === 401) {
    return "The storage didn't accept the key. Check STORAGE_KEY_ID and STORAGE_APP_KEY in Vercel, then redeploy.";
  }
  if (c === "NoSuchBucket") return "The storage can't find that bucket. Check STORAGE_BUCKET in Vercel.";
  if (c === "NoSuchUpload") return "That upload has expired or was already finished. Start the video again.";
  if (c === "AccessDenied" || e.status === 403) {
    return "The storage says this key isn't allowed to do that. Make the key for this one bucket with Read and Write access.";
  }
  if (e.status >= 500) return "The storage is having trouble right now. Try again in a minute.";
  return `The storage refused the request (${c || "HTTP " + e.status}).`;
}

async function s3Call(ctx, cfg, { method, key = "", query = [], headers = {}, body = "", timeoutMs = 20000 }) {
  const t = amzDate(ctx.now());
  const payloadHash = sha256hex(body);
  const path = objectPath(cfg, key);
  const hdrs = { ...headers, "x-amz-content-sha256": payloadHash, "x-amz-date": t, host: cfg.host };
  const signed = signV4({
    method,
    host: cfg.host,
    path,
    query,
    headers: hdrs,
    payloadHash,
    region: cfg.region,
    keyId: cfg.keyId,
    secret: cfg.secret,
    t,
  });
  const sendHeaders = { ...headers, "x-amz-content-sha256": payloadHash, "x-amz-date": t, authorization: signed.authorization };
  const cq = canonQuery(query);
  const url = `https://${cfg.host}${path}${cq ? "?" + cq : ""}`;

  let res;
  try {
    res = await ctx.fetch(url, {
      method,
      headers: sendHeaders,
      body: body === "" ? undefined : body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new StorageError(0, "", String((error && error.message) || error), true);
  }
  const text = method === "HEAD" ? "" : await res.text().catch(() => "");
  if (!res.ok) {
    throw new StorageError(res.status, xmlTag(text, "Code") || "", xmlTag(text, "Message") || "");
  }
  // A few S3 calls answer "200 OK" and then put an error in the body.
  if (/^\s*(<\?xml[^>]*\?>\s*)?<Error[\s>]/.test(text)) {
    throw new StorageError(res.status, xmlTag(text, "Code") || "", xmlTag(text, "Message") || "");
  }
  return { status: res.status, headers: res.headers, text };
}

async function createMultipart(ctx, cfg, key, contentType) {
  const r = await s3Call(ctx, cfg, {
    method: "POST",
    key,
    query: [["uploads", ""]],
    headers: { "content-type": contentType },
  });
  const uploadId = xmlTag(r.text, "UploadId");
  if (!uploadId) throw new StorageError(r.status, "NoUploadId", "The storage didn't return an upload id.");
  return uploadId;
}

async function listParts(ctx, cfg, key, uploadId) {
  const parts = [];
  let marker = null;
  for (let page = 0; page < 20; page++) {
    const query = [["uploadId", uploadId]];
    if (marker) query.push(["part-number-marker", marker]);
    const r = await s3Call(ctx, cfg, { method: "GET", key, query });
    for (const block of xmlBlocks(r.text, "Part")) {
      parts.push({
        n: Number(xmlTag(block, "PartNumber")),
        size: Number(xmlTag(block, "Size")),
        etag: String(xmlTag(block, "ETag") || "").replace(/^"+|"+$/g, ""),
      });
    }
    if (xmlTag(r.text, "IsTruncated") !== "true") break;
    marker = xmlTag(r.text, "NextPartNumberMarker") || String(parts[parts.length - 1]?.n || "0");
  }
  return parts.sort((a, b) => a.n - b.n);
}

async function completeMultipart(ctx, cfg, key, uploadId, parts) {
  const body =
    '<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
    parts.map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`).join("") +
    "</CompleteMultipartUpload>";
  const r = await s3Call(ctx, cfg, {
    method: "POST",
    key,
    query: [["uploadId", uploadId]],
    headers: { "content-type": "application/xml" },
    body,
    timeoutMs: 30000,
  });
  return { versionId: r.headers.get("x-amz-version-id") || null };
}

async function abortMultipart(ctx, cfg, key, uploadId) {
  try {
    await s3Call(ctx, cfg, { method: "DELETE", key, query: [["uploadId", uploadId]] });
  } catch (e) {
    if (e instanceof StorageError && (e.code === "NoSuchUpload" || e.status === 404)) return; // already gone
    throw e;
  }
}

// Total size of every video in the bucket (only finished uploads count).
async function listUsage(ctx, cfg) {
  let bytes = 0;
  let count = 0;
  let token = null;
  for (let page = 0; page < 20; page++) {
    const query = [
      ["list-type", "2"],
      ["max-keys", "1000"],
      ["prefix", "videos/"],
    ];
    if (token) query.push(["continuation-token", token]);
    const r = await s3Call(ctx, cfg, { method: "GET", query });
    for (const block of xmlBlocks(r.text, "Contents")) {
      bytes += Number(xmlTag(block, "Size")) || 0;
      count += 1;
    }
    if (xmlTag(r.text, "IsTruncated") !== "true") break;
    token = xmlTag(r.text, "NextContinuationToken");
    if (!token) break;
  }
  return { bytes, count };
}

// Backblaze keeps old versions of a file unless you delete each version, so a plain DELETE would
// leave the bytes (and the bill) behind. Delete every version of exactly this key.
async function deleteEveryVersion(ctx, cfg, key) {
  let removed = 0;
  let keyMarker = null;
  let versionMarker = null;
  for (let page = 0; page < 10; page++) {
    const query = [
      ["versions", ""],
      ["prefix", key],
      ["max-keys", "1000"],
    ];
    if (keyMarker) query.push(["key-marker", keyMarker]);
    if (versionMarker) query.push(["version-id-marker", versionMarker]);
    const r = await s3Call(ctx, cfg, { method: "GET", query });
    const entries = [...xmlBlocks(r.text, "Version"), ...xmlBlocks(r.text, "DeleteMarker")];
    for (const block of entries) {
      if (xmlTag(block, "Key") !== key) continue;
      const versionId = xmlTag(block, "VersionId");
      if (!versionId) continue;
      await s3Call(ctx, cfg, { method: "DELETE", key, query: [["versionId", versionId]] });
      removed += 1;
    }
    if (xmlTag(r.text, "IsTruncated") !== "true") break;
    keyMarker = xmlTag(r.text, "NextKeyMarker");
    versionMarker = xmlTag(r.text, "NextVersionIdMarker");
    if (!keyMarker) break;
  }
  if (!removed) {
    // Nothing listed: fall back to a plain delete. A file that's already gone counts as deleted.
    try {
      await s3Call(ctx, cfg, { method: "DELETE", key });
    } catch (e) {
      if (!(e instanceof StorageError && e.status === 404)) throw e;
    }
  }
  return removed;
}

async function cleanUnfinished(ctx, cfg, olderThanMs) {
  const r = await s3Call(ctx, cfg, {
    method: "GET",
    query: [
      ["uploads", ""],
      ["prefix", "videos/"],
      ["max-uploads", "1000"],
    ],
  });
  let aborted = 0;
  const cutoff = ctx.now().getTime() - olderThanMs;
  for (const block of xmlBlocks(r.text, "Upload")) {
    const key = xmlTag(block, "Key");
    const uploadId = xmlTag(block, "UploadId");
    const started = Date.parse(xmlTag(block, "Initiated") || "");
    if (!key || !uploadId || !VIDEO_KEY.test(key)) continue;
    if (Number.isFinite(started) && started > cutoff) continue; // maybe still uploading
    await abortMultipart(ctx, cfg, key, uploadId);
    aborted += 1;
  }
  return aborted;
}

// ---------------------------------------------------------------------------
// Admin check (same method as api/analytics.js: verify the Firebase login token, then look the
// person up in the Firestore `admins` collection)
// ---------------------------------------------------------------------------
function normalizePrivateKey(privateKey) {
  return String(privateKey || "").replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();
}

function parseServiceAccount(raw) {
  if (!raw) return null;
  let text = String(raw).trim().replace(/^﻿/, "");
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
  if (cachedGoogleToken && cachedGoogleToken.exp > now + 60 && cachedGoogleToken.email === serviceAccount.client_email) {
    return cachedGoogleToken.token;
  }
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
  const res = await ctx.fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Google access token failed: ${data.error_description || data.error || `token HTTP ${res.status}`}`);
  }
  cachedGoogleToken = { token: data.access_token, exp: now + Number(data.expires_in || 3600), email: serviceAccount.client_email };
  return cachedGoogleToken.token;
}

async function getSecureTokenCerts(ctx) {
  if (cachedCerts && ctx.now().getTime() < cachedCertsUntil) return cachedCerts;
  const res = await ctx.fetch(SECURE_TOKEN_CERTS);
  if (!res.ok) throw new Error(`Could not fetch Firebase signing certs (HTTP ${res.status})`);
  cachedCerts = await res.json();
  const cacheControl = res.headers.get("cache-control") || "";
  const maxAge = Number((/max-age=(\d+)/.exec(cacheControl) || [])[1] || 3600);
  cachedCertsUntil = ctx.now().getTime() + maxAge * 1000;
  return cachedCerts;
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
  if (!payload.sub) throw new Error("Token is missing a user id");
  if (Number(payload.exp || 0) <= now) throw new Error("Token has expired");
  if (Number(payload.iat || 0) > now + 60) throw new Error("Token is not yet valid");
  const certs = await getSecureTokenCerts(ctx);
  const cert = certs[header.kid];
  if (!cert) throw new Error("Unknown token signing key");
  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(decoded.data);
  verifier.end();
  if (!verifier.verify(cert, decoded.signature, "base64url")) throw new Error("Token signature is invalid");
  return payload;
}

async function verifyAdmin(ctx, req) {
  const serviceAccount = parseServiceAccount(ctx.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  if (!serviceAccount) {
    return { ok: false, status: 501, error: "FIREBASE_SERVICE_ACCOUNT_JSON is missing or invalid in Vercel." };
  }
  const authHeader = getHeader(req, "authorization");
  if (!authHeader.toLowerCase().startsWith("bearer ")) return { ok: false, status: 401, error: "Please sign in again." };
  const token = authHeader.slice(7).trim();
  if (!token) return { ok: false, status: 401, error: "Please sign in again." };

  let payload;
  try {
    payload = await verifyFirebaseIdToken(ctx, token, serviceAccount.project_id);
  } catch (error) {
    console.error("Firebase token verification failed:", error && error.message);
    return { ok: false, status: 401, error: "Your session expired. Refresh the page and sign in again." };
  }

  const uid = payload.user_id || payload.sub;
  let accessToken;
  try {
    accessToken = await getGoogleAccessToken(ctx, serviceAccount);
  } catch (error) {
    console.error("Google token failed:", error && error.message);
    return { ok: false, status: 500, error: "Could not check admin access (Google sign-in for the server failed)." };
  }
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(serviceAccount.project_id)}/databases/(default)/documents/admins/${encodeURIComponent(uid)}`;
  const res = await ctx.fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 404) return { ok: false, status: 403, error: "This account isn't an admin." };
  if (!res.ok) {
    console.error("Admin lookup failed:", res.status);
    return { ok: false, status: 500, error: "Could not check admin access. Confirm the service account can read Firestore." };
  }
  return { ok: true, uid };
}

// ---------------------------------------------------------------------------
// One-time setup with the Backblaze master key (browser uploads need a CORS rule, and Backblaze's
// website can't create that kind; only its API can). The key is used for these few calls and then
// forgotten: it is never saved, logged or sent back.
// ---------------------------------------------------------------------------
const B2_API = "https://api.backblazeb2.com/b2api/v4";

async function b2Json(ctx, url, { method = "POST", token, body } = {}) {
  let res;
  try {
    res = await ctx.fetch(url, {
      method,
      headers: { ...(token ? { Authorization: token } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new ApiError(502, "b2_unreachable", "Couldn't reach Backblaze. Try again in a minute.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status === 401 ? 401 : 502, "b2_error", `Backblaze said: ${data.message || data.code || "HTTP " + res.status}`, { b2Code: data.code });
  }
  return data;
}

async function setupBucket(ctx, cfg, { keyId, key }, origins) {
  const basic = Buffer.from(`${keyId}:${key}`).toString("base64");
  let authRes;
  try {
    authRes = await ctx.fetch(`${B2_API}/b2_authorize_account`, {
      headers: { Authorization: `Basic ${basic}` },
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new ApiError(502, "b2_unreachable", "Couldn't reach Backblaze. Try again in a minute.");
  }
  const auth = await authRes.json().catch(() => ({}));
  if (!authRes.ok) {
    throw new ApiError(
      400,
      "b2_bad_key",
      "Backblaze didn't accept that key. Use the master application key (Application Keys page → Generate New Master Application Key): both the key ID and the key."
    );
  }
  const apiUrl = auth.apiInfo?.storageApi?.apiUrl;
  const token = auth.authorizationToken;
  const accountId = auth.accountId;
  if (!apiUrl || !token || !accountId) throw new ApiError(502, "b2_odd_reply", "Backblaze's reply wasn't what we expected.");

  const listed = await b2Json(ctx, `${apiUrl}/b2api/v4/b2_list_buckets`, { token, body: { accountId, bucketName: cfg.bucket } });
  const bucket = (listed.buckets || [])[0];
  if (!bucket) {
    throw new ApiError(404, "b2_no_bucket", `That Backblaze account has no bucket called "${cfg.bucket}". Check STORAGE_BUCKET in Vercel.`);
  }

  const corsRules = [
    {
      corsRuleName: "nd-flow-browser-upload",
      allowedOrigins: origins,
      allowedOperations: ["s3_put", "s3_get"],
      allowedHeaders: ["*"],
      exposeHeaders: ["ETag"],
      maxAgeSeconds: 3600,
    },
  ];
  // "Keep only the last version of the file": when a video is deleted its bytes go away for good.
  const lifecycleRules = [{ fileNamePrefix: "", daysFromUploadingToHiding: null, daysFromHidingToDeleting: 1 }];

  await b2Json(ctx, `${apiUrl}/b2api/v4/b2_update_bucket`, {
    token,
    body: { accountId, bucketId: bucket.bucketId, ifRevisionIs: bucket.revision, corsRules, lifecycleRules },
  });

  // Read it back so the page can say what was really saved.
  const after = await b2Json(ctx, `${apiUrl}/b2api/v4/b2_list_buckets`, { token, body: { accountId, bucketName: cfg.bucket } });
  const saved = (after.buckets || [])[0] || {};
  const rule = (saved.corsRules || []).find((r) => r.corsRuleName === "nd-flow-browser-upload");
  const s3Host = (() => {
    try {
      return new URL(auth.apiInfo.storageApi.s3ApiUrl).host;
    } catch {
      return null;
    }
  })();
  return {
    corsSaved: !!rule && (rule.allowedOperations || []).includes("s3_put"),
    origins: rule ? rule.allowedOrigins : [],
    lifecycleSaved: (saved.lifecycleRules || []).some((r) => r.daysFromHidingToDeleting === 1),
    bucketType: saved.bucketType || bucket.bucketType,
    s3Host,
    endpointMatches: s3Host ? s3Host === cfg.host : null,
  };
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------
function cleanOrigins(req, env) {
  const set = new Set();
  const add = (o) => {
    try {
      const u = new URL(String(o).trim());
      if (u.protocol === "https:") set.add(u.origin);
    } catch {
      /* ignore */
    }
  };
  add(getHeader(req, "origin"));
  add("https://nd-flow-plumbing.vercel.app");
  String(env.STORAGE_CORS_ORIGINS || "")
    .split(",")
    .filter(Boolean)
    .forEach(add);
  return [...set];
}

function isInt(n) {
  return typeof n === "number" && Number.isInteger(n);
}

async function actionPlay(ctx, cfg, url) {
  const key = url.searchParams.get("key") || "";
  if (!VIDEO_KEY.test(key)) throw new ApiError(400, "bad_key", "That isn't a video link.");
  // Sign "as of" the start of the current hour, so everyone asking within the hour gets the
  // same link (the browser can then reuse what it already downloaded).
  const signedAt = new Date(Math.floor(ctx.now().getTime() / PLAY_WINDOW_MS) * PLAY_WINDOW_MS);
  const playUrl = presign(cfg, { method: "GET", key, expires: PLAY_LINK_SECONDS, now: signedAt });
  return {
    url: playUrl,
    expiresAt: new Date(signedAt.getTime() + PLAY_LINK_SECONDS * 1000).toISOString(),
  };
}

async function actionStatus(ctx, cfg) {
  const base = {
    configured: true,
    provider: cfg.provider,
    bucket: cfg.bucket,
    endpoint: cfg.host,
    limits: {
      maxUploadBytes: LIMITS.maxUploadBytes,
      maxSeconds: LIMITS.maxSeconds,
      partSize: LIMITS.partSize,
      capBytes: cfg.capBytes,
    },
  };
  try {
    const usage = await listUsage(ctx, cfg);
    return { ...base, storageOk: true, usedBytes: usage.bytes, objectCount: usage.count };
  } catch (e) {
    if (!(e instanceof StorageError)) throw e;
    console.error("Storage check failed:", e.status, e.code);
    return { ...base, storageOk: false, usedBytes: null, problem: explainStorageError(e), detail: e.code || String(e.status || "") };
  }
}

async function actionInit(ctx, cfg, body) {
  const test = body.purpose === "test";
  const id = String(body.id || "");
  if (!ID_RE.test(id)) throw new ApiError(400, "bad_id", "Missing or bad video id.");
  const size = body.size;
  if (!isInt(size) || size < 1) throw new ApiError(400, "bad_size", "Missing video size.");

  let key;
  let contentType;
  if (test) {
    if (size > LIMITS.testMaxBytes) throw new ApiError(400, "bad_size", "Test file is too big.");
    key = `test/${id}.bin`;
    contentType = "application/octet-stream";
  } else {
    const ext = MIME_EXT[body.mime];
    if (!ext) throw new ApiError(400, "bad_type", "Only MP4 or WebM videos can be uploaded.");
    if (size > LIMITS.maxUploadBytes) {
      throw new ApiError(413, "too_big", `This video is ${Math.round(size / MB)} MB after shrinking. The limit is ${Math.round(LIMITS.maxUploadBytes / MB)} MB.`);
    }
    const seconds = body.durationSec;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
      throw new ApiError(400, "bad_duration", "Missing video length.");
    }
    if (seconds > LIMITS.maxSeconds + LIMITS.slackSeconds) {
      throw new ApiError(413, "too_long", `Videos can be at most ${Math.round(LIMITS.maxSeconds / 60)} minutes long.`);
    }
    const usage = await listUsage(ctx, cfg);
    if (usage.bytes + size > cfg.capBytes) {
      throw new ApiError(
        409,
        "storage_full",
        `The video storage is nearly full (${(usage.bytes / 1e9).toFixed(1)} GB used of ${(cfg.capBytes / 1e9).toFixed(0)} GB). Delete some old videos first.`
      );
    }
    key = `videos/${id}.${ext}`;
    contentType = body.mime;
  }

  const partCount = Math.max(1, Math.ceil(size / LIMITS.partSize));
  const uploadId = await createMultipart(ctx, cfg, key, contentType);
  const now = ctx.now();
  const urls = [];
  for (let n = 1; n <= partCount; n++) {
    urls.push(
      presign(cfg, {
        method: "PUT",
        key,
        query: [
          ["partNumber", String(n)],
          ["uploadId", uploadId],
        ],
        expires: UPLOAD_LINK_SECONDS,
        now,
      })
    );
  }
  return { key, uploadId, partSize: LIMITS.partSize, partCount, urls, provider: cfg.provider };
}

function checkKey(key, allowTest) {
  if (VIDEO_KEY.test(key) || (allowTest && TEST_KEY.test(key))) return;
  throw new ApiError(400, "bad_key", "That isn't a video file name.");
}

async function actionComplete(ctx, cfg, body) {
  const key = String(body.key || "");
  const uploadId = String(body.uploadId || "");
  checkKey(key, true);
  if (!uploadId || uploadId.length > 2048) throw new ApiError(400, "bad_upload", "Missing upload id.");
  const size = body.size;
  if (!isInt(size) || size < 1) throw new ApiError(400, "bad_size", "Missing video size.");

  const parts = await listParts(ctx, cfg, key, uploadId);
  const have = parts.reduce((sum, p) => sum + p.size, 0);
  const limit = TEST_KEY.test(key) ? LIMITS.testMaxBytes : LIMITS.maxUploadBytes;
  if (have > limit) {
    await abortMultipart(ctx, cfg, key, uploadId).catch(() => {});
    throw new ApiError(413, "too_big", "That upload is bigger than allowed, so it was cancelled.");
  }
  const wanted = Math.max(1, Math.ceil(size / LIMITS.partSize));
  // Which parts (1, 2, 3...) are absent or the wrong size? The page sends exactly those again.
  const sizeOf = new Map(parts.map((p) => [p.n, p.size]));
  const expected = (n) => (n < wanted ? LIMITS.partSize : size - LIMITS.partSize * (wanted - 1));
  const missing = [];
  for (let n = 1; n <= wanted; n++) if (sizeOf.get(n) !== expected(n)) missing.push(n);
  if (missing.length || parts.length !== wanted || have !== size) {
    // Not abandoned: the page can send the missing parts again and call this once more.
    throw new ApiError(409, "incomplete", "The storage hasn't received the whole video yet.", { have, wanted: size, parts: parts.length, wantedParts: wanted, missing });
  }
  const done = await completeMultipart(ctx, cfg, key, uploadId, parts);
  return { ok: true, key, bytes: have, versionId: done.versionId };
}

async function actionAbort(ctx, cfg, body) {
  const key = String(body.key || "");
  const uploadId = String(body.uploadId || "");
  checkKey(key, true);
  if (!uploadId) throw new ApiError(400, "bad_upload", "Missing upload id.");
  await abortMultipart(ctx, cfg, key, uploadId);
  return { ok: true };
}

async function actionDelete(ctx, cfg, body) {
  const key = String(body.key || "");
  checkKey(key, true);
  const removed = await deleteEveryVersion(ctx, cfg, key);
  return { ok: true, removed };
}

async function actionCleanup(ctx, cfg) {
  const aborted = await cleanUnfinished(ctx, cfg, 3 * 3600 * 1000);
  return { ok: true, aborted };
}

async function actionSetup(ctx, cfg, req, body) {
  const keyId = String(body.masterKeyId || "").trim();
  const key = String(body.masterKey || "").trim();
  if (!/^[A-Za-z0-9]{8,64}$/.test(keyId) || !/^[A-Za-z0-9+/_=-]{16,128}$/.test(key)) {
    throw new ApiError(400, "bad_key", "Paste the master key ID and the master key exactly as Backblaze shows them.");
  }
  const result = await setupBucket(ctx, cfg, { keyId, key }, cleanOrigins(req, ctx.env));
  return { ok: true, ...result };
}

async function handle(ctx, req) {
  const method = (req.method || "GET").toUpperCase();
  const url = new URL(req.url || "/", "http://localhost");
  const isPost = method === "POST";
  if (method !== "GET" && !isPost) throw new ApiError(405, "method", "Method not allowed.");

  const body = isPost ? await readJsonBody(req) : {};
  const action = String(url.searchParams.get("action") || body.action || "");
  const cfg = readStorageConfig(ctx.env);

  // ---- public: a short-lived link for one video ----
  if (action === "play") {
    if (method !== "GET") throw new ApiError(405, "method", "Use GET.");
    if (!cfg.ok) throw new ApiError(501, "not_configured", "Video storage isn't set up yet.");
    return jsonResponse(200, await actionPlay(ctx, cfg, url));
  }

  // ---- everything else is for admins only ----
  const admin = await ctx.verifyAdmin(req);
  if (!admin.ok) throw new ApiError(admin.status, "auth", admin.error);

  if (action === "status") {
    if (!cfg.ok) {
      return jsonResponse(200, { configured: false, missing: cfg.missing || [], problem: cfg.bad || null });
    }
    return jsonResponse(200, await actionStatus(ctx, cfg));
  }

  if (!isPost) throw new ApiError(405, "method", "Use POST.");
  if (!cfg.ok) {
    throw new ApiError(501, "not_configured", cfg.bad || `Video storage isn't set up yet. Missing in Vercel: ${(cfg.missing || []).join(", ")}.`);
  }

  switch (action) {
    case "init":
      return jsonResponse(200, await actionInit(ctx, cfg, body));
    case "complete":
      return jsonResponse(200, await actionComplete(ctx, cfg, body));
    case "abort":
      return jsonResponse(200, await actionAbort(ctx, cfg, body));
    case "delete":
      return jsonResponse(200, await actionDelete(ctx, cfg, body));
    case "cleanup":
      return jsonResponse(200, await actionCleanup(ctx, cfg));
    case "setup":
      return jsonResponse(200, await actionSetup(ctx, cfg, req, body));
    default:
      throw new ApiError(400, "bad_action", "Unknown action.");
  }
}

function makeHandler(deps = {}) {
  const ctx = {
    env: deps.env || process.env,
    fetch: deps.fetch || ((...args) => fetch(...args)),
    now: deps.now || (() => new Date()),
  };
  ctx.verifyAdmin = deps.verifyAdmin || ((req) => verifyAdmin(ctx, req));

  return async function handler(req, res) {
    let result;
    try {
      result = await handle(ctx, req);
    } catch (error) {
      if (error instanceof ApiError) {
        result = jsonResponse(error.status, { error: error.message, code: error.code, ...error.extra });
      } else if (error instanceof StorageError) {
        console.error("Storage error:", error.status, error.code);
        result = jsonResponse(error.network ? 502 : error.status === 404 ? 404 : error.status >= 500 ? 502 : 400, {
          error: explainStorageError(error),
          code: "storage",
          detail: error.code || String(error.status || ""),
        });
      } else {
        console.error("Unexpected videos endpoint error:", error);
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
  LIMITS,
  signV4,
  presignRaw,
  presign,
  canonQuery,
  enc,
  amzDate,
  sha256hex,
  readStorageConfig,
  parseServiceAccount,
  verifyFirebaseIdToken,
  xmlTag,
  xmlBlocks,
};

module.exports = handler;
