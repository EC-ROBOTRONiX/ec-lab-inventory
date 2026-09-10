/* ========================================================================
   EC Lab Inventory — component stock and location register.

   Front end only. All data lives in a Google Sheet and is reached through
   the Apps Script web app whose URL sits in config.js.

   Read requests are plain GETs. Writes are POSTs sent with a text/plain
   content type on purpose: that keeps them "simple" requests, so the
   browser does not send a CORS preflight, which Apps Script cannot answer.
   ==================================================================== */
"use strict";

var CFG = window.EC_CONFIG || {};
var API_URL = String(CFG.apiUrl || "").trim();
var CONFIGURED = API_URL !== "" && API_URL.indexOf("PASTE_") === -1;

var S = {
  comps: [],
  issues: [],
  log: [],
  cfg: { labName: CFG.labName || "EC Lab", thresholds: {}, defaultMin: 3 },
  role: "viewer",
  me: "",
  pin: "",
  view: "overview",
  q: "",
  filt: { type: "", place: "", status: "", smd: "" },
  sort: { k: "name", d: 1 },
  bin: null,
  loaded: false,
  syncing: false,
  lastSync: null
};

/* ---------------- API ---------------- */
function apiGet() {
  return fetch(API_URL + "?action=bootstrap&t=" + Date.now(), {
    method: "GET", redirect: "follow"
  }).then(function (r) { return r.json(); });
}

function apiPost(action, payload) {
  return fetch(API_URL, {
    method: "POST",
    redirect: "follow",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      action: action, pin: S.pin, who: S.me || "admin", payload: payload || {}
    })
  }).then(function (r) { return r.json(); });
}

function absorb(data) {
  if (!data) return;
  S.comps = data.components || [];
  S.issues = data.issues || [];
  S.log = data.activity || [];
  if (data.settings) S.cfg = data.settings;
  S.loaded = true;
  S.lastSync = new Date();
}

/** Re-read everything from the sheet. */
function refresh(quiet) {
  if (!CONFIGURED || S.syncing) return Promise.resolve();
  S.syncing = true;
  markSync();
  return apiGet().then(function (res) {
    S.syncing = false;
    if (!res || !res.ok) throw new Error((res && res.error) || "The server did not answer.");
    absorb(res.data);
    render();
  }).catch(function (err) {
    S.syncing = false;
    markSync();
    if (!quiet) toast("Could not reach the lab sheet: " + err.message, "bad");
  });
}

/** Run a write, then adopt the fresh copy the server sends back. */
function write(action, payload, okMsg) {
  if (!isAdmin()) {
    toast("Read-only mode. Sign in as admin to change stock.", "bad");
    return Promise.reject(new Error("not admin"));
  }
  S.syncing = true; markSync();
  return apiPost(action, payload).then(function (res) {
    S.syncing = false;
    if (!res || !res.ok) throw new Error((res && res.error) || "The write was refused.");
    absorb(res.data);
    render();
    if (okMsg) toast(okMsg, "good");
    return res.result;
  }).catch(function (err) {
    S.syncing = false; markSync();
    toast(err.message, "bad");
    throw err;
  });
}

function markSync() {
  var el = document.getElementById("syncTxt");
  if (!el) return;
  if (S.syncing) { el.textContent = "Syncing…"; return; }
  el.textContent = S.lastSync ? "Synced " + fmtWhen(S.lastSync.toISOString()) : "Not synced";
}

/* ---------------- helpers ---------------- */
function $(s, r) { return (r || document).querySelector(s); }
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function nowISO() { return new Date().toISOString(); }
function fmtWhen(iso) {
  if (!iso) return "—";
  var d = new Date(iso); if (isNaN(d)) return "—";
  var diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + " min ago";
  if (diff < 86400) return Math.floor(diff / 3600) + " hr ago";
  if (diff < 604800) return Math.floor(diff / 86400) + " d ago";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
function toast(msg, kind) {
  var t = document.createElement("div");
  t.className = "toast " + (kind || "");
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(function () { t.remove(); }, 4200);
}
function isAdmin() { return S.role === "admin"; }
function guard() {
  if (isAdmin()) return true;
  toast("Read-only mode. Sign in as admin to change stock.", "bad");
  return false;
}

/* ---------------- stock status ---------------- */
function minOf(c) {
  if (typeof c.min === "number") return c.min;
  var t = S.cfg.thresholds || {};
  return typeof t[c.type] === "number" ? t[c.type] : 3;
}
function statusOf(c) {
  if (c.unknown) return "unk";
  var q = c.qty || 0, m = minOf(c);
  if (q <= 0) return "out";
  if (q < m) return "low";
  return "ok";
}
var STATUS_LABEL = { ok: "In stock", low: "Low stock", out: "Out of stock", unk: "Not counted" };
function statusChip(c) {
  var s = statusOf(c);
  return '<span class="chip s-' + s + '">' + STATUS_LABEL[s] + "</span>";
}
function qtyText(c) {
  if (c.unknown) return "—";
  return (c.qty || 0) + (c.approx ? "+" : "");
}

/* ---------------- search ---------------- */
/* Normalises the lab's own notation so "1k resistor", "1K Ω Resistor"
   and "1000 ohm" all reach the same bin. */
function normText(s) {
  return String(s || "").toLowerCase()
    .replace(/Ω|ω/g, " ohm ")
    .replace(/µ|μ/g, "u")
    .replace(/[^a-z0-9.+/ ]+/g, " ")
    .replace(/\s+/g, " ").trim();
}
function haystack(c) {
  return normText([c.name, c.type, c.place, c.id, c.smd ? "smd" : ""].join(" "));
}
function scoreMatch(c, tokens) {
  var h = haystack(c), n = normText(c.name), sc = 0;
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i];
    if (h.indexOf(t) === -1) return -1;
    if (n.indexOf(t) === 0) sc += 6;
    else if (n.indexOf(" " + t) > -1) sc += 4;
    else if (n.indexOf(t) > -1) sc += 3;
    else sc += 1;
  }
  if (n === tokens.join(" ")) sc += 20;
  return sc;
}
function search(q, limit) {
  var tokens = normText(q).split(" ").filter(Boolean);
  if (!tokens.length) return [];
  var out = [];
  for (var i = 0; i < S.comps.length; i++) {
    var sc = scoreMatch(S.comps[i], tokens);
    if (sc >= 0) out.push({ c: S.comps[i], s: sc });
  }
  out.sort(function (a, b) { return b.s - a.s || a.c.name.localeCompare(b.c.name); });
  return out.slice(0, limit || 60).map(function (o) { return o.c; });
}

