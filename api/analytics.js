// api/analytics.js
// Zero-dependency Vercel function. firebase-admin + @google-analytics/data were
// crashing the serverless runtime on boot (FUNCTION_INVOCATION_FAILED), which is
// why the dashboard cards never received a JSON payload.
//
// This file uses only Node's built-in `crypto` + `fetch` to:
//   1. Verify the Firebase ID token
//   2. Confirm the user is in Firestore `admins/{uid}`
//   3. Call the GA4 Data API (REST)

"use strict";

const crypto = require("crypto");

const ANALYTICS_READONLY = "https://www.googleapis.com/auth/analytics.readonly";
const DATASTORE = "https://www.googleapis.com/auth/datastore";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SECURE_TOKEN_CERTS =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

let cachedGoogleToken = null;
let cachedCerts = null;
let cachedCertsUntil = 0;

function jsonResponse(status, body) {
  return {
    status,
    body,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  };
}

function sendNode(res, result) {
  res.statusCode = result.status;
  const headers = result.headers || {};
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
  res.end(JSON.stringify(result.body));
}

function toWebResponse(result) {
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: result.headers,
  });
}

function getHeader(req, name) {
  const headers = req.headers;
  if (!headers) return "";
  if (typeof headers.get === "function") {
    return headers.get(name) || headers.get(name.toLowerCase()) || "";
  }
  const key = name.toLowerCase();
  const value = headers[key] || headers[name];
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

function normalizePrivateKey(privateKey) {
  return String(privateKey || "")
    .replace(/\\n/g, "\n")
    .replace(/\r\n/g, "\n")
    .trim();
}

function parseServiceAccount(raw) {
  if (!raw) return null;

  let text = String(raw).trim().replace(/^\uFEFF/, "");

  // Some dashboards wrap the whole JSON in extra quotes.
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
  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
    return null;
  }

  parsed.private_key = normalizePrivateKey(parsed.private_key);
  if (!parsed.private_key.includes("BEGIN PRIVATE KEY")) return null;
  return parsed;
}

function normalizePropertyId(raw) {
  const value = String(raw || "").trim();
  const stripped = value.replace(/^properties\//, "");
  return stripped;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function todayInLagos() {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Africa/Lagos",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const get = (type) => parts.find((p) => p.type === type)?.value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    const now = new Date();
    return `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(
      now.getUTCDate()
    )}`;
  }
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signJwt(payload, privateKey) {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(data);
  signer.end();
  const signature = signer
    .sign(privateKey, "base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${data}.${signature}`;
}

async function getGoogleAccessToken(serviceAccount, scopes) {
  const now = Math.floor(Date.now() / 1000);
  const scopeKey = scopes.slice().sort().join(" ");
  if (
    cachedGoogleToken &&
    cachedGoogleToken.scopeKey === scopeKey &&
    cachedGoogleToken.exp > now + 60
  ) {
    return cachedGoogleToken.token;
  }

  const assertion = signJwt(
    {
      iss: serviceAccount.client_email,
      sub: serviceAccount.client_email,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
      scope: scopeKey,
    },
    serviceAccount.private_key
  );

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const detail =
      data.error_description || data.error || `token HTTP ${res.status}`;
    const error = new Error(`Google access token failed: ${detail}`);
    error.status = 500;
    throw error;
  }

  cachedGoogleToken = {
    token: data.access_token,
    exp: now + Number(data.expires_in || 3600),
    scopeKey,
  };
  return cachedGoogleToken.token;
}

async function getSecureTokenCerts() {
  if (cachedCerts && Date.now() < cachedCertsUntil) return cachedCerts;

  const res = await fetch(SECURE_TOKEN_CERTS);
  if (!res.ok) {
    throw new Error(`Could not fetch Firebase signing certs (HTTP ${res.status})`);
  }

  cachedCerts = await res.json();
  const cacheControl = res.headers.get("cache-control") || "";
  const maxAge = Number((/max-age=(\d+)/.exec(cacheControl) || [])[1] || 3600);
  cachedCertsUntil = Date.now() + maxAge * 1000;
  return cachedCerts;
}

function decodeJwt(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed Firebase ID token");
  }
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = JSON.parse(
    Buffer.from(headerPart, "base64url").toString("utf8")
  );
  const payload = JSON.parse(
    Buffer.from(payloadPart, "base64url").toString("utf8")
  );
  return {
    header,
    payload,
    data: `${headerPart}.${payloadPart}`,
    signature: signaturePart,
  };
}

async function verifyFirebaseIdToken(token, projectId) {
  const decoded = decodeJwt(token);
  const now = Math.floor(Date.now() / 1000);
  const { header, payload } = decoded;

  if (header.alg !== "RS256") {
    throw new Error("Unexpected token algorithm");
  }
  if (payload.aud !== projectId) {
    throw new Error("Token audience does not match this Firebase project");
  }
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new Error("Token issuer does not match this Firebase project");
  }
  if (!payload.sub) {
    throw new Error("Token is missing a user id");
  }
  if (Number(payload.exp || 0) <= now) {
    throw new Error("Token has expired");
  }
  if (Number(payload.iat || 0) > now + 60) {
    throw new Error("Token is not yet valid");
  }

  const certs = await getSecureTokenCerts();
  const cert = certs[header.kid];
  if (!cert) {
    throw new Error("Unknown token signing key");
  }

  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(decoded.data);
  verifier.end();
  const ok = verifier.verify(cert, decoded.signature, "base64url");
  if (!ok) {
    throw new Error("Token signature is invalid");
  }

  return payload;
}

