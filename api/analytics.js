// api/analytics.js
// Vercel Serverless Function
// Returns aggregate GA4 analytics for the authenticated admin dashboard.

const {
  cert,
  getApp,
  getApps,
  initializeApp,
} = require("firebase-admin/app");

const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

const { BetaAnalyticsDataClient } = require("@google-analytics/data");

/* =========================================================
   ENVIRONMENT VARIABLES
   =========================================================

   FIREBASE_SERVICE_ACCOUNT_JSON
   Full Firebase service-account JSON stored in Vercel.

   GA4_PROPERTY_ID
   Numeric GA4 Property ID.
   NOT the G-XXXXXXXXXX Measurement ID.
   ========================================================= */


/* =========================================================
   FIREBASE SERVICE ACCOUNT
   ========================================================= */

function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error(
      "FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON:",
      error
    );

    return null;
  }
}


/* =========================================================
   FIREBASE ADMIN APP
   ========================================================= */

function getFirebaseApp(serviceAccount) {
  try {
    // Reuse the existing Firebase Admin app if one already exists.
    if (getApps().length > 0) {
      return getApp();
    }

    if (
      !serviceAccount ||
      !serviceAccount.project_id ||
      !serviceAccount.client_email ||
      !serviceAccount.private_key
    ) {
      return null;
    }

    const privateKey = serviceAccount.private_key.replace(
      /\\n/g,
      "\n"
    );

    return initializeApp({
      credential: cert({
        projectId: serviceAccount.project_id,
        clientEmail: serviceAccount.client_email,
        privateKey,
      }),
    });
  } catch (error) {
    console.error(
      "Firebase Admin initialization failed:",
      error
    );

    return null;
  }
}


/* =========================================================
   VERIFY ADMIN
   =========================================================

   The request must:
   1. contain a Firebase ID token
   2. belong to a valid Firebase user
   3. have that user's UID inside:
      admins/{uid}
   ========================================================= */

async function verifyAdmin(req, app) {
  const authorization =
    req.headers.authorization || "";

  if (!authorization.startsWith("Bearer ")) {
    return {
      ok: false,
      status: 401,
      error: "Missing Authorization header",
    };
  }

  const token = authorization.slice(7).trim();

  if (!token) {
    return {
      ok: false,
      status: 401,
      error: "Missing Firebase ID token",
    };
  }

  try {
    const auth = getAuth(app);

    const decodedToken =
      await auth.verifyIdToken(token);

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
    console.error(
      "Admin verification failed:",
      error
    );

    return {
      ok: false,
      status: 401,
      error: "Invalid or expired session",
    };
  }
}


/* =========================================================
   DATE HELPERS
   ========================================================= */

function pad2(value) {
  return String(value).padStart(2, "0");
}


/* =========================================================
   GA4 ANALYTICS
   ========================================================= */

