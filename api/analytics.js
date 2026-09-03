// api/analytics.js
// Vercel serverless function for the admin GA4 analytics dashboard.

const {
  cert,
  getApp,
  getApps,
  initializeApp,
} = require("firebase-admin/app");

const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!raw) return null;

  try {
    const serviceAccount = JSON.parse(raw);

    if (
      !serviceAccount ||
      typeof serviceAccount !== "object" ||
      !serviceAccount.project_id ||
      !serviceAccount.client_email ||
      !serviceAccount.private_key
    ) {
      console.error(
        "FIREBASE_SERVICE_ACCOUNT_JSON is missing required fields."
      );
      return null;
    }

    return serviceAccount;
  } catch (error) {
    console.error(
      "FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON:",
      error
    );
    return null;
  }
}

function normalizePrivateKey(privateKey) {
  return String(privateKey).replace(/\\n/g, "\n");
}

function getFirebaseApp(serviceAccount) {
  try {
    if (getApps().length > 0) {
      return getApp();
    }

    if (!serviceAccount) {
      return null;
    }

    return initializeApp({
      credential: cert({
        projectId: serviceAccount.project_id,
        clientEmail: serviceAccount.client_email,
        privateKey: normalizePrivateKey(serviceAccount.private_key),
      }),
    });
  } catch (error) {
    console.error("Firebase Admin initialization failed:", error);
    return null;
  }
}

async function verifyAdmin(req, app) {
  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    return {
      ok: false,
      status: 401,
      error: "Missing Authorization header",
    };
  }

  const token = authHeader.slice(7).trim();

  if (!token) {
    return {
      ok: false,
      status: 401,
      error: "Missing Firebase ID token",
    };
  }

  try {
    const auth = getAuth(app);
    const decodedToken = await auth.verifyIdToken(token);

    const db = getFirestore(app);

    const adminDoc = await db
      .collection("admins")
      .doc(decodedToken.uid)
      .get();

    if (!adminDoc.exists) {
      return {
        ok: false,
        status: 403,
        error: "Admin access required",
      };
    }

    return {
      ok: true,
      uid: decodedToken.uid,
    };
  } catch (error) {
    console.error("Admin verification failed:", error);

    return {
      ok: false,
      status: 401,
      error: "Invalid or expired session",
    };
  }
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

async function fetchGa4Summary(propertyId, serviceAccount) {
  // Load the ESM Google Analytics package dynamically.
  // This avoids the ERR_REQUIRE_ESM crash seen in Vercel.
  const { BetaAnalyticsDataClient } = await import(
    "@google-analytics/data"
  );

  const client = new BetaAnalyticsDataClient({
    credentials: {
      client_email: serviceAccount.client_email,
      private_key: normalizePrivateKey(
        serviceAccount.private_key
      ),
    },
  });

  const now = new Date();

  const startOfMonth = `${now.getFullYear()}-${pad2(
    now.getMonth() + 1
  )}-01`;

  const [response] = await client.batchRunReports({
    property: `properties/${propertyId}`,

    requests: [
      {
        dateRanges: [
          {
            startDate: "2015-01-01",
            endDate: "today",
          },
        ],

        metrics: [
          {
            name: "totalUsers",
          },
          {
            name: "screenPageViews",
          },
        ],
      },

      {
        dateRanges: [
          {
            startDate: "today",
            endDate: "today",
          },
        ],

        metrics: [
          {
            name: "totalUsers",
          },
        ],
      },

      {
        dateRanges: [
          {
            startDate: startOfMonth,
            endDate: "today",
          },
        ],

        metrics: [
          {
            name: "totalUsers",
          },
        ],
      },
    ],
  });

  function readMetric(reportIndex, metricIndex) {
    const report = response?.reports?.[reportIndex];

    const row = report?.rows?.[0];

    const value =
      row?.metricValues?.[metricIndex]?.value;

    const number = Number(value ?? 0);

    return Number.isFinite(number) ? number : 0;
  }

  return {
    totalVisitors: readMetric(0, 0),

    pageViews: readMetric(0, 1),

    visitorsToday: readMetric(1, 0),

    visitorsThisMonth: readMetric(2, 0),

    generatedAt: new Date().toISOString(),
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({
      error: "Method not allowed",
    });

    return;
  }

  try {
    const serviceAccount = getServiceAccount();

    const propertyId = String(
      process.env.GA4_PROPERTY_ID || ""
    ).trim();

    if (!serviceAccount) {
      res.status(501).json({
        error: "not_configured",
        message:
          "FIREBASE_SERVICE_ACCOUNT_JSON is missing or invalid.",
      });

      return;
    }

    if (!propertyId) {
      res.status(501).json({
        error: "not_configured",
        message:
          "GA4_PROPERTY_ID is missing.",
      });

      return;
    }

    if (!/^\d+$/.test(propertyId)) {
      res.status(500).json({
        error:
          "GA4_PROPERTY_ID must be the numeric GA4 Property ID, not the G-XXXXXXXXXX Measurement ID.",
      });

      return;
    }

    const app = getFirebaseApp(serviceAccount);

    if (!app) {
      res.status(501).json({
        error: "not_configured",
        message:
          "Firebase Admin could not be initialized.",
      });

      return;
    }

    // Verify the Firebase user is an administrator.
    const authResult = await verifyAdmin(req, app);

    if (!authResult.ok) {
      res.status(authResult.status).json({
        error: authResult.error,
      });

      return;
    }

    try {
      const analyticsData =
        await fetchGa4Summary(
          propertyId,
          serviceAccount
        );

      res.status(200).json(analyticsData);
    } catch (error) {
      console.error(
        "GA4 request failed:",
        error
      );

      const googleStatus =
        error?.code ??
        error?.response?.status;

      if (googleStatus === 403) {
        res.status(500).json({
          error:
            "GA4 permission denied. Confirm the service account has Viewer access to the GA4 property and that the Google Analytics Data API is enabled.",
        });

        return;
      }

      if (googleStatus === 400) {
        res.status(500).json({
          error:
            "GA4 bad request. Confirm GA4_PROPERTY_ID is the numeric Property ID, not the G-XXXXXXXXXX Measurement ID.",
        });

        return;
      }

      if (googleStatus === 404) {
        res.status(500).json({
          error:
            "GA4 property not found. Confirm GA4_PROPERTY_ID is correct.",
        });

        return;
      }

      res.status(500).json({
        error:
          "GA4 request failed.",
      });
    }
  } catch (error) {
    console.error(
      "Unexpected analytics endpoint error:",
      error
    );

    res.status(500).json({
      error:
        "Internal analytics server error.",
    });
  }
};