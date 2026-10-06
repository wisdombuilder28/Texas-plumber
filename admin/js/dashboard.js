// admin/js/dashboard.js
// Analytics dashboard. Every number comes from /api/analytics (GA4); nothing is made up.
import { requireAuth, wireLogout, wireSidebar } from "./auth-guard.js";

wireSidebar();
wireLogout("logout-btn");

const $ = (id) => document.getElementById(id);
const icons = () => window.lucide && lucide.createIcons();
const nf = new Intl.NumberFormat("en");
const state = { data: null, series: null, range: 7, w: 0, loaded: false, month: null, menu: false };
const LABEL = { 7: "last 7 days", 30: "last 30 days", 90: "last 90 days" };
const SOURCES = [
  ["direct", "Direct", "--c-gold"],
  ["search", "Search engines", "--c-green"],
  ["social", "Social media", "--c-copper"],
  ["referral", "Referrals", "--c-violet"],
  ["other", "Other", "--c-slate"],
];
const fmt = (dt, o) => dt.toLocaleDateString("en-GB", { ...o, timeZone: "UTC" });
const plural = (n, w) => (n === 1 ? w : w + "s");
const empty = () => '<p class="empty">' + (state.loaded ? "Nothing to show yet." : "Loading…") + "</p>";

// ---------- page wiring ----------
icons();
$("theme-btn").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("nd-admin-theme", next); } catch {}
});
document.querySelectorAll("button[data-range]").forEach((b) =>
  b.addEventListener("click", () => { state.range = +b.dataset.range; paintTraffic(); paintSources(); })
);
// Month picker (lives on the "Visitors this month" card)
$("kpis").addEventListener("click", (e) => {
  const pick = e.target.closest(".mpick"), item = e.target.closest(".mmenu button");
  if (!pick && !item) return;
  if (item) state.month = item.dataset.m;
  state.menu = pick ? !state.menu : false;
  paintKpis();
  $("kpis").querySelector(".mpick")?.focus();
});
document.addEventListener("click", (e) => { // tap anywhere else closes it
  if (state.menu && e.target.isConnected && !e.target.closest(".mpick, .mmenu")) { state.menu = false; paintKpis(); }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.menu) { state.menu = false; paintKpis(); $("kpis").querySelector(".mpick")?.focus(); }
});
new ResizeObserver(() => { if ($("chart").clientWidth !== state.w) paintTraffic(); }).observe($("chart"));

requireAuth((user) => {
  $("admin-email").textContent = user.email || "";
  $("refresh-btn").addEventListener("click", () => load(user));
  paintAll();
  load(user);
});

// ---------- loading ----------
function live(kind, text) {
  const p = $("live-pill");
  p.dataset.state = kind;
  p.querySelector("b").textContent = text;
}

function note(text, kind) {
  const n = $("dash-note");
  n.hidden = !text;
  n.className = "dash-note " + (kind || "");
  n.textContent = text || "";
}

function why(status, data, raw) {
  const m = data?.error || data?.message;
  if (m && m !== "GA4 request failed.") return m;
  if (/FUNCTION_INVOCATION_FAILED/i.test(raw || "")) return "The analytics server crashed. Redeploy the latest api/analytics.js.";
  if (status === 401) return "Session expired. Refresh the page and sign in again.";
  if (status === 403) return "This account isn't in the Firestore admins collection yet.";
  if (status === 404) return "Analytics endpoint not found. Confirm /api/analytics.js is deployed.";
  return "Couldn't load analytics (HTTP " + status + ").";
}

// Fills every one of the last 365 days, including days GA4 had no rows for. `on` = counted (on or after the start date).
function expand(d) {
  const map = new Map(d.series.map((r) => [r.d, r.u]));
  const end = Date.parse(d.asOf + "T00:00:00Z"), since = Date.parse(d.since + "T00:00:00Z");
  return Array.from({ length: 365 }, (_, i) => {
    const dt = new Date(end - (364 - i) * 864e5);
    return { dt, u: map.get(iso(dt)) || 0, on: dt.getTime() >= since };
  });
}

