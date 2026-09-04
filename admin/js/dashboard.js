// admin/js/dashboard.js
import { requireAuth, wireLogout, wireSidebar } from "./auth-guard.js";

wireSidebar();
wireLogout("logout-btn");
if (window.lucide) lucide.createIcons();

requireAuth((user) => {
  const emailEl = document.getElementById("admin-email");
  if (emailEl) emailEl.textContent = user.email || "";
  loadStats(user);
});

const STATS = [
  { key: "totalVisitors", label: "Total Visitors" },
  { key: "visitorsToday", label: "Visitors Today" },
  { key: "visitorsThisMonth", label: "Visitors This Month" },
  { key: "pageViews", label: "Page Views" },
];

function setStatus(text, kind) {
  const el = document.getElementById("stats-status");
  if (!el) return;
  if (!text) {
    el.hidden = true;
    el.textContent = "";
    el.className = "stats-status";
    return;
  }
  el.hidden = false;
  el.className = "stats-status " + (kind || "");
  el.textContent = text;
}

function renderStats(state, data, reason) {
  const grid = document.getElementById("stats-grid");
  if (!grid) return;
  grid.innerHTML = STATS.map((s) => {
    if (state === "data") {
      const value = Number(data?.[s.key] ?? 0).toLocaleString();
      return (
        '<div class="stat-card">' +
          '<div class="stat-label">' + s.label + "</div>" +
          '<div class="stat-value">' + value + "</div>" +
        "</div>"
      );
    }
    const messages = {
      loading: "Loading...",
      notConfigured: "Not connected yet",
      error: "Unavailable",
    };
    return (
      '<div class="stat-card stat-empty">' +
        '<div class="stat-label">' + s.label + "</div>" +
        '<div class="stat-empty-msg">' + (messages[state] || messages.error) + "</div>" +
      "</div>"
    );
  }).join("");

  if (state === "data") {
    const generated = data?.generatedAt
      ? "Updated " + new Date(data.generatedAt).toLocaleString("en-NG")
      : "";
    setStatus(generated, "ok");
    return;
  }
  if (state === "loading") {
    setStatus("Loading visitor stats...", "");
    return;
  }
  if (state === "notConfigured") {
    setStatus(
      "Analytics is not connected yet. Add FIREBASE_SERVICE_ACCOUNT_JSON and GA4_PROPERTY_ID in Vercel, then redeploy.",
      "warn"
    );
    return;
  }
  setStatus(
    reason ? ("Could not load analytics: " + reason) : "Could not load analytics right now.",
    "error"
  );
}

function friendlyHttpError(status, data, rawText) {
  const payloadError = data?.error || data?.message;
  if (payloadError && payloadError !== "GA4 request failed.") return payloadError;

  const blob = (payloadError || "") + " " + (rawText || "");
  if (/FUNCTION_INVOCATION_FAILED/i.test(blob) || (status === 500 && /server error has occurred/i.test(rawText || ""))) {
    return "the analytics server crashed — redeploy the latest api/analytics.js";
  }
  if (status === 401) return "session expired — refresh and sign in again";
  if (status === 403) return "this account is not in the Firestore admins collection yet";
  if (status === 404) return "analytics endpoint not found — confirm /api/analytics.js is deployed";
  if (payloadError) return payloadError;
  return "HTTP " + status;
}

async function readResponse(res) {
  const contentType = res.headers.get("content-type") || "";
  const rawText = await res.text().catch(() => "");
  let data = null;
  if (contentType.includes("application/json") || rawText.trim().startsWith("{")) {
    try {
      data = JSON.parse(rawText);
    } catch {
      data = null;
    }
  }
  return { data, rawText };
}

async function loadStats(user, { forceRefresh = false } = {}) {
  renderStats("loading");
  try {
    const token = await user.getIdToken(forceRefresh);
    const res = await fetch("/api/analytics", {
      headers: { Authorization: "Bearer " + token },
      cache: "no-store",
    });

    const { data, rawText } = await readResponse(res);

    if (res.status === 501 || data?.error === "not_configured") {
      renderStats("notConfigured");
      return;
    }

    if (res.status === 401 && !forceRefresh) {
      return loadStats(user, { forceRefresh: true });
    }

    if (!res.ok) {
      const reason = friendlyHttpError(res.status, data, rawText);
      console.error("Analytics load failed:", reason, data || rawText);
      renderStats("error", null, reason);
      return;
    }

    renderStats("data", data || {});
  } catch (error) {
    console.error("Analytics load failed:", error);
    renderStats("error", null, "network error");
  }
}