async function verifyAdmin(req, serviceAccount) {
  const authHeader = getHeader(req, "authorization");
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return { ok: false, status: 401, error: "Missing Authorization header" };
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return { ok: false, status: 401, error: "Missing Firebase ID token" };
  }

  let payload;
  try {
    payload = await verifyFirebaseIdToken(token, serviceAccount.project_id);
  } catch (error) {
    console.error("Firebase token verification failed:", error);
    return { ok: false, status: 401, error: "Invalid or expired session" };
  }

  const uid = payload.user_id || payload.sub;
  const accessToken = await getGoogleAccessToken(serviceAccount, [
    ANALYTICS_READONLY,
    DATASTORE,
  ]);

  const url =
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      serviceAccount.project_id
    )}/databases/(default)/documents/admins/${encodeURIComponent(uid)}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 404) {
    return { ok: false, status: 403, error: "Admin access required" };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("Admin lookup failed:", res.status, detail);
    return {
      ok: false,
      status: 500,
      error:
        "Could not check admin access. Confirm the service account can read Firestore.",
    };
  }

  return { ok: true, uid };
}

function addMonthSpans(today) {
  // month so far, plus the same number of days in the previous month
  const [y, m, day] = today.split("-").map(Number);
  const prevLen = new Date(Date.UTC(y, m - 1, 0)).getUTCDate();
  const iso = (d) => d.toISOString().slice(0, 10);
  return {
    cur: { startDate: `${today.slice(0, 7)}-01`, endDate: today },
    prev: {
      startDate: iso(new Date(Date.UTC(y, m - 2, 1))),
      endDate: iso(new Date(Date.UTC(y, m - 2, Math.min(day, prevLen)))),
    },
  };
}

// GA4 adds a "dateRange" dimension (date_range_0, date_range_1 ...) when a request has several date ranges.
function rows(report) {
  const di = (report?.dimensionHeaders || []).findIndex((h) => h.name === "dateRange");
  return (report?.rows || []).map((row) => {
    const dims = (row.dimensionValues || []).map((v) => v.value);
    return {
      range: di >= 0 ? Number((/(\d+)$/.exec(dims[di]) || [])[1] || 0) : 0,
      dims: dims.filter((_, i) => i !== di),
      metrics: (row.metricValues || []).map((v) => Number(v.value) || 0),
    };
  });
}

function channelBucket(name) {
  const n = String(name || "");
  if (n === "Direct") return "direct";
  if (/Search|Shopping/.test(n)) return "search";
  if (/Social|Video/.test(n)) return "social";
  if (/Referral|Affiliates/.test(n)) return "referral";
  return "other";
}