async function load(user, retry = true) {
  $("refresh-btn").classList.add("busy");
  live("loading", "Loading");
  try {
    const token = await user.getIdToken(!retry);
    const res = await fetch("/api/analytics", { headers: { Authorization: "Bearer " + token }, cache: "no-store" });
    const raw = await res.text().catch(() => "");
    let data = null;
    try { data = JSON.parse(raw); } catch {}

    if (res.status === 401 && retry) return load(user, false);

    if (res.status === 501 || data?.error === "not_configured") {
      live("setup", "Not connected");
      note("Analytics isn't connected yet. Add FIREBASE_SERVICE_ACCOUNT_JSON and GA4_PROPERTY_ID in Vercel, then redeploy.", "warn");
    } else if (!res.ok || !data) {
      console.error("Analytics load failed:", res.status, data || raw);
      live("error", "Error");
      note(why(res.status, data, raw), "error");
    } else {
      state.data = data;
      state.series = Array.isArray(data.series) ? expand(data) : null;
      live("live", "Connected");
      note(state.series ? "" : "Charts need the updated api/analytics.js. Deploy it, then refresh.", "warn");
      $("updated").textContent = "Updated " + new Date(data.generatedAt).toLocaleString("en-NG", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
    }
  } catch (e) {
    console.error("Analytics load failed:", e);
    live("error", "Offline");
    note("Network problem. Check your connection, then tap refresh.", "error");
  }
  state.loaded = true;
  $("refresh-btn").classList.remove("busy");
  paintAll();
}

function paintAll() { paintGrow(); paintKpis(); paintTraffic(); paintDays(); paintSources(); }

// ---------- drawing helpers ----------
// Smooth line through points (Catmull-Rom turned into beziers), kept inside [lo, hi] vertically.
function smooth(pts, lo, hi) {
  const f = (n) => n.toFixed(1);
  let d = "M" + f(pts[0][0]) + "," + f(pts[0][1]);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const y1 = Math.min(hi, Math.max(lo, p1[1] + (p2[1] - p0[1]) / 6));
    const y2 = Math.min(hi, Math.max(lo, p2[1] - (p3[1] - p1[1]) / 6));
    d += "C" + f(p1[0] + (p2[0] - p0[0]) / 6) + "," + f(y1) + " " + f(p2[0] - (p3[0] - p1[0]) / 6) + "," + f(y2) + " " + f(p2[0]) + "," + f(p2[1]);
  }
  return d;
}

// Axis top that splits into 4 whole-number steps: 4, 8, 12, 16, 20, 24, 32, 40, 80 ...
function niceMax(v) {
  const p = Math.max(1, 10 ** Math.floor(Math.log10(v / 4)));
  for (const s of [1, 2, 3, 4, 5, 6, 8, 10]) if (s * p * 4 >= v) return s * p * 4;
  return 40 * p;
}

function spark(vals, id) {
  if (vals.length < 2) vals = [vals[0] || 0, vals[0] || 0];
  const W = 100, H = 32, max = Math.max(...vals, 1);
  const pts = vals.map((v, i) => [(i * W) / (vals.length - 1 || 1), H - 3 - (v / max) * (H - 6)]);
  const d = smooth(pts, 3, H - 3);
  return '<svg class="spark" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" aria-hidden="true">' +
    '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--k);stop-opacity:.35"/><stop offset="1" style="stop-color:var(--k);stop-opacity:0"/></linearGradient></defs>' +
    '<path d="' + d + "L" + W + "," + H + "L0," + H + 'Z" fill="url(#' + id + ')"/><path class="l" d="' + d + '"/></svg>';
}

// ---------- cards ----------
const MON = (k, o) => new Date(k + "-01T00:00:00Z").toLocaleDateString("en-GB", { ...o, timeZone: "UTC" });
const prevMonth = (k) => { const [y, m] = k.split("-").map(Number); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); };
const iso = (dt) => dt.toISOString().slice(0, 10);

// Counting starts on `since`, so the first month is usually partial and anything before it was never counted.
const sinceText = (d) => fmt(new Date(d.since + "T00:00:00Z"), { day: "numeric", month: "short" });
const partialFirst = (d) => d.since.slice(8) !== "01";

// How to say "the month before": its number, its number plus the day counting began (first month), or "not counted".
function lastText(d, before, value) {
  const first = d.since.slice(0, 7);
  if (before < first) return "not counted";
  return nf.format(value(before)) + (before === first && partialFirst(d) ? " (from " + sinceText(d) + ")" : "");
}

