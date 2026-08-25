// api/analytics.js
// Vercel serverless function — returns aggregate GA4 numbers for the admin dashboard.
//
// Security model matches firestore.rules / storage.rules exactly: a request is only
// answered if it carries a valid Firebase ID token AND that user's UID exists in the
// `admins` Firestore collection. No custom claims, no separate auth system to keep in sync.
//
// Required Vercel environment variables (see FIREBASE_SETUP.md, Part 2):
//   FIREBASE_SERVICE_ACCOUNT_JSON  — full JSON key from Firebase Console > Project settings
//                                    > Service accounts > Generate new private key (as one line)
//   GA4_PROPERTY_ID                — numeric GA4 property ID (Admin > Property details), NOT
//                                    the "G-XXXXXXXXXX" Measurement ID used in index.html
//
// Until both are set, this returns 501 so the dashboard can show a calm
// "not connected yet" message instead of a scary error.

const admin = require("firebase-admin");
const { google } = require("googleapis");

function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON:", err);
    return null;
  }
}

function getFirebaseApp(serviceAccount) {
  if (admin.apps.length) return admin.app();
  if (!serviceAccount?.client_email || !serviceAccount?.private_key) return null;
  return admin.initializeApp({
    credential: admin.credential.cert({
      projectId: serviceAccount.project_id,
      clientEmail: serviceAccount.client_email,
      privateKey: serviceAccount.private_key.replace(/\\n/g, "\n"),
    }),
  });
}

/** Verifies the caller is logged in AND listed in the `admins` collection. */
async function verifyAdmin(req, app) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return { ok: false, status: 401, error: "Missing Authorization header" };

  let decoded;
  try {
    decoded = await admin.auth(app).verifyIdToken(token);
  } catch (err) {
    return { ok: false, status: 401, error: "Invalid or expired session" };
  }

  const adminDoc = await admin.firestore(app).collection("admins").doc(decoded.uid).get();
  if (!adminDoc.exists) return { ok: false, status: 403, error: "Admin access required" };

  return { ok: true, uid: decoded.uid };
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * Pulls Total Visitors, Page Views, Visitors Today, and Visitors This Month from GA4
 * in a single batched call. Every date range below is computed from the current date
 * at request time — nothing is hardcoded to a specific year, so this keeps working
 * correctly every January without anyone needing to edit this file.
 */
async function fetchGa4Summary(propertyId, serviceAccount) {
  const authClient = new google.auth.GoogleAuth({
    credentials: {
      client_email: serviceAccount.client_email,
      private_key: serviceAccount.private_key.replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
  });

  const analyticsData = google.analyticsdata({ version: "v1beta", auth: authClient });

  const now = new Date();
  const startOfMonth = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-01`;

  const { data } = await analyticsData.properties.batchRunReports({
    property: `properties/${propertyId}`,
    requestBody: {
      requests: [
        // All-time totals. GA4 simply returns whatever real data exists within this
        // window (it won't error just because the property didn't exist in 2015).
        {
          dateRanges: [{ startDate: "2015-01-01", endDate: "today" }],
          metrics: [{ name: "totalUsers" }, { name: "screenPageViews" }],
        },
        { dateRanges: [{ startDate: "today", endDate: "today" }], metrics: [{ name: "totalUsers" }] },
        { dateRanges: [{ startDate: startOfMonth, endDate: "today" }], metrics: [{ name: "totalUsers" }] },
      ],
    },
  });

  const readMetric = (reportIndex, metricIndex) => {
    const row = data.reports?.[reportIndex]?.rows?.[0];
    return Number(row?.metricValues?.[metricIndex]?.value ?? 0);
  };

  return {
    totalVisitors: readMetric(0, 0),
    pageViews: readMetric(0, 1),
    visitorsToday: readMetric(1, 0),
    visitorsThisMonth: readMetric(2, 0),
    generatedAt: new Date().toISOString(),
  };
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const serviceAccount = getServiceAccount();
  const propertyId = process.env.GA4_PROPERTY_ID;
  const app = getFirebaseApp(serviceAccount);

  if (!app || !serviceAccount || !propertyId) {
    res.status(501).json({ error: "not_configured" });
    return;
  }

  // verifyAdmin() and fetchGa4Summary() don't depend on each other's result --
  // running them one after another was pure wasted time against Vercel's
  // execution limit, on top of a chain that already involves several network
  // round-trips (verify token, check Firestore, get a Google OAuth token,
  // query the GA4 API). Running them together roughly halves the worst case.
  const [authOutcome, ga4Outcome] = await Promise.allSettled([
    verifyAdmin(req, app),
    fetchGa4Summary(propertyId, serviceAccount),
  ]);

  if (authOutcome.status === "rejected") {
    console.error("Admin verification crashed:", authOutcome.reason);
    res.status(500).json({ error: "Admin check failed" });
    return;
  }
  const authResult = authOutcome.value;
  if (!authResult.ok) {
    res.status(authResult.status).json({ error: authResult.error });
    return;
  }

  if (ga4Outcome.status === "rejected") {
    const err = ga4Outcome.reason;
    console.error("Analytics endpoint failed:", err);
    const googleStatus = err?.code || err?.response?.status;
    let reason = "GA4 request failed";
    if (googleStatus === 403) {
      reason = "GA4 permission denied — check the service account has Viewer access on the property, and the Data API is enabled";
    } else if (googleStatus === 400) {
      reason = "GA4 bad request — check GA4_PROPERTY_ID is the numeric Property ID, not the G-XXXX Measurement ID";
    } else if (googleStatus === 404) {
      reason = "GA4 property not found — check GA4_PROPERTY_ID is correct";
    }
    res.status(500).json({ error: reason });
    return;
  }

  res.status(200).json(ga4Outcome.value);
};