/* ---------------- derived stats ---------------- */
function stats() {
  var t = { total: S.comps.length, units: 0, low: 0, out: 0, unk: 0, ok: 0, bins: {}, types: {} };
  for (var i = 0; i < S.comps.length; i++) {
    var c = S.comps[i], s = statusOf(c);
    if (!c.unknown) t.units += (c.qty || 0);
    t[s]++;
    (t.bins[c.place] = t.bins[c.place] || { n: 0, low: 0 }).n++;
    if (s === "low" || s === "out") t.bins[c.place].low++;
    (t.types[c.type] = t.types[c.type] || { n: 0, low: 0 }).n++;
    if (s === "low" || s === "out") t.types[c.type].low++;
  }
  t.openIssues = S.issues.filter(function (x) { return x.status === "open"; });
  t.issuedUnits = t.openIssues.reduce(function (a, b) { return a + (b.qty || 0); }, 0);
  return t;
}

/* ========================================================================
   VIEWS
   ==================================================================== */
function render() {
  var el = $("#view"); if (!el) return;
  var fn = ({
    overview: vOverview, inventory: vInventory, alerts: vAlerts, racks: vRacks,
    issue: vIssue, log: vLog, manage: vManage, settings: vSettings
  })[S.view] || vOverview;
  el.innerHTML = fn();
  wire();
  var st = stats();
  $("#lowBadge").textContent = st.low + st.out;
  $("#lowBadge").style.display = (st.low + st.out) ? "" : "none";
  $("#brandSub").textContent = st.total + " components · " + Object.keys(st.bins).length + " locations";
}

/* ---------- overview ---------- */
function vOverview() {
  var st = stats();
  var results = S.q ? search(S.q, 40) : [];
  var h = "";

  if (S.q) {
    return '<div class="head"><div><h1>Search the register</h1>' +
      '<p class="sub">Every match across all ' + st.total + " components, with the bin to walk to.</p></div></div>" +
      searchPanel(results);
  }

  h += '<div class="head"><div><h1>Lab stock at a glance</h1>' +
    '<p class="sub">Live register of every component on the EC Lab racks, with its exact bin.</p></div></div>';

  h += '<div class="tiles">' +
    tile("Components", st.total, "distinct line items") +
    tile("Units on shelf", st.units.toLocaleString(), "counted pieces") +
    tile("Low stock", st.low, "below their minimum", "warn") +
    tile("Out of stock", st.out, "zero on shelf", "alert") +
    tile("Issued out", st.issuedUnits, st.openIssues.length + " open records") +
    tile("Never counted", st.unk, "quantity still unknown") +
    '</div>';

  h += '<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">';

  // needs attention
  var need = S.comps.filter(function (c) { var s = statusOf(c); return s === "out" || s === "low"; })
    .sort(function (a, b) {
      var sa = statusOf(a) === "out" ? 0 : 1, sb = statusOf(b) === "out" ? 0 : 1;
      return sa - sb || (a.qty || 0) - (b.qty || 0);
    }).slice(0, 12);
  h += '<section class="panel"><div class="ph"><h2>Needs restocking</h2>' +
    '<span class="spacer"></span><button class="btn sm" data-go="alerts">See all ' + (st.low + st.out) + '</button></div>';
  h += need.length ? '<div class="tablewrap"><table><tbody>' + need.map(function (c) {
    return "<tr>" +
      '<td class="nm">' + esc(c.name) + "<small>" + esc(c.type) + "</small></td>" +
      '<td style="width:1%"><span class="bin">' + esc(c.place) + "</span></td>" +
      '<td class="num" style="width:1%">' + qtyText(c) + '<span style="color:var(--muted);font-weight:400">/' + minOf(c) + "</span></td>" +
      '<td style="width:1%">' + statusChip(c) + "</td>" +
      "</tr>";
  }).join("") + "</tbody></table></div>"
    : '<div class="empty"><b>Everything is above its minimum</b>No component needs restocking right now.</div>';
  h += "</section>";

  // by category
  var types = Object.keys(st.types).sort(function (a, b) { return st.types[b].n - st.types[a].n; }).slice(0, 12);
  var maxN = types.length ? st.types[types[0]].n : 1;
  h += '<section class="panel"><div class="ph"><h2>Where the stock sits</h2>' +
    '<span class="sub" style="margin:0">top categories</span></div><div class="pb"><div class="blist">';
  h += types.map(function (t) {
    var d = st.types[t], w = Math.max(3, Math.round(d.n / maxN * 100)), lowPct = d.n ? d.low / d.n * 100 : 0;
    return '<div class="brow"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(t) + "</div>" +
      '<div class="track" style="width:' + w + '%">' +
      '<i style="width:' + (100 - lowPct) + '%;background:var(--accent)"></i>' +
      '<i style="width:' + lowPct + '%;background:var(--low)"></i></div>' +
      '<div class="n">' + d.n + "</div></div>";
  }).join("");
  h += '</div><div class="hint" style="margin-top:12px">Amber portion = items in that category below their minimum.</div></div></section>';

  h += "</div>";

  // recent activity
  var log = (S.log || []).slice(0, 8);
  h += '<section class="panel" style="margin-top:14px"><div class="ph"><h2>Recent activity</h2>' +
    '<span class="spacer"></span><button class="btn sm" data-go="log">Full log</button></div>';
  h += log.length ? '<div class="tablewrap"><table><tbody>' + log.map(function (e) {
    return "<tr><td>" + esc(e.text) + "</td>" +
      '<td style="width:1%;white-space:nowrap"><span class="tag">' + esc(e.who || "—") + "</span></td>" +
      '<td style="width:1%;white-space:nowrap;color:var(--muted)" class="mono">' + fmtWhen(e.at) + "</td></tr>";
  }).join("") + "</tbody></table></div>"
    : '<div class="empty"><b>No activity yet</b>Stock changes and issues will appear here.</div>';
  h += "</section>";
  return h;
}
function tile(k, v, n, cls) {
  return '<div class="tile ' + (cls || "") + '"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div><div class="n">' + esc(n) + "</div></div>";
}

function searchPanel(results) {
  var h = '<section class="panel"><div class="ph"><h2>' + results.length + ' match' + (results.length === 1 ? "" : "es") +
    ' for “' + esc(S.q) + '”</h2><span class="spacer"></span><button class="btn sm" id="clearQ">Clear</button></div>';
  if (!results.length) {
    return h + '<div class="empty"><b>Nothing found</b>Try a shorter term — “1k”, “LM35”, “relay”, or a bin code like “D5”.</div></section>';
  }
  h += '<div class="res">' + results.map(function (c) {
    return '<div class="r"><div class="who"><b>' + esc(c.name) + "</b>" +
      "<div>" + esc(c.type) + (c.smd ? " · SMD" : "") + ' · <span class="mono">' + esc(c.id) + "</span></div></div>" +
      '<div style="text-align:right;flex:none;min-width:88px"><div class="mono" style="font-size:17px;font-weight:600">' + qtyText(c) + "</div>" +
      '<div style="font-size:10.5px;color:var(--muted)">in stock</div></div>' +
      '<div style="flex:none">' + statusChip(c) + "</div>" +
      '<div class="locbox"><span class="lbl">Location</span><span class="bin big">' + esc(c.place) + "</span></div>" +
      (isAdmin() ? '<div style="flex:none"><button class="btn sm" data-edit="' + esc(c.id) + '">Edit</button></div>' : "") +
      "</div>";
  }).join("") + "</div></section>";
  return h;
}