async function fetchGa4Summary(
  propertyId,
  serviceAccount
) {
  if (!propertyId) {
    throw new Error(
      "GA4_PROPERTY_ID is missing"
    );
  }

  if (
    !serviceAccount ||
    !serviceAccount.client_email ||
    !serviceAccount.private_key
  ) {
    throw new Error(
      "Firebase service-account credentials are missing"
    );
  }

  const privateKey =
    serviceAccount.private_key.replace(
      /\\n/g,
      "\n"
    );

  const analyticsClient =
    new BetaAnalyticsDataClient({
      credentials: {
        client_email:
          serviceAccount.client_email,

        private_key: privateKey,
      },
    });

  const now = new Date();

  const startOfMonth =
    `${now.getFullYear()}-${pad2(
      now.getMonth() + 1
    )}-01`;

  const [response] =
    await analyticsClient.batchRunReports({
      property:
        `properties/${propertyId}`,

      requests: [

        // -------------------------------------------------
        // ALL-TIME
        // -------------------------------------------------

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

        // -------------------------------------------------
        // TODAY
        // -------------------------------------------------

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

        // -------------------------------------------------
        // THIS MONTH
        // -------------------------------------------------

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

  function readMetric(
    reportIndex,
    metricIndex
  ) {
    const report =
      response &&
      response.reports &&
      response.reports[reportIndex];

    const row =
      report &&
      report.rows &&
      report.rows[0];

    const metricValue =
      row &&
      row.metricValues &&
      row.metricValues[metricIndex];

    return Number(
      metricValue && metricValue.value
        ? metricValue.value
        : 0
    );
  }

  return {
    totalVisitors: readMetric(0, 0),

    pageViews: readMetric(0, 1),

    visitorsToday: readMetric(1, 0),

    visitorsThisMonth: readMetric(2, 0),

    generatedAt:
      new Date().toISOString(),
  };
}


/* =========================================================
   MAIN VERCEL HANDLER
   ========================================================= */

module.exports = async function handler(
  req,
  res
) {
  // Only GET is supported.
  if (req.method !== "GET") {
    res.status(405).json({
      error: "Method not allowed",
    });

    return;
  }

  try {
    /* -----------------------------------------------------
       1. Load environment configuration
       ----------------------------------------------------- */

    const serviceAccount =
      getServiceAccount();

    const propertyId =
      process.env.GA4_PROPERTY_ID;

    if (!serviceAccount) {
      console.error(
        "Analytics configuration error: FIREBASE_SERVICE_ACCOUNT_JSON is missing or invalid."
      );

      res.status(501).json({
        error: "not_configured",
        message:
          "FIREBASE_SERVICE_ACCOUNT_JSON is missing or invalid.",
      });

      return;
    }

    if (!propertyId) {
      console.error(
        "Analytics configuration error: GA4_PROPERTY_ID is missing."
      );

      res.status(501).json({
        error: "not_configured",
        message:
          "GA4_PROPERTY_ID is missing.",
      });

      return;
    }


    /* -----------------------------------------------------
       2. Initialize Firebase Admin
       ----------------------------------------------------- */

    const app =
      getFirebaseApp(serviceAccount);

    if (!app) {
      console.error(
        "Analytics configuration error: Firebase Admin could not initialize."
      );

      res.status(501).json({
        error: "not_configured",
        message:
          "Firebase Admin could not be initialized.",
      });

      return;
    }


    /* -----------------------------------------------------
       3. Authenticate and authorize the admin
       -----------------------------------------------------

       IMPORTANT:
       We verify the admin BEFORE querying GA4.

       This prevents unauthorized requests from consuming
       Google Analytics API calls.
       ----------------------------------------------------- */

    const authResult =
      await verifyAdmin(req, app);

    if (!authResult.ok) {
      res.status(authResult.status).json({
        error: authResult.error,
      });

      return;
    }


    /* -----------------------------------------------------
       4. Query GA4
       ----------------------------------------------------- */

    let analyticsData;

    try {
      analyticsData =
        await fetchGa4Summary(
          propertyId,
          serviceAccount
        );
    } catch (error) {
      console.error(
        "GA4 request failed:",
        error
      );

      const googleStatus =
        error &&
        (
          error.code ||
          (
            error.response &&
            error.response.status
          )
        );

      if (googleStatus === 403) {
        res.status(500).json({
          error:
            "GA4 permission denied. Confirm that the service account has Viewer access to the GA4 property and that the Google Analytics Data API is enabled.",
        });

        return;
      }

      if (googleStatus === 400) {
        res.status(500).json({
          error:
            "GA4 bad request. Confirm that GA4_PROPERTY_ID is the numeric Property ID, not the G-XXXXXXXXXX Measurement ID.",
        });

        return;
      }

      if (googleStatus === 404) {
        res.status(500).json({
          error:
            "GA4 property not found. Confirm that GA4_PROPERTY_ID is correct.",
        });

        return;
      }

      res.status(500).json({
        error:
          "GA4 request failed.",
      });

      return;
    }


    /* -----------------------------------------------------
       5. Return analytics to dashboard
       ----------------------------------------------------- */

    res.status(200).json(
      analyticsData
    );

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