// "Visitors this month" for the chosen month (null = this month so far). Number, caption and graph describe that same month.
function monthView(d, s, pick) {
  const cur = d.asOf.slice(0, 7), first = d.since.slice(0, 7), by = new Map((d.months || []).map((r) => [r.m, r.u]));
  by.set(cur, d.visitorsThisMonth);
  const keys = [...by.keys()].filter((k) => k <= cur && k >= first).sort().reverse().slice(0, 12);
  const sel = keys.includes(pick) ? pick : cur, isCur = sel === cur, before = prevMonth(sel);
  return {
    sel, isCur, cur, first, keys, by,
    days: s.filter((p) => p.on && iso(p.dt).startsWith(sel)).map((p) => p.u),
    val: by.get(sel) || 0,
    cap: (isCur ? "Last month: " : MON(before, { month: "long" }) + ": ") + lastText(d, before, (k) => by.get(k) || 0),
  };
}

// Taps on Call / WhatsApp this month (event counts add up exactly, unlike unique visitors).
function contactView(d, s) {
  const cur = d.asOf.slice(0, 7), before = prevMonth(cur), by = new Map((d.contacts || []).map((r) => [r.d, r.c]));
  const sum = (k) => [...by].filter(([day]) => day.startsWith(k)).reduce((a, [, c]) => a + c, 0);
  return {
    val: sum(cur),
    days: s.filter((p) => p.on && iso(p.dt).startsWith(cur)).map((p) => by.get(iso(p.dt)) || 0),
    cap: "This month. Last month: " + lastText(d, before, sum),
  };
}

// One plain sentence that answers "is the website growing?": last 7 days against the 7 before, in words, no percentages.
function paintGrow() {
  const d = state.data, box = $("grow");
  box.hidden = !d || d.visitorsWeek == null;
  if (box.hidden) return;
  const cur = d.visitorsWeek, prev = d.visitorsPrevWeek, people = (n) => (n === 1 ? "1 person" : nf.format(n) + " people");
  let kind = "", icon = "minus", head, sub;
  if (prev == null) {
    head = cur ? people(cur) + " visited in the last 7 days" : "No visitors counted yet";
    sub = "Counting started on " + sinceText(d) + ". Once there are two full weeks, this box tells you whether the website is growing.";
    icon = "clock";
  } else if (!cur && !prev) {
    head = "No visitors in the last two weeks"; sub = "Share the website link to start getting visitors."; kind = "down";
  } else if (cur + prev < 6) { // a handful of people is noise, not a trend
    head = "Early days"; sub = people(cur) + " visited in the last 7 days, " + prev + " the week before. A trend shows once a few more people have visited."; icon = "clock";
  } else if (cur - prev >= 3 && cur >= prev * 1.1) {
    head = "Your website is growing"; sub = people(cur) + " visited in the last 7 days, up from " + prev + " the week before."; kind = "up"; icon = "trending-up";
  } else if (prev - cur >= 3 && cur <= prev * 0.9) {
    head = "A little quieter than last week"; sub = people(cur) + " visited in the last 7 days, " + prev + " the week before."; kind = "down"; icon = "trending-down";
  } else {
    head = "Holding steady"; sub = people(cur) + " visited in the last 7 days, " + prev + " the week before.";
  }
  box.className = "grow " + kind;
  box.innerHTML = '<span class="grow-i"><i data-lucide="' + icon + '" class="icon-sm"></i></span><div><b>' + head + "</b><p>" + sub + "</p></div>";
  icons();
}