/* ---------- inventory ---------- */
function filteredComps() {
  var list = S.q ? search(S.q, 500) : S.comps.slice();
  var f = S.filt;
  list = list.filter(function (c) {
    if (f.type && c.type !== f.type) return false;
    if (f.place && c.place !== f.place) return false;
    if (f.smd === "yes" && !c.smd) return false;
    if (f.smd === "no" && c.smd) return false;
    if (f.status && statusOf(c) !== f.status) return false;
    return true;
  });
  var k = S.sort.k, d = S.sort.d;
  list.sort(function (a, b) {
    var va, vb;
    if (k === "qty") { va = a.unknown ? -1 : (a.qty || 0); vb = b.unknown ? -1 : (b.qty || 0); }
    else if (k === "status") { var o = { out: 0, low: 1, unk: 2, ok: 3 }; va = o[statusOf(a)]; vb = o[statusOf(b)]; }
    else { va = String(a[k] || "").toLowerCase(); vb = String(b[k] || "").toLowerCase(); }
    if (va < vb) return -1 * d; if (va > vb) return 1 * d;
    return a.name.localeCompare(b.name);
  });
  return list;
}
function vInventory() {
  var list = filteredComps(), st = stats();
  var types = Object.keys(st.types).sort(), places = Object.keys(st.bins).sort();
  var h = '<div class="head"><div><h1>All components</h1><p class="sub">' + list.length +
    " of " + S.comps.length + " shown" + (S.q ? ' · filtered by “' + esc(S.q) + '”' : "") + "</p></div>" +
    '<span class="spacer" style="flex:1"></span>' +
    (isAdmin() ? '<button class="btn primary" data-go="manage">+ Add component</button>' : "") +
    '<button class="btn" id="csvBtn">Export CSV</button></div>';

  h += '<section class="panel"><div class="ph"><div class="filters">' +
    sel("fType", "All categories", types, S.filt.type) +
    sel("fPlace", "All locations", places, S.filt.place) +
    '<select class="" id="fSmd"><option value="">Through-hole + SMD</option>' +
    '<option value="no"' + (S.filt.smd === "no" ? " selected" : "") + ">Through-hole only</option>" +
    '<option value="yes"' + (S.filt.smd === "yes" ? " selected" : "") + ">SMD only</option></select>" +
    '<span class="segs">' +
    ["", "ok", "low", "out", "unk"].map(function (s) {
      return '<button data-st="' + s + '" class="' + (S.filt.status === s ? "on" : "") + '">' +
        (s === "" ? "All" : STATUS_LABEL[s]) + "</button>";
    }).join("") + "</span>" +
    (S.filt.type || S.filt.place || S.filt.status || S.filt.smd ? '<button class="btn sm" id="resetF">Reset</button>' : "") +
    "</div></div>";

  h += compTable(list);
  h += "</section>";
  return h;
}
function sel(id, ph, opts, cur) {
  return '<select id="' + id + '"><option value="">' + esc(ph) + "</option>" +
    opts.map(function (o) { return '<option value="' + esc(o) + '"' + (cur === o ? " selected" : "") + ">" + esc(o) + "</option>"; }).join("") +
    "</select>";
}
function sortTh(k, label, cls) {
  var on = S.sort.k === k;
  return '<th class="sortable ' + (cls || "") + '" data-sort="' + k + '">' + esc(label) +
    (on ? (S.sort.d > 0 ? " ↑" : " ↓") : "") + "</th>";
}
function compTable(list) {
  if (!list.length) return '<div class="empty"><b>No components match</b>Adjust the filters or clear the search.</div>';
  var h = '<div class="tablewrap"><table><thead><tr>' +
    sortTh("name", "Component") + sortTh("type", "Category") + sortTh("place", "Location") +
    sortTh("qty", "Qty") + "<th>Min</th>" + sortTh("status", "Status") +
    (isAdmin() ? '<th style="text-align:right">Actions</th>' : "") +
    "</tr></thead><tbody>";
  h += list.slice(0, 600).map(function (c) {
    return "<tr>" +
      '<td class="nm">' + esc(c.name) + (c.smd ? ' <span class="tag">SMD</span>' : "") + "<small>" + esc(c.id) + "</small></td>" +
      "<td>" + esc(c.type) + "</td>" +
      '<td><span class="bin">' + esc(c.place) + "</span></td>" +
      '<td class="num">' + qtyText(c) + "</td>" +
      '<td class="num" style="color:var(--muted);font-weight:400">' + minOf(c) + "</td>" +
      "<td>" + statusChip(c) + "</td>" +
      (isAdmin() ? '<td><div class="rowact">' +
        '<span class="stepper"><button data-dec="' + esc(c.id) + '" title="Remove one">−</button>' +
        '<button data-inc="' + esc(c.id) + '" title="Add one">+</button></span>' +
        '<button class="btn sm" data-issue="' + esc(c.id) + '">Issue</button>' +
        '<button class="btn sm" data-edit="' + esc(c.id) + '">Edit</button></div></td>' : "") +
      "</tr>";
  }).join("");
  h += "</tbody></table></div>";
  if (list.length > 600) h += '<div class="hint" style="padding:10px 16px">Showing first 600. Narrow the search to see the rest.</div>';
  return h;
}

/* ---------- alerts ---------- */
function vAlerts() {
  var out = S.comps.filter(function (c) { return statusOf(c) === "out"; });
  var low = S.comps.filter(function (c) { return statusOf(c) === "low"; });
  var unk = S.comps.filter(function (c) { return statusOf(c) === "unk"; });
  var srt = function (a, b) { return (a.qty || 0) - (b.qty || 0) || a.name.localeCompare(b.name); };
  out.sort(srt); low.sort(srt);

  var h = '<div class="head"><div><h1>Restocking list</h1>' +
    '<p class="sub">Anything at zero, below its category minimum, or never counted.</p></div>' +
    '<span class="spacer" style="flex:1"></span><button class="btn" id="csvLow">Export list</button></div>';

  h += '<div class="tiles">' +
    tile("Out of stock", out.length, "order these first", "alert") +
    tile("Below minimum", low.length, "running low", "warn") +
    tile("Never counted", unk.length, "need a physical count") +
    "</div>";

  h += '<section class="panel"><div class="ph"><h2>Out of stock</h2></div>' + compTable(out) + "</section>";
  h += '<section class="panel" style="margin-top:14px"><div class="ph"><h2>Below minimum</h2></div>' + compTable(low) + "</section>";
  h += '<section class="panel" style="margin-top:14px"><div class="ph"><h2>Never counted</h2>' +
    '<span class="sub" style="margin:0">quantity was “?” in the original register</span></div>' + compTable(unk) + "</section>";
  return h;
}

