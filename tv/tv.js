/* GAME FINDER - Samsung Tizen TV app.
   Reuses the same schedule data + ranking as the phone PWA. 10-foot UI, remote-driven.
   Selecting a watch option LAUNCHES that streaming app on the TV (ESPN, Peacock, etc.),
   deep-linking to the event where the app accepts it.

   App IDs are NOT assumed: on startup we enumerate the apps actually installed on THIS TV
   (tizen.application.getAppsInfo) and match them to our services by name. A seed map in
   config/tizen_apps.json is only a fallback. Runs in a desktop browser too (tizen absent)
   so navigation can be tested before sideloading. */
(function () {
  "use strict";
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var el = function (t, c, x) { var e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
  var IS_TV = !!(window.tizen && tizen.application);          // Samsung Tizen
  var IS_ANDROID = !!(window.AndroidTV && window.AndroidTV.launch) ||
    (/Android/i.test(navigator.userAgent) && /TV|AFT|BRAVIA|GoogleTV|SmartTV|Chromecast/i.test(navigator.userAgent)); // Sony / Google TV
  var IS_WEBOS = !!(window.PalmSystem || /Web0S|webOS/i.test(navigator.userAgent)); // LG
  var ON_TV = IS_TV || IS_ANDROID || IS_WEBOS;

  // Where to read schedule data + service info.
  // Served over http(s) -> same-origin; a sideloaded TV widget (file://) reads the hosted public copy.
  var HOSTED = "https://deadshift187.github.io/sports-preview";   // public copy, CORS-enabled
  // Base = this page's folder minus a trailing /tv/ (data + config live beside the app, not under tv/),
  // so the build works at any path, e.g. deadshift187.github.io/sports-preview/tv/ reads .../sports-preview/data.
  var SAME = null;
  if (location.protocol.indexOf("http") === 0) {
    var dir = location.href.replace(/[?#].*$/, "").replace(/[^\/]*$/, "");  // .../tv/
    SAME = dir.replace(/\/tv\/$/, "/").replace(/\/$/, "");
  }
  var HOST = localStorage.getItem("gf_host") || SAME || HOSTED;
  var DATA_URL = HOST + "/data/games.json";
  var SVC_URL = HOST + "/config/services.json";
  var APPMAP_URL = HOST + "/config/tizen_apps.json";

  var state = { view: "today", group: "All", data: null, svc: [], seed: {}, match: {},
                zone: "list", gi: 0, bi: 0, oi: 0, games: [], installed: {} };
  var owned = new Set();

  function load(url) { return fetch(url, { cache: "no-store" }).then(function (r) { return r.json(); }); }

  Promise.all([load(DATA_URL), load(SVC_URL).catch(function () { return { services: [] }; }),
               load(APPMAP_URL).catch(function () { return { services: {} }; })])
    .then(function (r) {
      state.data = r[0]; state.svc = (r[0].services && r[0].services.length ? r[0].services : r[1].services) || [];
      var am = r[2] || {};
      for (var sid in (am.services || {})) { state.seed[sid] = am.services[sid].appId || null; state.match[sid] = (am.services[sid].match || []).map(function (s) { return s.toLowerCase(); }); }
      owned = new Set(loadArr("gf_services"));
      // First run on this TV (nothing picked yet) -> open Setup so the user tells us what they have.
      if (!localStorage.getItem("gf_tv_seen") && !owned.size && !loadArr("gf_groups").length && !loadArr("gf_leagues").length) {
        state.view = "setup"; state.zone = "list";
        try { localStorage.setItem("gf_tv_seen", "1"); } catch (e) {}
      }
      discoverApps(function () { buildGroups(); render(); });
      tickClock();
    })
    .catch(function (e) {
      $("#list").innerHTML = '<div class="empty">Can\'t reach the schedule right now.<br>Check this TV\'s internet connection and try again.</div>';
    });

  function loadArr(k) { try { return JSON.parse(localStorage.getItem(k) || "[]"); } catch (e) { return []; } }
  function saveArr(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  // Built-in service -> installed-app-name substrings (so we don't depend on a config fetch,
  // which 404s on the hosted copy). Used to match the apps actually on this TV by name.
  var MATCH = {
    espn: ["espn"], espnplus: ["espn"], paramount: ["paramount"], peacock: ["peacock"],
    prime: ["prime video", "amazon prime", "amazon"], appletv: ["apple tv"], netflix: ["netflix"],
    hbomax: ["max", "hbo"], foxone: ["fox one", "fox sports", "fox now", "fox"], dazn: ["dazn"],
    youtubetv: ["youtube tv"], fubo: ["fubo"], hululive: ["hulu"], sling: ["sling"], directv: ["directv"],
    nflplus: ["nfl"], nbalp: ["nba"], mlbtv: ["mlb"], beinsports: ["bein"], vix: ["vix"],
    tennischannel: ["tennis channel"], willow: ["willow"], youtube: ["youtube"], tubi: ["tubi"], pluto: ["pluto"]
  };

  // webOS can't list third-party apps (listApps is denied), so we use a STATIC table of LG app ids.
  // A wrong/absent id just fails the launch and we open the LG Content Store instead - so an
  // unverified id degrades safely. Verify each on-device with getAppInfo after the apps are installed
  // (see verify_webos.md) and correct the "id" here; flip verified:true as each passes.
  // verified:true = read from a real LG's installed-app list (27U511SA, webOS 8, 2026-10-14, via SSAP listApps).
  var WEBOS_APPS = {
    netflix:    { id: "netflix", verified: true },
    youtube:    { id: "youtube.leanback.v4-pjtr", verified: true },
    prime:      { id: "amazon", verified: true },
    appletv:    { id: "com.apple.appletv", verified: true },
    espn:       { id: "com.espn.espnplus-prod", verified: true },
    espnplus:   { id: "com.espn.espnplus-prod", verified: true },
    paramount:  { id: "com.cbs-all-access.webapp.prod", verified: true },
    cbssports:  { id: "com.cbs-sports.webapp.prod", verified: true },
    hbomax:     { id: "com.wbd.stream", verified: true },
    hululive:   { id: "hulu", verified: true },
    sling:      { id: "com.movenetworks.app.sling-tv-sling-production", verified: true },
    fubo:       { id: "com.fubotv.app", verified: true },
    dazn:       { id: "dazn", verified: true },
    mlbtv:      { id: "com.mlbtv.app", verified: true },
    nflplus:    { id: "com.nfl.app", verified: true },
    tubi:       { id: "com.tubitv.ott.tubi", verified: true },
    pluto:      { id: "com.plutotv.app", verified: true },
    // not installed on the test LG yet - best guesses until verified:
    peacock:    { id: "com.peacocktv.peacock", verified: false },
    foxone:     { id: "com.fox.now", verified: false },
    youtubetv:  { id: "youtube.tv", verified: false },
    nbalp:      { id: "com.nba.gametime", verified: false }
  };
  var WEBOS_STORE = "com.webos.app.discovery"; // LG Content Store

  // webOS luna bus call (LG). Returns parsed JSON to onS, or calls onE.
  function lunaCall(uri, params, onS, onE) {
    try {
      var bridge = new PalmServiceBridge();
      bridge.onservicecallback = function (s) { var r = {}; try { r = JSON.parse(s); } catch (e) {} (r.returnValue !== false ? onS : (onE || function () {}))(r); };
      bridge.call(uri, JSON.stringify(params || {}));
    } catch (e) { (onE || function () {})(e); }
  }

  // --- discover which streaming apps are actually installed on THIS TV ---
  function discoverApps(cb) {
    if (IS_WEBOS) {
      // listApps is denied for third-party apps on webOS, so use the static table (above).
      for (var sid in WEBOS_APPS) state.installed[sid] = { id: WEBOS_APPS[sid].id, name: svcName(sid) };
      return cb();
    }
    if (IS_ANDROID) {
      try {
        var csv = state.svc.map(function (s) { return s.id; }).join(",");
        JSON.parse(window.AndroidTV.installed(csv) || "[]").forEach(function (sid) {
          state.installed[sid] = { id: sid, name: svcName(sid) };
        });
      } catch (e) { /* if the bridge errors, options just won't be marked installed */ }
      return cb();
    }
    if (!IS_TV || !tizen.application.getAppsInfo) { return cb(); }
    try {
      tizen.application.getAppsInfo(function (apps) {
        apps.forEach(function (a) {
          var nm = (a.name || "").toLowerCase();
          for (var sid in state.match) {
            if (state.installed[sid]) continue;
            if (state.match[sid].some(function (s) { return s && nm.indexOf(s) >= 0; })) state.installed[sid] = { id: a.id, name: a.name };
          }
        });
        cb();
      }, function () { cb(); });
    } catch (e) { cb(); }
  }
  function appFor(sid) { return state.installed[sid] || (state.seed[sid] ? { id: state.seed[sid], name: sid } : null); }

  // "Get the app": open the LG Content Store (webOS) to that service so the user can install it.
  function getAppWebOS(sid) {
    var wa = WEBOS_APPS[sid];
    var params = wa && wa.id ? { contentTarget: "app/" + wa.id, id: wa.id } : { query: svcName(sid) };
    lunaCall("luna://com.webos.applicationManager/launch", { id: WEBOS_STORE, params: params },
      function () { toast("Get " + svcName(sid) + " from the LG store"); },
      function () { toast(svcName(sid) + " isn't installed on this TV"); });
  }

  // --- launch a service's app on the TV, deep-linking to the event when possible ---
  function launchService(sid, deepUrl) {
    if (IS_WEBOS && window.PalmServiceBridge) {
      var wa = appFor(sid);
      if (!wa) { getAppWebOS(sid); return; }
      var ok = function () { toast("Opening " + svcName(sid) + "…"); };
      // if the app isn't installed the launch errors -> open the LG Content Store to it instead
      var plain = function () { lunaCall("luna://com.webos.applicationManager/launch", { id: wa.id }, ok, function () { getAppWebOS(sid); }); };
      if (deepUrl) { lunaCall("luna://com.webos.applicationManager/launch", { id: wa.id, params: { contentTarget: deepUrl, target: deepUrl } }, ok, plain); }
      else plain();
      return;
    }
    // Check the native bridge lazily (Capacitor may inject it after load); else fall through to the instruction.
    if (window.AndroidTV && window.AndroidTV.launch) { try { window.AndroidTV.launch(sid, deepUrl || "", svcName(sid)); } catch (e) {} return; }
    // Plain TV browser (Samsung Internet, etc.): can't launch apps — tell the user which app to open.
    if (!IS_TV) { toast("📺 Open the " + svcName(sid) + " app on your TV" + (deepUrl ? " and find this game" : "")); return; }
    var app = appFor(sid);
    if (!app) { toast(svcName(sid) + " isn't installed on this TV"); return; }
    var done = function () { toast("Opening " + (app.name || svcName(sid)) + "…"); };
    var fallback = function () { try { tizen.application.launch(app.id, done, function () { toast("Couldn't open " + svcName(sid)); }); } catch (e) { toast("Couldn't open " + svcName(sid)); } };
    if (deepUrl) {
      try {
        var ctl = new tizen.ApplicationControl("http://tizen.org/appcontrol/operation/view", deepUrl, null, null);
        tizen.application.launchAppControl(ctl, app.id, done, fallback, null);
        return;
      } catch (e) { /* fall through */ }
    }
    fallback();
  }

  // --- data helpers (shared shape with the phone app) ---
  function parse(s) { return s ? new Date(s) : null; }
  function dayKey(d) { return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
  function fmtTime(d) { return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
  function svcName(id) { for (var i = 0; i < state.svc.length; i++) if (state.svc[i].id === id) return state.svc[i].name; return id; }
  function svcWeb(id) { for (var i = 0; i < state.svc.length; i++) if (state.svc[i].id === id) return state.svc[i].web; return ""; }

  // Live for DISPLAY - a game stuck "in" long after it ended is stale data, not live (see live.js).
  function liveNow(g) { return (window.GFLive && GFLive.isLive) ? GFLive.isLive(g) : g.status === "in"; }
  var FREE_SVC = { antenna: 1, tubi: 1, pluto: 1, rokuchannel: 1, roku: 1, fandango: 1, youtube: 1, nwslplus: 1, freevee: 1, vix: 1, kanopy: 1 };
  // Fan-priority by sport so football leads on NFL days, then the big leagues, college hoops, then golf/niche.
  var SPORT_PRI = { nfl: 0, nba: 10, cfb: 11, mlb: 20, nhl: 21, epl: 30, mls: 31, laliga: 32, seriea: 33, bundesliga: 34, ligue1: 35, ucl: 36, uel: 37, uecl: 37, "liga-mx": 38, ligamx: 38, efl: 39, mcbb: 50, wcbb: 51, wnba: 52 };
  function sportPri(g) {
    var k = (g.league || "").toLowerCase(); if (k in SPORT_PRI) return SPORT_PRI[k];
    var grp = (g.group || "").toLowerCase();
    if (grp === "football") return 5; if (grp === "soccer") return 40; if (grp === "basketball") return 53;
    if (grp === "hockey" || grp === "baseball") return 25; if (grp === "golf" || grp === "racing") return 95;
    return 85;
  }

  function inView(g) {
    var s = parse(g.start), now = new Date();
    if (state.view === "live") return liveNow(g);
    if (liveNow(g)) return true;
    if (state.view === "today") return s && (dayKey(s) === dayKey(now) || (g.multiday && g.status !== "post" && dayKey(s) <= dayKey(now)));
    if (state.view === "week" || state.view === "mine") return true;
    if (state.view === "weekend") { if (!s) return false; var d = s.getDay(), a = (s - now) / 864e5; return (d === 5 || d === 6 || d === 0) && a > -1 && a < 7.5; }
    return true;
  }
  function mineMatch(g) {
    if (loadArr("gf_groups").indexOf(g.group) >= 0) return true;
    if (loadArr("gf_leagues").indexOf(g.league) >= 0) return true;
    var t = loadArr("gf_teams").map(String);
    return (g.home && t.indexOf(String(g.home.id)) >= 0) || (g.away && t.indexOf(String(g.away.id)) >= 0);
  }

  function buildGroups() {
    var box = $("#groups"); box.innerHTML = ""; var seen = { All: 1 }, groups = ["All"];
    (state.data.games || []).forEach(function (g) { if (!seen[g.group]) { seen[g.group] = 1; groups.push(g.group); } });
    groups.forEach(function (gr) { var c = el("div", "chip" + (gr === state.group ? " on" : ""), gr); c.dataset.g = gr; box.appendChild(c); });
    var t = el("div", "chip toggle" + (state.showAll ? " on" : ""), state.showAll ? "Showing all" : "Show all");
    t.dataset.toggle = "showall"; box.appendChild(t);
  }

  function currentGames() {
    var mine = state.view === "mine";
    var gs = (state.data.games || []).filter(function (g) {
      if (state.group !== "All" && g.group !== state.group) return false;
      if (mine && !mineMatch(g)) return false;
      // By default hide games with no US listing (keep anything live); "Show all" reveals them.
      if (!state.showAll && !liveNow(g) && !(g.watch && g.watch.length)) return false;
      return inView(g);
    });
    // Games with somewhere to watch come first; "no confirmed US listing" ones sink to the bottom.
    var listed = function (g) { return g.watch && g.watch.length ? 0 : 1; };
    gs.sort(function (a, b) { var la = liveNow(a) ? 0 : 1, lb = liveNow(b) ? 0 : 1; return (listed(a) - listed(b)) || (sportPri(a) - sportPri(b)) || (la - lb) || ((a.start || "") < (b.start || "") ? -1 : 1); });
    return gs;
  }

  var MAX_ROWS = 7;
  function render() {
    [].forEach.call($("#views").children, function (b) { b.classList.toggle("on", b.dataset.v === state.view); });
    [].forEach.call($("#groups").children, function (b) { b.classList.toggle("on", b.dataset.g === state.group); });
    $("#groups").style.visibility = state.view === "setup" ? "hidden" : "visible";
    liveIndicator();
    if (state.view === "setup") { renderSetup(); return; }
    var list = $("#list"); list.innerHTML = "";
    state.games = currentGames();
    if (!state.games.length) { list.appendChild(el("div", "empty", "Nothing here right now.")); setFoot(); updateFocus(); return; }
    // Keep the SAME game highlighted across a data refresh / re-sort (focus by id, not list position).
    if (state.focusId) { for (var fi = 0; fi < state.games.length; fi++) { if (state.games[fi].id === state.focusId) { state.gi = fi; break; } } }
    if (state.gi >= state.games.length) state.gi = state.games.length - 1;
    var start = Math.max(0, Math.min(state.gi - 3, state.games.length - MAX_ROWS));
    state.games.slice(start, start + MAX_ROWS).forEach(function (g, i) {
      var idx = start + i; var card = gameRow(g); card.dataset.i = idx; list.appendChild(card);
    });
    setFoot(); updateFocus();
  }

  // --- Setup rows: services to tick (gold) + sports to follow (populates "My teams") ---
  function setupRows() {
    var rows = (state.svc || []).filter(function (s) { return s.id !== "cable" && s.id !== "rsn"; })
      .map(function (s) { return { kind: "svc", id: s.id, name: s.id === "antenna" ? "Free TV (antenna)" : s.name }; });
    var seen = {}, groups = [];
    (state.data && state.data.games || []).forEach(function (g) { if (g.group && !seen[g.group]) { seen[g.group] = 1; groups.push(g.group); } });
    groups.sort();
    return rows.concat(groups.map(function (gr) { return { kind: "group", id: gr, name: "Follow " + gr + " (My teams)" }; }));
  }
  function renderSetup(keepFocus) {
    var list = $("#list"); list.innerHTML = "";
    list.appendChild(el("div", "setup-head", "Tick the services you have (games turn gold), and follow sports for “My teams”. ↑↓ and OK."));
    state.games = setupRows();  // reuse the list-zone nav
    if (state.gi >= state.games.length) state.gi = state.games.length - 1;
    var fgroups = loadArr("gf_groups");
    var start = Math.max(0, Math.min(state.gi - 4, state.games.length - 9));
    state.games.slice(start, start + 9).forEach(function (r, i) {
      var idx = start + i, on = r.kind === "svc" ? owned.has(r.id) : fgroups.indexOf(r.id) >= 0;
      var row = el("div", "game setup-row" + (on ? " on" : ""));
      row.appendChild(el("div", "chk", on ? "☑" : "☐"));
      row.appendChild(el("div", "mt", r.name));
      row.dataset.i = idx; list.appendChild(row);
    });
    $("#foot").textContent = "OK toggles · saved on this TV · no account, no login";
    updateFocus();
  }

  function liveLine(g) { return (window.GFLive && GFLive.liveLine) ? GFLive.liveLine(g) : (g.status_detail || ""); }
  function gameRow(g) {
    var c = el("div", "game");
    var when = el("div", "when");
    if (liveNow(g)) { when.appendChild(el("span", "lv", "LIVE")); when.appendChild(el("span", "lvstate", liveLine(g))); }
    else if (g.status === "post") when.textContent = g.status_detail || "Final";
    else { var s = parse(g.start); when.textContent = g.time_tbd ? "Time TBD" : (s ? fmtTime(s) : ""); }
    c.appendChild(when);
    var mid = el("div", "mid");
    mid.appendChild(el("div", "lg", g.league_name));
    var home = g.home || {}, away = g.away || {};
    var title = (g.home || g.away) ? ((away.short || away.name || "") + (g.score ? " " + g.score.away : "") + "  @  " + (g.score ? g.score.home + " " : "") + (home.short || home.name || "")) : (g.short || g.name);
    mid.appendChild(el("div", "mt", title));
    c.appendChild(mid);
    var why = GFRank.whyLine(g, owned, state.svc);
    var w = el("div", "where c-" + why.color, why.text); c.appendChild(w);
    return c;
  }

  function setFoot() {
    var d = state.data, when = d && d.generated ? new Date(d.generated).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
    $("#foot").textContent = "Press OK to see where to watch & listen · data checked " + when + " · no ads";
  }

  // --- focus / remote navigation ---
  function focusables() {
    if (state.zone === "views") return [].slice.call($("#views").children);
    if (state.zone === "groups") return [].slice.call($("#groups").children);
    return [].slice.call($("#list").querySelectorAll(".game"));
  }
  function updateFocus() {
    document.querySelectorAll(".focus").forEach(function (e) { e.classList.remove("focus"); });
    if (!$("#overlay").hidden) return;
    var f = focusables();
    if (state.zone === "list") { var sel = $('.game[data-i="' + state.gi + '"]'); if (sel) sel.classList.add("focus"); if (state.view !== "setup" && state.games[state.gi]) state.focusId = state.games[state.gi].id; }
    else if (f[state.bi]) f[state.bi].classList.add("focus");
    // Keep the focused chip/button on screen (rows like the sport chips overflow sideways).
    var cur = document.querySelector(".focus");
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest", inline: "center" });
  }

  function moveList(delta) {
    if (!state.games.length) return;
    state.gi = Math.max(0, Math.min(state.games.length - 1, state.gi + delta));
    render();
  }

  document.addEventListener("keydown", function (e) {
    var k = e.keyCode;
    if (!$("#overlay").hidden) return overlayKey(k, e);
    if (k === 38) { // Up
      if (state.zone === "list") { if (state.gi === 0) { state.zone = "groups"; state.bi = Math.min(state.bi, $("#groups").children.length - 1); updateFocus(); } else moveList(-1); }
      else if (state.zone === "groups") { state.zone = "views"; state.bi = Math.min(state.bi, $("#views").children.length - 1); updateFocus(); }
    } else if (k === 40) { // Down
      if (state.zone === "views") { state.zone = "groups"; state.bi = Math.min(state.bi, $("#groups").children.length - 1); updateFocus(); }
      else if (state.zone === "groups") { state.zone = "list"; updateFocus(); }
      else moveList(1);
    } else if (k === 37) { // Left
      if (state.zone === "list") { state.zone = "groups"; } else if (state.bi > 0) state.bi--;
      updateFocus();
    } else if (k === 39) { // Right
      if (state.zone !== "list" && state.bi < focusables().length - 1) state.bi++;
      updateFocus();
    } else if (k === 13) { // OK/Enter
      activate();
    } else if (k === 10009 || k === 461 || k === 8 || k === 27) { // Back
      if (state.view === "setup") { state.view = "today"; state.zone = "list"; render(); e.preventDefault(); return; }
      if (state.zone !== "list") { state.zone = "list"; updateFocus(); e.preventDefault(); return; }
      // Top level: LG certification wants Back to exit. Confirm once so a stray press doesn't quit.
      if (state._exitArmed) { exitApp(); return; }
      state._exitArmed = true; toast("Press Back again to exit"); clearTimeout(state._exitT);
      state._exitT = setTimeout(function () { state._exitArmed = false; }, 3000); e.preventDefault();
    }
  });

  // Exit to the TV launcher (LG webOS / Tizen have their own calls; fall back to window.close()).
  function exitApp() {
    try { if (window.tizen && tizen.application) { tizen.application.getCurrentApplication().exit(); return; } } catch (e) {}
    try { if (window.webOSSystem && webOSSystem.platformBack) { webOSSystem.platformBack(); return; } } catch (e) {}
    try { if (window.webOS && window.webOS.platformBack) { window.webOS.platformBack(); return; } } catch (e) {}
    try { window.close(); } catch (e) {}
  }

  function activate() {
    if (state.zone === "views") { state.view = $("#views").children[state.bi].dataset.v; state.gi = 0; render(); }
    else if (state.zone === "groups") {
      var chip = $("#groups").children[state.bi];
      if (chip && chip.dataset.toggle === "showall") { state.showAll = !state.showAll; state.gi = 0; render(); }
      else { state.group = chip.dataset.g; state.gi = 0; render(); }
    }
    else if (state.view === "setup") {
      var r = state.games[state.gi]; if (!r) return;
      if (r.kind === "group") {
        var a = loadArr("gf_groups"), ix = a.indexOf(r.id);
        if (ix >= 0) a.splice(ix, 1); else a.push(r.id);
        saveArr("gf_groups", a);
      } else {
        if (owned.has(r.id)) owned.delete(r.id); else owned.add(r.id);
        saveArr("gf_services", [].slice.call(owned));
      }
      renderSetup();
    }
    else { openGame(state.games[state.gi]); }
  }

  // --- game detail overlay ---
  var curOpts = [];
  function openGame(g) {
    if (!g) return;
    var ranked = GFRank.rankWatch(g.watch, owned);
    $("#sheetTitle").textContent = (g.home || g.away) ? ((g.away && (g.away.name || g.away.short)) + " @ " + (g.home && (g.home.name || g.home.short))) : (g.name || g.short);
    var why = GFRank.whyLine(g, owned, state.svc);
    var sw = $("#sheetWhy"); sw.textContent = why.text; sw.className = why.tone;
    var box = $("#watchOpts"); box.innerHTML = ""; curOpts = [];
    var dividerPut = false, shown = {};
    function pushDivider() { if (!dividerPut && curOpts.length) { box.appendChild(el("div", "divider", "Stream / pay")); dividerPut = true; } }
    // A navigable row for one service app (the network's own stream, a pay app, a live-TV bundle).
    function appRow(sid) {
      if (!sid || shown[sid]) return; shown[sid] = 1;
      var app = appFor(sid), have = owned.has(sid), notInstalled = ON_TV && !app && !have;
      if (!have) pushDivider();
      var o = el("div", "opt c-" + (have ? "gold" : "orange") + (notInstalled ? " getapp" : ""));
      o.appendChild(el("span", "svc", svcName(sid)));
      o.appendChild(el("span", "tag", have ? "you have it" : (notInstalled ? "Get the app →" : "subscription")));
      box.appendChild(o);
      curOpts.push({ sid: sid, deep: svcWeb(sid), node: o, getapp: notInstalled });
    }
    ranked.forEach(function (r) {
      if (r.cat === "pay") pushDivider();
      var app = appFor(r.open);
      // Name the exact app in the main row (CBS -> "Watch in Paramount+"), not a bare network chip.
      var streamApp = (r.w.apps || []).filter(function (a) { return a !== "antenna" && a !== "cable"; })[0];
      var primary = (r.cat !== "free") ? r.open : (streamApp || r.open);
      var have = owned.has(primary), app = appFor(primary);
      var notInstalled = ON_TV && primary && primary !== "antenna" && !have && !app;
      var col = have ? "gold" : (primary === "antenna" ? "green" : (r.cat === "free" && FREE_SVC[primary] ? "green" : "orange"));
      var o = el("div", "opt c-" + col + (notInstalled ? " getapp" : ""));
      var main = (primary === "antenna") ? (r.w.name + "  ·  Free with a TV antenna") : (r.w.name + "  →  Watch in " + svcName(primary));
      o.appendChild(el("span", "svc", main));
      var tag = r.w.confidence === "unverified" ? "unconfirmed" : (notInstalled ? "Get the app →" : (have ? "you have it" : (primary === "antenna" ? "free" : "subscription")));
      o.appendChild(el("span", "tag", tag));
      box.appendChild(o);
      if (primary) shown[primary] = 1;
      curOpts.push({ sid: primary, deep: svcWeb(primary), node: o, getapp: notInstalled });
      if (r.w.free_ota && streamApp) box.appendChild(el("div", "freenote", "Also free on " + r.w.name + " with a TV antenna"));
      // Surface any OTHER apps these networks carry too.
      (r.w.apps || []).forEach(function (id) { if (id !== "antenna" && id !== "cable") appRow(id); });
    });
    // Live-TV bundles that carry these channels, as launchable rows.
    var bundleIds = {};
    ranked.forEach(function (r) { (r.w.bundles || []).forEach(function (b) { if (b !== "cable" && !owned.has(b) && !shown[b]) bundleIds[b] = 1; }); });
    Object.keys(bundleIds).forEach(function (b) { appRow(b); });
    if (!curOpts.length) box.appendChild(el("div", "opt unavail", "No confirmed US listing yet"));
    // listen
    var lb = $("#listenBox"); lb.innerHTML = "";
    if ((g.listen || []).length) {
      // Radio is secondary to watch (per Saint): one compact line, team flagships only.
      var team = g.listen.filter(function (l) { return l.kind === "team" || l.kind === "game"; });
      var parts = team.slice(0, 2).map(function (l) { return l.name; });
      lb.innerHTML = "📻 <b>Listen:</b> ";
      lb.appendChild(document.createTextNode(parts.join("  ·  ") || "radio available"));
    }
    state.oi = 0; $("#overlay").hidden = false; paintOpts();
  }
  function paintOpts() {
    curOpts.forEach(function (o, i) { o.node.classList.toggle("focus", i === state.oi); });
  }
  function overlayKey(k, e) {
    if (k === 40) { state.oi = Math.min(curOpts.length - 1, state.oi + 1); paintOpts(); }
    else if (k === 38) { state.oi = Math.max(0, state.oi - 1); paintOpts(); }
    else if (k === 13) {
      var o = curOpts[state.oi];
      if (!o) { $("#overlay").hidden = true; updateFocus(); return; } // nothing to open -> OK closes
      if (o.sid === "antenna") { toast("Free over the air — tune this channel with an antenna"); }
      else if (o.getapp && IS_ANDROID) { try { window.AndroidTV.getApp(o.sid, svcName(o.sid)); } catch (e) {} }
      else if (o.sid) { launchService(o.sid, o.deep); }
    }
    else if (k === 10009 || k === 461 || k === 8 || k === 27) { $("#overlay").hidden = true; updateFocus(); e && e.preventDefault(); }
  }

  var toastT;
  function toast(msg) { var t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, 3200); }
  function tickClock() { var c = $("#clock"); function u() { c.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); } u(); setInterval(u, 20000); }

  // "Live · updated X min ago" so it reads as live, not a static template.
  function liveIndicator() {
    var el2 = $("#live"); if (!el2) return;
    var anyLive = (state.data && state.data.games || []).some(function (g) { return liveNow(g); });
    var gen = state.data && state.data.generated ? new Date(state.data.generated) : null;
    var mins = gen ? Math.max(0, Math.round((Date.now() - gen.getTime()) / 60000)) : null;
    var ago = mins == null ? "" : (mins < 1 ? "just now" : (mins < 60 ? mins + " min ago" : Math.round(mins / 60) + "h ago"));
    el2.innerHTML = '<span class="dot ' + (anyLive ? "livedot" : "green") + '"></span>' + (anyLive ? "LIVE" : "Live") + " · updated " + ago;
  }

  // Auto-refresh the schedule so scores/times stay current (every 3 min; ~1 min if a game is live).
  function scheduleRefresh() {
    var live = (state.data && state.data.games || []).some(function (g) { return liveNow(g); });
    setTimeout(function () {
      load(DATA_URL).then(function (d) {
        if (d && d.games) { state.data = d; if (state.view !== "setup") render(); else liveIndicator(); }
      }).catch(function () {}).then(scheduleRefresh);
    }, live ? 60000 : 180000);
  }
  scheduleRefresh();

  // Live scores: poll only the live/soon leagues' ESPN scoreboards every 45s (shared live.js).
  function pollLive() {
    if (!state.data || !window.GFLive) return;
    try { GFLive.refreshLive(state.data.games, function () { if (state.view !== "setup") render(); else liveIndicator(); }); } catch (e) {}
  }
  setInterval(pollLive, 45000);
  setTimeout(pollLive, 3000);

  // Register the TV remote's Return key so Back works inside the app (no-op in a browser).
  if (IS_TV && tizen.tvinputdevice) { try { tizen.tvinputdevice.registerKey("Return"); } catch (e) {} }
})();