function paintKpis() {
  const d = state.data, s = state.series;
  const mv = d && s ? monthView(d, s, state.month) : null, cv = d && s ? contactView(d, s) : null;
  const yday = s && s[s.length - 2].on ? nf.format(s[s.length - 2].u) : "not counted";
  const items = [ // label, icon, tone, value, caption, days the little graph plots (no graph = null)
    ["Visitors today", "clock", "amber", d?.visitorsToday, s && "Yesterday: " + yday, null],
    ["Visitors, last 7 days", "users", "", d?.visitorsWeek, d && "The 7 days before: " + (d.visitorsPrevWeek == null ? "not counted" : nf.format(d.visitorsPrevWeek)), s && s.slice(-7).filter((p) => p.on).map((p) => p.u)],
    [null, "calendar-days", "green", mv ? mv.val : d?.visitorsThisMonth, mv && mv.cap, mv && mv.days],
    ["Calls & WhatsApp taps", "phone-call", "violet", cv && cv.val, cv && cv.cap, cv && cv.days],
  ];
  $("kpis").innerHTML = items.map(([label, icon, tone, val, cap, pts], i) => {
    let head = label, menu = "";
    if (!label) { // month card: the title doubles as the month picker
      const name = !mv || mv.isCur ? "Visitors this month" : "Visitors in " + MON(mv.sel, { month: "long", year: mv.sel.slice(0, 4) === mv.cur.slice(0, 4) ? undefined : "numeric" });
      head = name;
      if (mv) { // always a dropdown, even while there is only one counted month
        head = '<button type="button" class="mpick" aria-haspopup="true" aria-expanded="' + state.menu + '">' + name + ' <i data-lucide="chevron-down" class="icon-sm"></i></button>';
        menu = '<div class="mmenu" role="menu"' + (state.menu ? "" : " hidden") + ">" + mv.keys.map((k) => {
          const notes = [k === mv.cur ? "so far" : "", k === mv.first && partialFirst(d) ? "counted from " + sinceText(d) : ""].filter(Boolean).join(" · ");
          return '<button type="button" role="menuitemradio" aria-checked="' + (k === mv.sel) + '" data-m="' + k + '"><span>' + MON(k, { month: "long", year: "numeric" }) +
            (notes ? "<em>" + notes + "</em>" : "") + "</span><small>" + nf.format(mv.by.get(k)) + "</small></button>";
        }).join("") + (mv.keys.length < 2 ? '<p class="mnote">Earlier months will show up here as the website collects data.</p>' : "") + "</div>";
      }
    }
    return '<article class="kpi ' + tone + '">' +
      '<div class="kpi-top"><span><i data-lucide="' + icon + '" class="icon-sm"></i></span>' + head + "</div>" + menu +
      '<div class="kpi-val">' + (val == null ? "—" : nf.format(val)) + "</div>" +
      (pts ? spark(pts, "sk" + i) : "") +
      '<div class="kpi-foot"><span>' + (cap || "") + "</span></div></article>";
  }).join("");
  icons();
}