async function fetchGa4Summary(propertyId, serviceAccount) {
  const accessToken = await getGoogleAccessToken(serviceAccount, [
    ANALYTICS_READONLY,
    DATASTORE,
  ]);
  const today = todayInLagos();
  const month = addMonthSpans(today);
  const last = (n) => ({ startDate: `${n - 1}daysAgo`, endDate: "today" });
  const SPANS = [7, 30, 90, 365];
  const users = { name: "totalUsers" };
  const views = { name: "screenPageViews" };
  const [ty, tm] = today.split("-").map(Number);
  const monthsFrom = new Date(Date.UTC(ty, tm - 12, 1)).toISOString().slice(0, 10); // first day, 11 months back

  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:batchRunReports`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requests: [
          // 0: all-time totals, last 30 days, and the 30 days before
          { dateRanges: [{ startDate: "3650daysAgo", endDate: "today" }, last(30), { startDate: "59daysAgo", endDate: "30daysAgo" }], metrics: [users, views] },
          // 1: unique visitors per calendar month (feeds the month picker)
          { dateRanges: [{ startDate: monthsFrom, endDate: "today" }], dimensions: [{ name: "yearMonth" }], metrics: [users], orderBys: [{ dimension: { dimensionName: "yearMonth" } }], limit: 24 },
          // 2: month so far, and the same days last month
          { dateRanges: [month.cur, month.prev], metrics: [users] },
          // 3: one row per day for the last 12 months
          { dateRanges: [last(365)], dimensions: [{ name: "date" }], metrics: [users, views], orderBys: [{ dimension: { dimensionName: "date" } }], limit: 400 },
          // 4: visits by traffic channel for 7 / 30 / 90 / 365 days
          { dateRanges: SPANS.map((n) => last(n)), dimensions: [{ name: "sessionDefaultChannelGroup" }], metrics: [{ name: "sessions" }] },
        ],
      }),
    }
  );

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const google = data.error || {};
    const code = google.status || google.code || res.status;
    const message = google.message || "GA4 request failed.";
    const error = new Error(message);
    error.googleStatus = code;
    error.httpStatus = res.status;
    throw error;
  }

  const reports = data.reports || [];
  const pair = (report, count) => {
    const out = Array.from({ length: count }, () => [0, 0]);
    for (const r of rows(report)) if (r.range < count) out[r.range] = [r.metrics[0] || 0, r.metrics[1] || 0];
    return out;
  };
  const p0 = pair(reports[0], 3);
  const all = p0[0];
  const t30 = [p0[1], p0[2]];
  const t2 = pair(reports[2], 2);

  const sources = {};
  SPANS.forEach((n) => (sources[n] = { direct: 0, search: 0, social: 0, referral: 0, other: 0 }));
  for (const r of rows(reports[4])) {
    const n = SPANS[r.range];
    if (n) sources[n][channelBucket(r.dims[0])] += r.metrics[0];
  }

  const ymd = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const series = rows(reports[3]).map((r) => ({ d: ymd(r.dims[0]), u: r.metrics[0], v: r.metrics[1] }));
  // "Today" and "same day last week" come from the same daily rows the graphs draw, so a card and its graph can't disagree.
  const dayU = (back) => series.find((r) => r.d === new Date(Date.parse(`${today}T00:00:00Z`) - back * 864e5).toISOString().slice(0, 10))?.u || 0;

  return {
    totalVisitors: all[0],
    pageViews: all[1],
    visitorsToday: dayU(0),
    visitorsThisMonth: t2[0][0],
    trends: {
      visitors30: [t30[0][0], t30[1][0]],
      views30: [t30[0][1], t30[1][1]],
      today: [dayU(0), dayU(7)],
      month: [t2[0][0], t2[1][0]],
    },
    series,
    months: rows(reports[1]).map((r) => ({ m: `${r.dims[0].slice(0, 4)}-${r.dims[0].slice(4, 6)}`, u: r.metrics[0] })),
    asOf: today,
    sources,
    generatedAt: new Date().toISOString(),
  };
}

async function handle(req) {
  const method = req.method || "GET";
  if (method !== "GET") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  const serviceAccount = parseServiceAccount(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  );
  const propertyId = normalizePropertyId(process.env.GA4_PROPERTY_ID);

  if (!serviceAccount) {
    return jsonResponse(501, {
      error: "not_configured",
      message:
        "FIREBASE_SERVICE_ACCOUNT_JSON is missing or invalid. Paste the full service-account JSON into that Vercel env var.",
    });
  }

  if (!propertyId) {
    return jsonResponse(501, {
      error: "not_configured",
      message: "GA4_PROPERTY_ID is missing.",
    });
  }

  if (!/^\d+$/.test(propertyId)) {
    return jsonResponse(500, {
      error:
        "GA4_PROPERTY_ID must be the numeric Property ID (Admin → Property settings), not the G-XXXXXXXXXX Measurement ID.",
    });
  }

  const authResult = await verifyAdmin(req, serviceAccount);
  if (!authResult.ok) {
    return jsonResponse(authResult.status, { error: authResult.error });
  }

  try {
    const analyticsData = await fetchGa4Summary(propertyId, serviceAccount);
    return jsonResponse(200, analyticsData);
  } catch (error) {
    console.error("GA4 request failed:", error);

    const googleStatus = String(
      error.googleStatus || error.httpStatus || error.code || ""
    );

    if (
      googleStatus === "403" ||
      googleStatus === "7" ||
      googleStatus === "PERMISSION_DENIED"
    ) {
      return jsonResponse(500, {
        error:
          "GA4 permission denied. Add the service account email as a Viewer on the GA4 property, and enable the Google Analytics Data API in Google Cloud.",
      });
    }

    if (
      googleStatus === "400" ||
      googleStatus === "3" ||
      googleStatus === "INVALID_ARGUMENT"
    ) {
      return jsonResponse(500, {
        error: error.message
          ? `GA4 request failed: ${error.message}`
          : "GA4 bad request. Confirm GA4_PROPERTY_ID is the numeric Property ID, not the G-XXXXXXXXXX Measurement ID.",
      });
    }

    if (
      googleStatus === "404" ||
      googleStatus === "5" ||
      googleStatus === "NOT_FOUND"
    ) {
      return jsonResponse(500, {
        error: "GA4 property not found. Confirm GA4_PROPERTY_ID is correct.",
      });
    }

    return jsonResponse(500, {
      error: "GA4 request failed.",
      message: error.message || undefined,
    });
  }
}

async function handler(req, res) {
  try {
    const result = await handle(req);
    if (res && typeof res.setHeader === "function") {
      sendNode(res, result);
      return;
    }
    return toWebResponse(result);
  } catch (error) {
    console.error("Unexpected analytics endpoint error:", error);
    const result = jsonResponse(500, {
      error: "Internal analytics server error.",
      message: String(error && error.message ? error.message : error),
    });
    if (res && typeof res.setHeader === "function") {
      sendNode(res, result);
      return;
    }
    return toWebResponse(result);
  }
}

module.exports = handler;