/* ---------- racks ---------- */
function vRacks() {
  var st = stats();
  var bins = Object.keys(st.bins);
  var rows = {}, other = [];
  bins.forEach(function (b) {
    var m = /^([A-H])(\d)$/.exec(b);
    if (m) { (rows[m[1]] = rows[m[1]] || []).push(b); } else { other.push(b); }
  });
  var h = '<div class="head"><div><h1>Rack map</h1>' +
    '<p class="sub">Every storage position in the lab. Pick a bin to see exactly what is inside it.</p></div></div>';

  if (S.bin) {
    var items = S.comps.filter(function (c) { return c.place === S.bin; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
    h += '<section class="panel" style="margin-bottom:16px"><div class="ph">' +
      '<span class="bin big">' + esc(S.bin) + "</span><h2>" + items.length + " component" + (items.length === 1 ? "" : "s") + " in this bin</h2>" +
      '<span class="spacer" style="flex:1"></span><button class="btn sm" id="closeBin">Close</button></div>' +
      compTable(items) + "</section>";
  }

  Object.keys(rows).sort().forEach(function (r) {
    h += '<div class="rowlabel">Rack ' + r + "</div>" + cells(rows[r].sort(), st);
  });
  if (other.length) h += '<div class="rowlabel">Boxes &amp; other storage</div>' + cells(other.sort(), st);
  return h;
}
function cells(list, st) {
  return '<div class="rackgrid">' + list.map(function (b) {
    var d = st.bins[b], okPct = d.n ? (d.n - d.low) / d.n * 100 : 0;
    return '<button class="cell" data-bin="' + esc(b) + '">' +
      '<span class="c1">' + esc(b) + "</span>" +
      '<span class="c2">' + d.n + " item" + (d.n === 1 ? "" : "s") + (d.low ? " · " + d.low + " low" : "") + "</span>" +
      '<span class="bar"><i style="width:' + okPct + '%;background:var(--ok)"></i>' +
      '<i style="width:' + (100 - okPct) + '%;background:var(--low)"></i></span></button>';
  }).join("") + "</div>";
}

/* ---------- issue & return ---------- */
function vIssue() {
  var open = S.issues.filter(function (x) { return x.status === "open"; })
    .sort(function (a, b) { return (b.at || "").localeCompare(a.at || ""); });
  var closed = S.issues.filter(function (x) { return x.status === "returned"; })
    .sort(function (a, b) { return (b.returnedAt || "").localeCompare(a.returnedAt || ""); }).slice(0, 40);

  var h = '<div class="head"><div><h1>Issue &amp; return</h1>' +
    '<p class="sub">Who is holding what. Issuing reduces shelf stock; returning puts it back.</p></div>' +
    '<span class="spacer" style="flex:1"></span>' +
    (isAdmin() ? '<button class="btn primary" id="newIssue">Issue a component</button>' : "") + "</div>";

  if (!isAdmin()) h += '<div class="note" style="margin-bottom:14px">You are in view-only mode. Ask an admin to issue or return components.</div>';

  h += '<section class="panel"><div class="ph"><h2>Currently issued</h2>' +
    '<span class="sub" style="margin:0">' + open.length + " open</span></div>";
  h += open.length ? '<div class="tablewrap"><table><thead><tr><th>Component</th><th>Issued to</th><th>Purpose</th>' +
    '<th class="num">Qty</th><th>Since</th>' + (isAdmin() ? '<th style="text-align:right">Action</th>' : "") + "</tr></thead><tbody>" +
    open.map(function (x) {
      return "<tr>" +
        '<td class="nm">' + esc(x.compName) + '<small>' + esc(x.place || "") + "</small></td>" +
        "<td><b>" + esc(x.person) + "</b></td>" +
        '<td style="color:var(--muted)">' + esc(x.purpose || "—") + "</td>" +
        '<td class="num">' + x.qty + "</td>" +
        '<td class="mono" style="color:var(--muted);white-space:nowrap">' + fmtWhen(x.at) + "</td>" +
        (isAdmin() ? '<td><div class="rowact"><button class="btn sm" data-return="' + esc(x.id) + '">Return</button></div></td>' : "") +
        "</tr>";
    }).join("") + "</tbody></table></div>"
    : '<div class="empty"><b>Nothing is out right now</b>Every component is on its shelf.</div>';
  h += "</section>";

  h += '<section class="panel" style="margin-top:14px"><div class="ph"><h2>Returned</h2></div>';
  h += closed.length ? '<div class="tablewrap"><table><thead><tr><th>Component</th><th>Was with</th>' +
    '<th class="num">Qty</th><th>Issued</th><th>Returned</th></tr></thead><tbody>' +
    closed.map(function (x) {
      return "<tr><td>" + esc(x.compName) + "</td><td>" + esc(x.person) + '</td><td class="num">' + x.qty + "</td>" +
        '<td class="mono" style="color:var(--muted)">' + fmtWhen(x.at) + "</td>" +
        '<td class="mono" style="color:var(--muted)">' + fmtWhen(x.returnedAt) + "</td></tr>";
    }).join("") + "</tbody></table></div>"
    : '<div class="empty"><b>No returns recorded yet</b></div>';
  h += "</section>";
  return h;
}

/* ---------- activity log ---------- */
function vLog() {
  var log = S.log || [];
  var h = '<div class="head"><div><h1>Activity log</h1>' +
    '<p class="sub">Last ' + log.length + " changes made to the register.</p></div></div>";
  h += '<section class="panel">';
  h += log.length ? '<div class="tablewrap"><table><thead><tr><th>What happened</th><th>By</th><th>When</th></tr></thead><tbody>' +
    log.map(function (e) {
      return "<tr><td>" + esc(e.text) + '</td><td><span class="tag">' + esc(e.who || "—") + "</span></td>" +
        '<td class="mono" style="color:var(--muted);white-space:nowrap">' + fmtWhen(e.at) + "</td></tr>";
    }).join("") + "</tbody></table></div>"
    : '<div class="empty"><b>Log is empty</b>Every add, edit, issue and return gets recorded here.</div>';
  h += "</section>";
  return h;
}

/* ---------- manage ---------- */
function vManage() {
  if (!isAdmin()) return lockedPage("Add and update components");
  var st = stats();
  var types = Object.keys(st.types).sort(), places = Object.keys(st.bins).sort();
  var h = '<div class="head"><div><h1>Add or update stock</h1>' +
    '<p class="sub">New arrival? Add it. Already on the shelf? Top up the existing line instead of creating a duplicate.</p></div></div>';

  h += '<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(330px,1fr))">';

  // add new
  h += '<section class="panel"><div class="ph"><h2>＋ Add a new component</h2></div><div class="pb">' +
    '<div class="ff"><div><label class="f" for="nName">Component name</label>' +
    '<input class="inp" id="nName" placeholder="e.g. 4.7K Ω Resistor" autocomplete="off"></div>' +
    '<div id="dupWarn"></div>' +
    '<div class="ff2"><div><label class="f" for="nType">Category</label>' +
    '<input class="inp" id="nType" list="typeList" placeholder="Resistor"><datalist id="typeList">' +
    types.map(function (t) { return "<option>" + esc(t) + "</option>"; }).join("") + "</datalist></div>" +
    '<div><label class="f" for="nPlace">Location / bin</label>' +
    '<input class="inp mono" id="nPlace" list="placeList" placeholder="A2"><datalist id="placeList">' +
    places.map(function (p) { return "<option>" + esc(p) + "</option>"; }).join("") + "</datalist></div></div>" +
    '<div class="ff2"><div><label class="f" for="nQty">Quantity</label>' +
    '<input class="inp mono" id="nQty" type="number" min="0" value="0"></div>' +
    '<div><label class="f" for="nMin">Low-stock minimum</label>' +
    '<input class="inp mono" id="nMin" type="number" min="0" placeholder="auto from category"></div></div>' +
    '<label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" id="nSmd"> Surface-mount (SMD) part</label>' +
    '<button class="btn primary" id="addGo">Add to register</button>' +
    '<div class="hint">Leave the minimum blank and the category default is used.</div></div></div></section>';

  // update existing
  h += '<section class="panel"><div class="ph"><h2>↻ Update an existing component</h2></div><div class="pb">' +
    '<label class="f" for="uFind">Find the component</label>' +
    '<input class="inp" id="uFind" placeholder="Type a name — 1k resistor, LM35…" autocomplete="off">' +
    '<div id="uRes" style="margin-top:12px"></div></div></section>';

  h += "</div>";

  h += '<section class="panel" style="margin-top:14px"><div class="ph"><h2>Bulk stock take</h2>' +
    '<span class="sub" style="margin:0">count a whole bin in one pass</span></div><div class="pb">' +
    '<label class="f" for="btBin">Choose a bin</label>' + sel("btBin", "Select a location…", places, "") +
    '<div id="btBody" style="margin-top:12px"></div></div></section>';
  return h;
}
function lockedPage(title) {
  return '<div class="head"><div><h1>' + esc(title) + "</h1>" +
    '<p class="sub">This area is for admins.</p></div></div>' +
    '<section class="panel"><div class="empty"><b>Admin sign-in required</b>' +
    'Use “Switch” in the top bar and enter the lab PIN to make changes.</div></section>';
}

/* ---------- settings ---------- */
function vSettings() {
  if (!isAdmin()) return lockedPage("Settings");
  var st = stats();
  var types = Object.keys(st.types).sort();
  var h = '<div class="head"><div><h1>Settings</h1>' +
    '<p class="sub">Low-stock rules, admin PIN and data export.</p></div></div>';

  h += '<section class="panel"><div class="ph"><h2>Low-stock minimum by category</h2>' +
    '<span class="spacer" style="flex:1"></span><button class="btn primary" id="saveTh">Save thresholds</button></div><div class="pb">' +
    '<div class="hint" style="margin:0 0 12px">A component turns amber when its quantity drops below the minimum for its category. ' +
    'A single component can also carry its own minimum, set from its Edit dialog — that always wins.</div>' +
    '<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(210px,1fr))">' +
    types.map(function (t) {
      var v = (S.cfg.thresholds && S.cfg.thresholds[t] != null) ? S.cfg.thresholds[t] : 3;
      return '<div><label class="f">' + esc(t) + " <span style=\"color:var(--muted)\">(" + st.types[t].n + ")</span></label>" +
        '<input class="inp mono th" data-th="' + esc(t) + '" type="number" min="0" value="' + v + '"></div>';
    }).join("") + "</div></div></section>";

  h += '<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr));margin-top:14px">';
  h += '<section class="panel"><div class="ph"><h2>Admin PIN</h2></div><div class="pb"><div class="ff">' +
    '<div><label class="f" for="newPin">New PIN</label><input class="inp mono" id="newPin" placeholder="at least 4 characters"></div>' +
    '<button class="btn primary" id="savePin">Change PIN</button>' +
    '<div class="note">The PIN separates admins from viewers inside this page. Everyone who can open the link can still read the stock list, so treat it as a workflow guard, not a security wall.</div>' +
    "</div></div></section>";

  h += '<section class="panel"><div class="ph"><h2>Export</h2></div><div class="pb"><div class="ff">' +
    '<div class="hint" style="margin:0">Download the whole register as CSV — opens directly in Excel or Google Sheets.</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<button class="btn" id="csvAll">Full inventory CSV</button>' +
    '<button class="btn" id="csvIssues">Issue records CSV</button></div>' +
    "</div></div></section>";
  h += "</div>";
  return h;
}

/* ========================================================================
   ACTIONS
   ==================================================================== */
function byId(id) {
  for (var i = 0; i < S.comps.length; i++) if (S.comps[i].id === id) return S.comps[i];
  return null;
}

function bump(id, delta) {
  var c = byId(id); if (!c) return;
  var next = Math.max(0, (c.unknown ? 0 : (c.qty || 0)) + delta);
  write("saveComponent", {
    id: c.id, name: c.name, type: c.type, smd: c.smd, place: c.place,
    qty: next, min: minOf(c), unknown: false
  }).catch(function () {});
}

function openEdit(id) {
  var c = byId(id); if (!c) return;
  modal("Edit component", '<div class="ff">' +
    '<div><label class="f" for="eName">Name</label><input class="inp" id="eName" value="' + esc(c.name) + '"></div>' +
    '<div class="ff2"><div><label class="f" for="eType">Category</label><input class="inp" id="eType" value="' + esc(c.type) + '"></div>' +
    '<div><label class="f" for="ePlace">Location / bin</label><input class="inp mono" id="ePlace" value="' + esc(c.place) + '"></div></div>' +
    '<div class="ff2"><div><label class="f" for="eQty">Quantity</label><input class="inp mono" id="eQty" type="number" min="0" value="' + (c.unknown ? "" : (c.qty || 0)) + '" placeholder="not counted"></div>' +
    '<div><label class="f" for="eMin">Minimum for this item</label><input class="inp mono" id="eMin" type="number" min="0" value="' + minOf(c) + '"></div></div>' +
    '<label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" id="eSmd"' + (c.smd ? " checked" : "") + "> Surface-mount (SMD) part</label>" +
    '<div class="hint mono">' + esc(c.id) + " · last change " + fmtWhen(c.updatedAt) + (c.updatedBy ? " by " + esc(c.updatedBy) : "") + "</div>" +
    "</div>",
    [{ label: "Delete", cls: "btn", act: function (close) { confirmDelete(c, close); } },
     { label: "Save changes", cls: "btn primary", act: function (close) {
       var qv = $("#eQty").value.trim();
       write("saveComponent", {
         id: c.id,
         name: $("#eName").value.trim() || c.name,
         type: $("#eType").value.trim() || c.type,
         place: ($("#ePlace").value.trim() || c.place).toUpperCase(),
         qty: qv === "" ? 0 : Math.max(0, parseInt(qv, 10) || 0),
         unknown: qv === "",
         min: Math.max(0, parseInt($("#eMin").value, 10) || 0),
         smd: $("#eSmd").checked
       }, "Saved.").then(close).catch(function () {});
     } }]);
}

function confirmDelete(c, closeParent) {
  modal("Remove from register?", '<p style="margin:0">This deletes <b>' + esc(c.name) +
    '</b> from bin <span class="bin">' + esc(c.place) + "</span> permanently. Its issue history stays in the log.</p>",
    [{ label: "Delete component", cls: "btn primary", act: function (close) {
      write("deleteComponent", { id: c.id }, "Component removed.").then(function () {
        close(); if (closeParent) closeParent();
      }).catch(function () {});
    } }]);
}

function openIssue(id) {
  if (!guard()) return;
  var c = byId(id); if (!c) return;
  var maxq = c.unknown ? 9999 : (c.qty || 0);
  modal("Issue " + c.name, '<div class="ff">' +
    '<div class="note">On the shelf: <b>' + qtyText(c) + '</b> in bin <span class="bin">' + esc(c.place) + "</span></div>" +
    '<div><label class="f" for="iPerson">Issued to</label><input class="inp" id="iPerson" placeholder="Student or staff name" autocomplete="off"></div>' +
    '<div class="ff2"><div><label class="f" for="iQty">Quantity</label><input class="inp mono" id="iQty" type="number" min="1" max="' + maxq + '" value="1"></div>' +
    '<div><label class="f" for="iPurpose">Purpose</label><input class="inp" id="iPurpose" placeholder="Project / lab work"></div></div>' +
    "</div>",
    [{ label: "Issue and reduce stock", cls: "btn primary", act: function (close) {
      var person = $("#iPerson").value.trim();
      if (!person) { toast("Enter who is taking it.", "bad"); return; }
      write("issue", {
        compId: c.id,
        qty: Math.max(1, parseInt($("#iQty").value, 10) || 1),
        person: person,
        purpose: $("#iPurpose").value.trim()
      }, "Issued to " + person + ".").then(close).catch(function () {});
    } }]);
}

function doReturn(issueId) {
  if (!guard()) return;
  var x = null;
  for (var i = 0; i < S.issues.length; i++) if (S.issues[i].id === issueId) x = S.issues[i];
  if (!x) return;
  modal("Return " + x.compName, '<p style="margin:0 0 12px">' + esc(x.person) + " is returning <b>" + x.qty +
    "</b> × " + esc(x.compName) + '. Put it back in bin <span class="bin">' + esc(x.place || "?") + "</span>.</p>" +
    '<label class="f" for="rQty">Quantity coming back</label><input class="inp mono" id="rQty" type="number" min="0" max="' + x.qty + '" value="' + x.qty + '">' +
    '<div class="hint">Enter a smaller number if some pieces were consumed or damaged.</div>',
    [{ label: "Record return", cls: "btn primary", act: function (close) {
      write("returnIssue", {
        id: x.id, qty: Math.max(0, Math.min(x.qty, parseInt($("#rQty").value, 10) || 0))
      }, "Return recorded.").then(close).catch(function () {});
    } }]);
}

function addComponent() {
  if (!guard()) return;
  var name = $("#nName").value.trim();
  if (!name) { toast("Give the component a name.", "bad"); return; }
  var type = $("#nType").value.trim() || "Misc";
  var minv = $("#nMin").value.trim();
  var place = ($("#nPlace").value.trim() || "UNASSIGNED").toUpperCase();
  write("saveComponent", {
    name: name, type: type, place: place,
    qty: Math.max(0, parseInt($("#nQty").value, 10) || 0),
    min: minv === "" ? ((S.cfg.thresholds || {})[type] != null ? S.cfg.thresholds[type] : (S.cfg.defaultMin || 3))
                     : Math.max(0, parseInt(minv, 10) || 0),
    smd: $("#nSmd").checked, unknown: false
  }, name + " added to " + place + ".").then(function () {
    ["#nName", "#nType", "#nPlace", "#nMin"].forEach(function (s) { var e = $(s); if (e) e.value = ""; });
    var q = $("#nQty"); if (q) q.value = "0";
    var smd = $("#nSmd"); if (smd) smd.checked = false;
    var w = $("#dupWarn"); if (w) w.innerHTML = "";
    var n = $("#nName"); if (n) n.focus();
  }).catch(function () {});
}

/* ---------- CSV ---------- */
function csvCell(v) {
  var s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvOf(rows) { return rows.map(function (r) { return r.map(csvCell).join(","); }).join("\r\n"); }
function inventoryCSV(list) {
  var rows = [["ID", "Component", "Category", "SMD", "Quantity", "Minimum", "Status", "Location", "Last updated", "By"]];
  list.forEach(function (c) {
    rows.push([c.id, c.name, c.type, c.smd ? "Yes" : "No", c.unknown ? "" : (c.qty || 0),
      minOf(c), STATUS_LABEL[statusOf(c)], c.place, c.updatedAt || "", c.updatedBy || ""]);
  });
  return csvOf(rows);
}
function issuesCSV() {
  var rows = [["Component", "Location", "Issued to", "Purpose", "Qty", "Issued at", "Status", "Returned at", "Returned qty"]];
  S.issues.forEach(function (x) {
    rows.push([x.compName, x.place || "", x.person, x.purpose || "", x.qty, x.at, x.status,
      x.returnedAt || "", x.returnedQty == null ? "" : x.returnedQty]);
  });
  return csvOf(rows);
}
function download(filename, text) {
  try {
    var blob = new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    toast("Saved " + filename, "good");
  } catch (e) {
    showCopy(text);
  }
}
function showCopy(text) {
  modal("Copy the CSV", '<p class="sub" style="margin:0 0 10px">Select all and paste into a blank sheet.</p>' +
    '<textarea class="inp mono" style="height:260px;white-space:pre" readonly>' + esc(text) + "</textarea>", []);
}

/* ---------- modal ---------- */
function modal(title, bodyHTML, actions) {
  var host = $("#modalHost");
  var v = document.createElement("div");
  v.className = "veil";
  v.innerHTML = '<div class="modal" role="dialog" aria-modal="true"><div class="mh"><h2>' + esc(title) +
    '</h2><button class="x" aria-label="Close">×</button></div><div class="mb">' + bodyHTML + "</div>" +
    ((actions && actions.length) ? '<div class="mf"></div>' : "") + "</div>";
  host.appendChild(v);
  function close() { v.remove(); }
  v.querySelector(".x").addEventListener("click", close);
  v.addEventListener("mousedown", function (e) { if (e.target === v) close(); });
  document.addEventListener("keydown", function esckey(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", esckey); }
  });
  var mf = v.querySelector(".mf");
  if (mf) {
    (actions || []).forEach(function (a) {
      var b = document.createElement("button");
      b.className = a.cls || "btn"; b.textContent = a.label;
      b.addEventListener("click", function () { a.act(close); });
      mf.appendChild(b);
    });
    var cancel = document.createElement("button");
    cancel.className = "btn"; cancel.textContent = "Cancel";
    cancel.addEventListener("click", close);
    mf.insertBefore(cancel, mf.firstChild);
  }
  var first = v.querySelector("input,textarea");
  if (first) first.focus();
  return close;
}

/* ========================================================================
   WIRING
   ==================================================================== */
function on(sel, ev, fn) { var e = $(sel); if (e) e.addEventListener(ev, fn); }

var viewWired = false;

function wire() {
  var root = $("#view");

  /* #view survives every render, so this delegated listener is attached
     once. Binding it per render would fire the handler once per past
     render and open a stack of duplicate dialogs. */
  if (!viewWired) {
  viewWired = true;
  root.addEventListener("click", function (e) {
    var t = e.target.closest("[data-inc],[data-dec],[data-edit],[data-issue],[data-return],[data-bin],[data-go],[data-sort],[data-st]");
    if (!t) return;
    if (t.dataset.inc) return bump(t.dataset.inc, 1);
    if (t.dataset.dec) return bump(t.dataset.dec, -1);
    if (t.dataset.edit) return openEdit(t.dataset.edit);
    if (t.dataset.issue) return openIssue(t.dataset.issue);
    if (t.dataset.return) return doReturn(t.dataset.return);
    if (t.dataset.bin != null) { S.bin = t.dataset.bin; render(); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    if (t.dataset.go) return go(t.dataset.go);
    if (t.dataset.sort) {
      var k = t.dataset.sort;
      S.sort = { k: k, d: S.sort.k === k ? -S.sort.d : 1 };
      return render();
    }
    if (t.dataset.st != null) { S.filt.status = t.dataset.st; return render(); }
  });
  }

  on("#clearQ", "click", function () { S.q = ""; $("#q").value = ""; render(); });
  on("#closeBin", "click", function () { S.bin = null; render(); });
  on("#resetF", "click", function () { S.filt = { type: "", place: "", status: "", smd: "" }; render(); });
  on("#fType", "change", function () { S.filt.type = this.value; render(); });
  on("#fPlace", "change", function () { S.filt.place = this.value; render(); });
  on("#fSmd", "change", function () { S.filt.smd = this.value; render(); });

  on("#csvBtn", "click", function () { download("ec-lab-inventory.csv", inventoryCSV(filteredComps())); });
  on("#csvAll", "click", function () { download("ec-lab-inventory.csv", inventoryCSV(S.comps)); });
  on("#csvIssues", "click", function () { download("ec-lab-issues.csv", issuesCSV()); });
  on("#csvLow", "click", function () {
    download("ec-lab-restock.csv", inventoryCSV(S.comps.filter(function (c) {
      var s = statusOf(c); return s === "low" || s === "out" || s === "unk";
    })));
  });

  on("#newIssue", "click", function () {
    modal("Pick a component to issue",
      '<label class="f" for="pickQ">Search</label><input class="inp" id="pickQ" placeholder="Component name…" autocomplete="off">' +
      '<div id="pickRes" style="margin-top:10px;max-height:290px;overflow:auto"></div>', []);
    var box = $("#pickRes");
    function draw() {
      var q = $("#pickQ").value;
      var list = q ? search(q, 25) : S.comps.slice(0, 25);
      box.innerHTML = list.length ? list.map(function (c) {
        return '<button class="choice" style="margin-bottom:6px" data-pick="' + esc(c.id) + '">' +
          '<span class="g mono" style="font-size:12px">' + esc(c.place) + "</span>" +
          "<span><b>" + esc(c.name) + "</b><span>" + esc(c.type) + " · " + qtyText(c) + " on shelf</span></span></button>";
      }).join("") : '<div class="empty">No match.</div>';
    }
    draw();
    $("#pickQ").addEventListener("input", draw);
    box.addEventListener("click", function (e) {
      var b = e.target.closest("[data-pick]"); if (!b) return;
      var veil = b.closest(".veil"); if (veil) veil.remove();
      openIssue(b.dataset.pick);
    });
  });

  on("#addGo", "click", addComponent);
  on("#nName", "input", function () {
    var v = this.value.trim(), w = $("#dupWarn"); if (!w) return;
    if (v.length < 3) { w.innerHTML = ""; return; }
    var hits = search(v, 3);
    w.innerHTML = hits.length ? '<div class="note">Already in the register: ' +
      hits.map(function (c) { return "<b>" + esc(c.name) + '</b> <span class="bin">' + esc(c.place) + "</span> (" + qtyText(c) + ")"; }).join(" · ") +
      " — top up that line instead of adding a duplicate.</div>" : "";
  });

  on("#uFind", "input", function () {
    var box = $("#uRes"), q = this.value.trim();
    if (!box) return;
    if (!q) { box.innerHTML = ""; return; }
    var hits = search(q, 6);
    box.innerHTML = hits.length ? hits.map(function (c) {
      return '<div style="display:flex;gap:10px;align-items:center;padding:9px 0;border-bottom:1px solid var(--line-soft)">' +
        '<span class="bin">' + esc(c.place) + "</span>" +
        '<span style="flex:1;min-width:0"><b>' + esc(c.name) + "</b>" +
        '<span style="display:block;font-size:11px;color:var(--muted)">' + esc(c.type) + " · " + qtyText(c) + " in stock</span></span>" +
        '<span class="stepper"><button data-dec="' + esc(c.id) + '">−</button><button data-inc="' + esc(c.id) + '">+</button></span>' +
        '<button class="btn sm" data-edit="' + esc(c.id) + '">Edit</button></div>';
    }).join("") : '<div class="hint">No component matches “' + esc(q) + '”. Add it as new on the left.</div>';
  });

  on("#btBin", "change", function () {
    var bin = this.value, box = $("#btBody");
    if (!bin) { box.innerHTML = ""; return; }
    var items = S.comps.filter(function (c) { return c.place === bin; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
    box.innerHTML = '<div class="tablewrap"><table><thead><tr><th>Component</th><th>Recorded</th><th>Counted now</th></tr></thead><tbody>' +
      items.map(function (c) {
        return "<tr><td>" + esc(c.name) + '</td><td class="num" style="color:var(--muted)">' + qtyText(c) + "</td>" +
          '<td style="width:120px"><input class="inp mono bt" data-bt="' + esc(c.id) + '" type="number" min="0" placeholder="' + (c.unknown ? "?" : (c.qty || 0)) + '"></td></tr>';
      }).join("") + '</tbody></table></div><button class="btn primary" id="btSave" style="margin-top:12px">Save counted quantities</button>';
    $("#btSave").addEventListener("click", function () {
      if (!guard()) return;
      var items2 = [];
      box.querySelectorAll(".bt").forEach(function (inp) {
        if (inp.value.trim() === "") return;
        items2.push({ id: inp.dataset.bt, qty: Math.max(0, parseInt(inp.value, 10) || 0) });
      });
      if (!items2.length) { toast("Nothing entered.", "bad"); return; }
      write("bulkQty", { items: items2, place: bin }, items2.length + " quantities updated.")
        .catch(function () {});
    });
  });

  on("#saveTh", "click", function () {
    if (!guard()) return;
    var th = {};
    document.querySelectorAll(".th").forEach(function (i) { th[i.dataset.th] = Math.max(0, parseInt(i.value, 10) || 0); });
    write("saveSettings", { thresholds: th }, "Thresholds saved.").catch(function () {});
  });
  on("#savePin", "click", function () {
    if (!guard()) return;
    var p = $("#newPin").value.trim();
    if (p.length < 4) { toast("Use at least 4 characters.", "bad"); return; }
    write("setPin", { pin: p }, "PIN changed.").then(function () {
      S.pin = p;
      var el = $("#newPin"); if (el) el.value = "";
    }).catch(function () {});
  });
}

function go(v) {
  S.view = v; S.bin = null;
  document.querySelectorAll("[data-v]").forEach(function (a) { a.classList.toggle("sel", a.dataset.v === v); });
  if (location.hash !== "#" + v) history.replaceState(null, "", "#" + v);
  render();
  window.scrollTo({ top: 0 });
}

/* ---------- shell ---------- */
document.addEventListener("click", function (e) {
  var a = e.target.closest("[data-v]");
  if (a) { e.preventDefault(); go(a.dataset.v); }
});
var qTimer;
on("#q", "input", function () {
  var v = this.value;
  clearTimeout(qTimer);
  qTimer = setTimeout(function () {
    S.q = v;
    if (v && S.view !== "inventory" && S.view !== "overview") go("overview");
    else render();
  }, 130);
});
document.addEventListener("keydown", function (e) {
  if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
    e.preventDefault(); $("#q").focus();
  }
});
on("#themeBtn", "click", function () {
  var cur = document.documentElement.getAttribute("data-theme");
  var next = cur === "dark" ? "light" : cur === "light" ? "" : "dark";
  if (next) document.documentElement.setAttribute("data-theme", next);
  else document.documentElement.removeAttribute("data-theme");
  try { localStorage.setItem("ec.theme", next); } catch (err) {}
});
try { var th0 = localStorage.getItem("ec.theme"); if (th0) document.documentElement.setAttribute("data-theme", th0); } catch (err) {}

on("#syncBtn", "click", function () { refresh(); });

on("#signBtn", "click", function () {
  S.role = "viewer"; S.me = ""; S.pin = "";
  $("#app").classList.remove("on");
  $("#gate").style.display = "grid";
  $("#pinBox").hidden = true;
  var pi = $("#pinIn"); if (pi) pi.value = "";
  $("#pinErr").textContent = "";
});

/* ---------- gate ---------- */
function enter(role, who) {
  S.role = role; S.me = who || "";
  $("#gate").style.display = "none";
  $("#app").classList.add("on");
  var pill = $("#rolePill");
  pill.classList.toggle("admin", role === "admin");
  $("#roleTxt").textContent = role === "admin" ? (who ? "Admin · " + who : "Admin") : "View only";
  var v = (location.hash || "#overview").slice(1);
  go(["overview", "inventory", "alerts", "racks", "issue", "log", "manage", "settings"].indexOf(v) > -1 ? v : "overview");
  markSync();
}
on("#cViewer", "click", function () { enter("viewer"); });
on("#cAdmin", "click", function () {
  $("#pinBox").hidden = false;
  $("#pinIn").focus();
});
on("#pinBack", "click", function () { $("#pinBox").hidden = true; $("#pinErr").textContent = ""; });

function tryPin() {
  var v = $("#pinIn").value.trim();
  if (!v) { $("#pinErr").textContent = "Enter the lab PIN."; return; }
  $("#pinErr").textContent = "Checking…";
  S.pin = v;
  apiPost("login", {}).then(function (res) {
    if (res && res.ok) {
      var who = "";
      try { who = localStorage.getItem("ec.who") || ""; } catch (e) {}
      if (!who) {
        who = (prompt("Your name (shown on stock changes):") || "admin").trim();
        try { localStorage.setItem("ec.who", who); } catch (e) {}
      }
      $("#pinErr").textContent = "";
      enter("admin", who);
    } else {
      S.pin = "";
      $("#pinErr").textContent = (res && res.error) || "That PIN does not match.";
      $("#pinIn").select();
    }
  }).catch(function () {
    S.pin = "";
    $("#pinErr").textContent = "Could not reach the lab sheet. Check the connection.";
  });
}
on("#pinGo", "click", tryPin);
on("#pinIn", "keydown", function (e) { if (e.key === "Enter") tryPin(); });

/* ---------- boot ---------- */
function boot() {
  var status = $("#gateStatus");
  if (!CONFIGURED) {
    status.innerHTML = '<span style="color:var(--out)">Not connected yet.</span> ' +
      "Open <b>docs/config.js</b> and paste your Apps Script web-app URL into <b>apiUrl</b>. " +
      "The steps are in DEPLOY.md.";
    $("#cViewer").disabled = true;
    $("#cAdmin").disabled = true;
    return;
  }
  status.textContent = "Connecting to the lab sheet…";
  apiGet().then(function (res) {
    if (!res || !res.ok) throw new Error((res && res.error) || "The server did not answer.");
    absorb(res.data);
    status.textContent = S.comps.length
      ? S.comps.length + " components loaded from the lab sheet."
      : "The sheet is empty — sign in as admin and add your first component.";
  }).catch(function (err) {
    status.innerHTML = '<span style="color:var(--out)">Could not reach the lab sheet: ' +
      esc(err.message) + "</span> Check the URL in config.js and that the web app is deployed for “Anyone”.";
  });
}

setInterval(function () {
  if (!document.hidden && S.loaded && $("#app").classList.contains("on")) refresh(true);
}, 60000);
document.addEventListener("visibilitychange", function () {
  if (!document.hidden && S.loaded && $("#app").classList.contains("on")) refresh(true);
});

boot();