function paintTraffic() {
  const host = $("chart"), W = host.clientWidth || 320, H = 230;
  state.w = host.clientWidth;
  document.querySelectorAll("button[data-range]").forEach((b) => b.setAttribute("aria-pressed", +b.dataset.range === state.range));
  $("traffic-sub").textContent = "Visitors over the " + LABEL[state.range];
  if (!state.series) { host.innerHTML = empty(); $("traffic-stats").innerHTML = ""; return; }

  const rows = state.series.filter((r) => r.on).slice(-state.range), n = rows.length, key = "u";
  if (n < 2) { host.innerHTML = '<p class="empty">Not enough days yet. The chart fills in as days go by.</p>'; $("traffic-stats").innerHTML = ""; return; }
  const vals = rows.map((r) => r[key]);
  const m = { l: 32, r: 12, t: 14, b: 26 }, base = H - m.b;
  const top = niceMax(Math.max(...vals, 1));
  const x = (i) => m.l + (i * (W - m.l - m.r)) / (n - 1);
  const y = (v) => base - (v / top) * (base - m.t);
  const pts = vals.map((v, i) => [x(i), y(v)]);
  const line = smooth(pts, m.t, base);

  const grid = [0, 1, 2, 3, 4].map((i) => {
    const v = (top * i) / 4;
    return '<line class="grid" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>' +
      '<text x="' + (m.l - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + v + "</text>";
  }).join("");
  // A date label is ~40px wide and the last one sits flush right, so neighbours need ~68px between them or they touch.
  const per = Math.max(1, Math.ceil(68 / ((W - m.l - m.r) / (n - 1))));
  const xl = rows.map((r, i) => (n - 1 - i) % per ? "" :
    '<text x="' + x(i) + '" y="' + (H - 6) + '" text-anchor="' + (i === n - 1 ? "end" : i === 0 ? "start" : "middle") + '">' + fmt(r.dt, { day: "numeric", month: "short" }) + "</text>").join("");
  const dots = n <= 14 ? pts.map((p) => '<circle class="pt" cx="' + p[0] + '" cy="' + p[1] + '" r="3.5"/>').join("") : "";

  host.innerHTML = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + $("traffic-sub").textContent + '">' +
    '<defs><linearGradient id="gt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--accent);stop-opacity:.32"/><stop offset="1" style="stop-color:var(--accent);stop-opacity:0"/></linearGradient></defs>' +
    grid + '<path d="' + line + "L" + x(n - 1) + "," + base + "L" + x(0) + "," + base + 'Z" fill="url(#gt)"/>' +
    '<path class="ln" d="' + line + '"/>' + dots + xl +
    '<line class="cross" y1="' + m.t + '" y2="' + base + '"/><circle class="pt on" r="5"/></svg><div class="tip"></div>';

  // Touch / hover: scrub along the chart; it rests on the latest day.
  const svg = host.querySelector("svg"), cross = svg.querySelector(".cross"), dot = svg.querySelector(".on"), tip = host.querySelector(".tip");
  const show = (i) => {
    const px = pts[i][0], py = pts[i][1];
    cross.setAttribute("x1", px); cross.setAttribute("x2", px);
    dot.setAttribute("cx", px); dot.setAttribute("cy", py);
    tip.innerHTML = "<b>" + nf.format(vals[i]) + "</b> " + plural(vals[i], key === "u" ? "visitor" : "page view") +
      "<small>" + fmt(rows[i].dt, { weekday: "short", day: "numeric", month: "short" }) + "</small>";
    tip.style.left = Math.min(Math.max(px, 56), W - 56) + "px";
    tip.style.top = py + "px";
    tip.classList.toggle("below", py < 64);
  };
  const aim = (e) => {
    const i = Math.round(((e.clientX - svg.getBoundingClientRect().left - m.l) / (W - m.l - m.r)) * (n - 1));
    show(Math.max(0, Math.min(n - 1, i)));
  };
  svg.addEventListener("pointermove", aim);
  svg.addEventListener("pointerdown", aim);
  svg.addEventListener("pointerleave", () => show(n - 1));
  show(n - 1);

  const sumU = rows.reduce((a, r) => a + r.u, 0), busy = rows.filter((r) => r.u).length;
  const best = rows.reduce((b, r) => (r.u >= b.u ? r : b), rows[0]);
  $("traffic-stats").innerHTML = [
    ["Days with visitors", busy + " of " + n],
    ["Avg visitors / day", (sumU / n).toFixed(1)],
    ["Busiest day", best.u ? fmt(best.dt, { day: "numeric", month: "short" }) + " · " + best.u : "—"],
  ].map((s) => "<div><b>" + s[1] + "</b><span>" + s[0] + "</span></div>").join("");
}

function paintDays() {
  const s = state.series;
  if (!s) { $("bars").innerHTML = empty(); return; }
  const rows = s.slice(-7), max = Math.max(...rows.map((r) => r.u), 1);
  $("bars").innerHTML = rows.map((r, i) =>
    '<div class="bar' + (i === 6 ? " today" : "") + '"><span>' + (i === 6 ? "Today" : fmt(r.dt, { weekday: "short" })) + "</span>" +
    '<i><b style="width:' + (r.u / max) * 100 + '%"></b></i><em>' + r.u + "</em></div>").join("");
}

function paintSources() {
  $("src-sub").textContent = "Visits in the " + LABEL[state.range];
  const box = $("sources"), s = state.data?.sources?.[state.range];
  if (!s) { box.innerHTML = empty(); return; }
  const items = SOURCES.map(([k, name, c]) => ({ name, c, n: s[k] || 0 })).filter((r, i) => r.n || i < 4);
  const live = items.filter((r) => r.n);
  const total = live.reduce((a, r) => a + r.n, 0), C = 2 * Math.PI * 40;
  let acc = 0;
  const segs = live.map((r) => {
    const len = (r.n / total) * C, gap = live.length > 1 ? 1.5 : 0;
    const el = '<circle class="sg" cx="50" cy="50" r="40" style="stroke:var(' + r.c + ')" stroke-dasharray="' + Math.max(len - gap, 0.5) + " " + C + '" stroke-dashoffset="' + -acc + '"/>';
    acc += len;
    return el;
  }).join("");
  box.innerHTML = '<div class="donut-wrap"><div class="donut"><svg viewBox="0 0 100 100"><circle class="tr" cx="50" cy="50" r="40"/>' + segs +
    '</svg><div class="donut-c"><b>' + nf.format(total) + "</b><span>visits</span></div></div>" +
    '<div class="legend">' + items.map((r) =>
      '<div><i style="background:var(' + r.c + ')"></i><span>' + r.name + "</span><em>" + (total ? Math.round((r.n / total) * 100) : 0) + "%</em><strong>" + r.n + "</strong></div>").join("") +
    "</div></div>";
}
