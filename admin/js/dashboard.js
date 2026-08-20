// admin/js/dashboard.js
import { requireAuth, wireLogout, wireSidebar, wireAccountInfo, checkAdminStatus } from "./auth-guard.js";

wireSidebar();
wireLogout("logout-btn");
if (window.lucide) lucide.createIcons();

requireAuth((user) => {
  document.getElementById("admin-email").textContent = user.email;
  wireAccountInfo(user);
  loadStats(user);
  runAdminStatusCheck(user);
});

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------- Account & access self-check ----------
async function runAdminStatusCheck(user) {
  const statusEl = document.getElementById("admin-status");
  if (!statusEl) return;
  try {
    const isAdmin = await checkAdminStatus(user);
    statusEl.className = `admin-status-badge ${isAdmin ? "ok" : "bad"}`;
    statusEl.textContent = isAdmin
      ? "✓ Recognized as admin — gallery uploads and analytics should work"
      : "✗ Not recognized as admin yet — copy the UID above and add it as a document ID in Firestore's admins collection";
  } catch (error) {
    console.error("Admin status check failed:", error);
    statusEl.className = "admin-status-badge bad";
    statusEl.textContent = "Couldn't check admin status — check your connection and reload";
  }
}

// ---------- Visitor stats ----------
const STATS = [
  { key: "totalVisitors", label: "Total Visitors" },
  { key: "visitorsToday", label: "Visitors Today" },
  { key: "visitorsThisMonth", label: "Visitors This Month" },
  { key: "pageViews", label: "Page Views" },
];

// state: "loading" | "data" | "notConfigured" | "error"
function renderStats(state, data, reason) {
  const grid = document.getElementById("stats-grid");
  grid.innerHTML = STATS.map((s) => {
    if (state === "data") {
      const value = Number(data?.[s.key] ?? 0).toLocaleString();
      return `
        <div class="stat-card">
          <div class="stat-label">${s.label}</div>
          <div class="stat-value">${value}</div>
        </div>`;
    }
    const messages = {
      loading: "Loading…",
      notConfigured: "Not connected yet — see FIREBASE_SETUP.md",
      error: `Couldn't load right now${reason ? ` (${escapeHtml(reason)})` : ""}`,
    };
    return `
      <div class="stat-card stat-empty">
        <div class="stat-label">${s.label}</div>
        <div class="stat-empty-msg">${messages[state] || messages.error}</div>
      </div>`;
  }).join("");
}

async function loadStats(user) {
  renderStats("loading");
  try {
    const token = await user.getIdToken();
    const res = await fetch("/api/analytics", {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 501) {
      renderStats("notConfigured");
      return;
    }

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      const reason = data?.error || `HTTP ${res.status}`;
      console.error("Analytics load failed:", reason);
      renderStats("error", null, reason);
      return;
    }

    renderStats("data", data);
  } catch (error) {
    console.error("Analytics load failed:", error);
    renderStats("error", null, "network error");
  }
}
