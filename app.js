// GAME FINDER phone app. Pure vanilla JS, no build step. Reads data/games.json.
(function () {
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var el = function (t, c, x) { var e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
  // Public build (GitHub Pages) sets window.GF_PUBLIC and serves data/ beside index.html.
  var PUBLIC = !!window.GF_PUBLIC;
  var BASE = /\/app\//.test(location.pathname) ? "../" : "./";
  var DATA = BASE + "data/games.json";

  var store = {
    get services() { return load("gf_services", []); },
    set services(v) { save("gf_services", v); },
    get groups() { return load("gf_groups", []); },
    set groups(v) { save("gf_groups", v); },
    get leagues() { return load("gf_leagues", []); },
    set leagues(v) { save("gf_leagues", v); },
    get teams() { return load("gf_teams", []); },
    set teams(v) { save("gf_teams", v); },
    get fav() { return load("gf_fav", []); },
    set fav(v) { save("gf_fav", v); },
    get seen() { return load("gf_seen", false); },
    set seen(v) { save("gf_seen", v); },
    get bets() { return load("gf_bets", []); },
    set bets(v) { save("gf_bets", v); },
    get ageOk() { return load("gf_age_ok", false); },
    set ageOk(v) { save("gf_age_ok", v); }
  };
  function load(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  var state = { view: "foryou", group: "All", mine: false, q: "", data: null, open: {}, titles: [], focus: null };
  var SVC = [];


  fetch(DATA, { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (d) {
    state.data = d; SVC = d.services || [];
    buildSettings(); buildGroups(); render();
    // First run: offer Setup, but never steal focus while the user is already typing a search.
    if (!store.seen) {
      store.seen = true; $("#welcome").hidden = false;
      if (!state.q && document.activeElement !== $("#q")) openSettings();
    }
  }).catch(function (e) {
    $("#list").innerHTML = '<div class="empty">Could not load schedule data.<br>Run <code>python refresh.py</code> then reload.</div>';
  });


  // ---- header controls
  $("#views").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return;
    state.view = b.dataset.v; syncSeg(); render();
  });
  function syncSeg() { [].forEach.call($("#views").children, function (b) { b.classList.toggle("on", b.dataset.v === state.view); }); }
  $("#q").addEventListener("input", function (e) { state.q = e.target.value.trim().toLowerCase(); render(); });
  $("#mineBtn").addEventListener("click", function () {
    state.mine = !state.mine; this.setAttribute("aria-pressed", state.mine); this.classList.toggle("on", state.mine); render();
  });
  $("#setBtn").addEventListener("click", openSettings);
  $("#doneBtn").addEventListener("click", function () { store.seen = true; $("#settings").close(); render(); });

  function buildGroups() {
    var groups = ["All"]; var seen = {};
    (state.data.games || []).forEach(function (g) { if (!seen[g.group]) { seen[g.group] = 1; groups.push(g.group); } });
    var box = $("#groups"); box.innerHTML = "";
    groups.forEach(function (gr) {
      var c = el("button", "chip" + (gr === state.group ? " on" : ""), gr);
      c.onclick = function () { state.group = gr; buildGroups(); render(); };
      box.appendChild(c);
    });
  }

  // ---- time helpers (local to the device)
  // ---- time zone layer ----
  // All times render in the user's chosen city's zone (or their device zone if "use my location"
  // is on / no city set). Dates are compared IN THAT ZONE, never UTC — that's the root-cause fix.
  function deviceTz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return "America/Los_Angeles"; } }
  function activeTz() { if (load("gf_use_location", false)) return deviceTz(); var c = load("gf_city", null); return (c && c.tz) || deviceTz(); }
  function ymdInTz(d, tz) { try { return d.toLocaleDateString("en-CA", { timeZone: tz }); } catch (e) { return d.toISOString().slice(0, 10); } }
  function tzShort(tz) { try { return new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date()).find(function (p) { return p.type === "timeZoneName"; }).value; } catch (e) { return ""; } }

  // Curated cities for search; plus the full IANA list from the browser as a fallback.
  var CITIES = [
    ["Los Angeles", "America/Los_Angeles"], ["San Francisco", "America/Los_Angeles"], ["San Diego", "America/Los_Angeles"],
    ["Seattle", "America/Los_Angeles"], ["Las Vegas", "America/Los_Angeles"], ["Portland", "America/Los_Angeles"],
    ["Denver", "America/Denver"], ["Phoenix", "America/Phoenix"], ["Salt Lake City", "America/Denver"],
    ["Chicago", "America/Chicago"], ["Dallas", "America/Chicago"], ["Houston", "America/Chicago"], ["Minneapolis", "America/Chicago"],
    ["Kansas City", "America/Chicago"], ["New Orleans", "America/Chicago"], ["Nashville", "America/Chicago"], ["St. Louis", "America/Chicago"],
    ["New York", "America/New_York"], ["Boston", "America/New_York"], ["Philadelphia", "America/New_York"], ["Washington DC", "America/New_York"],
    ["Miami", "America/New_York"], ["Atlanta", "America/New_York"], ["Detroit", "America/New_York"], ["Cleveland", "America/New_York"],
    ["Pittsburgh", "America/New_York"], ["Tampa", "America/New_York"], ["Charlotte", "America/New_York"], ["Orlando", "America/New_York"],
    ["Honolulu", "Pacific/Honolulu"], ["Anchorage", "America/Anchorage"],
    ["Toronto", "America/Toronto"], ["Montreal", "America/Toronto"], ["Vancouver", "America/Vancouver"], ["Mexico City", "America/Mexico_City"],
    ["London", "Europe/London"], ["Dublin", "Europe/Dublin"], ["Paris", "Europe/Paris"], ["Madrid", "Europe/Madrid"], ["Barcelona", "Europe/Madrid"],
    ["Lisbon", "Europe/Lisbon"], ["Rome", "Europe/Rome"], ["Milan", "Europe/Rome"], ["Berlin", "Europe/Berlin"], ["Munich", "Europe/Berlin"],
    ["Amsterdam", "Europe/Amsterdam"], ["Brussels", "Europe/Brussels"], ["Zurich", "Europe/Zurich"], ["Vienna", "Europe/Vienna"],
    ["Athens", "Europe/Athens"], ["Istanbul", "Europe/Istanbul"], ["Moscow", "Europe/Moscow"], ["Dubai", "Asia/Dubai"],
    ["Riyadh", "Asia/Riyadh"], ["Mumbai", "Asia/Kolkata"], ["Bangkok", "Asia/Bangkok"], ["Singapore", "Asia/Singapore"],
    ["Hong Kong", "Asia/Hong_Kong"], ["Shanghai", "Asia/Shanghai"], ["Tokyo", "Asia/Tokyo"], ["Seoul", "Asia/Seoul"],
    ["Sydney", "Australia/Sydney"], ["Melbourne", "Australia/Melbourne"], ["Auckland", "Pacific/Auckland"],
    ["São Paulo", "America/Sao_Paulo"], ["Buenos Aires", "America/Argentina/Buenos_Aires"], ["Bogotá", "America/Bogota"], ["Lima", "America/Lima"],
    ["Johannesburg", "Africa/Johannesburg"], ["Cairo", "Africa/Cairo"], ["Lagos", "Africa/Lagos"]
  ];

  function parse(s) { return s ? new Date(s) : null; }
  function fmtTime(d) { var tz = activeTz(); try { return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: tz }) + " " + tzShort(tz); } catch (e) { return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); } }
  function fmtTimeG(g) { return g.time_tbd ? "Time TBD" : fmtTime(new Date(g.start)); }
  function dayKeyG(g) { return ymdInTz(new Date(g.start), activeTz()); }
  function dayKeyNow() { return ymdInTz(new Date(), activeTz()); }
  function fmtDayG(g) {
    var tz = activeTz(), gd = ymdInTz(new Date(g.start), tz), nd = ymdInTz(new Date(), tz);
    var diff = Math.round((Date.parse(gd + "T00:00:00Z") - Date.parse(nd + "T00:00:00Z")) / 864e5);
    if (diff === 0) return "Today"; if (diff === 1) return "Tomorrow"; if (diff === -1) return "Yesterday";
    try { return new Date(g.start).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric", timeZone: tz }); }
    catch (e) { return new Date(g.start).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }); }
  }
  // Sort: live first, then upcoming (soonest first), then finished (most recent first) at the bottom.
  function orderRank(g) { return g.status === "in" ? 0 : (g.status === "post" ? 2 : 1); }
  function gameOrder(a, b) {
    var ra = orderRank(a), rb = orderRank(b); if (ra !== rb) return ra - rb;
    var sa = a.start || "", sb = b.start || "";
    if (ra === 2) return sa < sb ? 1 : (sa > sb ? -1 : 0);   // past: recent first
    return sa < sb ? -1 : (sa > sb ? 1 : 0);                 // live/upcoming: soonest first
  }
  function inView(g) {
    var s = parse(g.start); if (!s) return state.view === "week";
    var now = new Date();
    if (g.status === "in") return true; // live always shows in time views
    if (state.view === "live") return g.status === "in";
    if (state.view === "today") return dayKeyG(g) === dayKeyNow() || (g.multiday && g.status !== "post");
    if (state.view === "week") return true;
    if (state.view === "weekend") {
      var d = s.getDay(); // Fri(5) Sat(6) Sun(0), within the next 7 days
      var ahead = (s - now) / 864e5;
      return (d === 5 || d === 6 || d === 0) && ahead > -1 && ahead < 7.5;
    }
    return true;
  }

  // Team ids repeat across sports, so a followed team is keyed "league:id".
  function teamKey(league, id) { return league + ":" + id; }
  function mineMatch(g) {
    if (store.groups.indexOf(g.group) >= 0) return true;
    if (store.leagues.indexOf(g.league) >= 0) return true;
    var tids = store.teams;
    if (g.home && tids.indexOf(teamKey(g.league, g.home.id)) >= 0) return true;
    if (g.away && tids.indexOf(teamKey(g.league, g.away.id)) >= 0) return true;
    return false;
  }
  function qMatch(g) {
    if (!state.q) return true;
    var hay = [g.name, g.short, g.league_name, g.home && g.home.name, g.away && g.away.name]
      .concat((g.watch || []).map(function (w) { return w.name; }))
      .join(" ").toLowerCase();
    return hay.indexOf(state.q) >= 0;
  }

  function titleMatch(t) {
    if (!state.q) return true;
    return (t.title + " " + (t.aka || "") + " " + (t.cast || "")).toLowerCase().indexOf(state.q) >= 0;
  }

  // ---- favorites (pinned teams / leagues / sports) ----
  function favList() {
    var tmap = allTeams(), out = [];
    store.groups.forEach(function (g) { out.push({ kind: "group", id: g, name: g }); });
    store.leagues.forEach(function (l) { var nm = l; (state.data.games || []).some(function (g) { if (g.league === l) { nm = g.league_name; return true; } }); out.push({ kind: "league", id: l, name: nm }); });
    store.teams.forEach(function (t) { out.push({ kind: "team", id: t, name: (tmap[t] && tmap[t].name) || t }); });
    return out;
  }
  function favGames(f) {
    return (state.data.games || []).filter(function (g) {
      if (f.kind === "group") return g.group === f.id;
      if (f.kind === "league") return g.league === f.id;
      return (g.home && teamKey(g.league, g.home.id) === f.id) || (g.away && teamKey(g.league, g.away.id) === f.id);
    }).filter(function (g) { return g.status !== "post" || g.status === "in"; })
      .sort(gameOrder);
  }
  function buildFavbar() {
    var bar = $("#favbar"); if (!bar) return; bar.innerHTML = "";
    if (state.view !== "foryou" && !state.focus) return;
    favList().forEach(function (f) {
      var c = el("div", "fav" + (state.focus && state.focus.id === f.id ? " on" : ""));
      c.innerHTML = '<span class="fx">★</span>';
      c.appendChild(document.createTextNode(f.name));
      c.onclick = function () { state.focus = f; render(); };
      bar.appendChild(c);
    });
    if (!favList().length) { var a = el("div", "fav addfav", "☆ Pin your teams in Setup"); a.onclick = openSettings; bar.appendChild(a); }
  }

  var BIG = { nfl: 1, nba: 1, mlb: 1, nhl: 1, cfb: 1, epl: 1, ucl: 1, uel: 1, laliga: 1, seriea: 1, ufc: 1, mls: 1, wnba: 1 };

  function render() {
    var box = $("#list"); box.innerHTML = "";
    var owned = new Set(store.services);
    $("#groups").style.display = (state.view === "foryou" || state.focus) ? "none" : "";
    buildFavbar();

    // A pinned favorite's page: its upcoming games (soonest first) with watch + radio.
    if (state.focus) {
      var bb = el("div", "backbar");
      var back = el("button", null, "← For You"); back.onclick = function () { state.focus = null; render(); };
      bb.appendChild(back); bb.appendChild(el("span", "ttl", state.focus.name));
      box.appendChild(bb);
      var fg = favGames(state.focus);
      if (!fg.length) box.appendChild(el("div", "empty", "No upcoming games for " + state.focus.name + " this week."));
      else { var cd = null; fg.forEach(function (g) { var s = parse(g.start); var dk = g.status === "in" ? "LIVE" : (g.start ? fmtDayG(g) : ""); if (dk !== cd) { cd = dk; box.appendChild(el("div", "day", dk)); } box.appendChild(card(g, owned)); }); }
      setFoot(); return;
    }

    // Search works from ANY tab: a non-empty query shows matching games across all days.
    if (state.q) { renderSearch(owned); return; }
    tzBanner();
    if (state.view === "bets") { renderBets(owned); return; }
    if (state.view === "foryou") { renderForYou(owned); return; }

    var games = (state.data.games || []).filter(function (g) {
      if (state.group !== "All" && g.group !== state.group) return false;
      if (state.mine && !mineMatch(g)) return false;
      if (!qMatch(g)) return false;
      return inView(g);
    });
    games.sort(function (a, b) {
      var la = a.status === "in" ? 0 : 1, lb = b.status === "in" ? 0 : 1;
      return (la - lb) || ((a.start || "") < (b.start || "") ? -1 : 1);
    });
    if (!games.length) {
      if (!(state.q && titles.length))  // if titles already shown for the search, don't nag
        box.appendChild(el("div", "empty", state.mine ? "Nothing for your teams in this view. Tap Setup to follow more, or turn off My stuff." : "No games in this view."));
      setFoot(); return;
    }
    var curDay = null;
    games.forEach(function (g) {
      var s = parse(g.start);
      var dk = g.status === "in" ? "LIVE" : (g.start ? fmtDayG(g) : "Scheduled");
      if (dk !== curDay) { curDay = dk; box.appendChild(el("div", "day", dk)); }
      box.appendChild(card(g, owned));
    });
    setFoot();
  }

  function renderSearch(owned) {
    var box = $("#list");
    var games = (state.data.games || []).filter(qMatch);
    games.sort(gameOrder);
    if (games.length) {
      box.appendChild(el("div", "day", "Games", ));
      var curDay = null;
      games.forEach(function (g) {
        var s = parse(g.start);
        var dk = g.status === "in" ? "LIVE" : (g.start ? fmtDayG(g) : "Scheduled");
        if (dk !== curDay) { curDay = dk; box.appendChild(el("div", "day", dk)); }
        box.appendChild(card(g, owned));
      });
    }
    if (!games.length) box.appendChild(el("div", "empty", "Nothing matches “" + state.q + "”."));
    setFoot();
  }

  // Compact horizontal ticker of live games (your teams; or all live if you follow none).
  function renderLiveStrip(myLive) {
    var box = $("#list");
    var all = (state.data.games || []).filter(function (g) { return g.status === "in"; });
    var strip = (myLive && myLive.length) ? myLive : all;
    if (!strip.length) return;
    var wrap = el("div", "livestrip");
    strip.slice(0, 12).forEach(function (g) {
      var c = el("button", "livecard");
      c.appendChild(el("span", "lc-lg", g.league_name));
      var sc = g.score ? ((g.away && g.away.abbr || "") + " " + g.score.away + " · " + g.score.home + " " + (g.home && g.home.abbr || "")) :
        ((g.away && g.away.abbr || "?") + " · " + (g.home && g.home.abbr || "?"));
      c.appendChild(el("span", "lc-score", sc));
      c.appendChild(el("span", "lc-state", GFLive.liveLine(g)));
      c.onclick = function () { state.q = (g.home && g.home.name) || (g.away && g.away.name) || ""; $("#q").value = state.q; render(); };
      wrap.appendChild(c);
    });
    box.appendChild(el("div", "day", "🔴 Live now"));
    box.appendChild(wrap);
  }

  function renderForYou(owned) {
    var box = $("#list");
    var now = new Date();
    var mine = (state.data.games || []).filter(mineMatch).filter(function (g) { return g.status !== "post"; });
    mine.sort(gameOrder);

    function section(title, sub, games) {
      if (!games.length) return;
      var h = el("div", "day", title); if (sub) h.appendChild(el("span", "sub", sub)); box.appendChild(h);
      games.forEach(function (g) { box.appendChild(card(g, owned)); });
    }

    var live = mine.filter(function (g) { return g.status === "in"; });
    renderLiveStrip(live);
    var today = mine.filter(function (g) { var s = parse(g.start); return g.status !== "in" && s && dayKeyG(g) === dayKeyNow(); });
    var week = mine.filter(function (g) { var s = parse(g.start); return g.status !== "in" && s && dayKeyG(g) !== dayKeyNow(); });

    if (!favList().length) {
      box.appendChild(el("div", "foryou-empty", "Pin your teams, leagues and sports to build your home. Tap “Setup”, or star anything in the app. (Try the Dodgers, Rams, Kings, soccer, UFC…)"));
    }
    if (mine.length) {
      section("Up next today", null, today.slice(0, 8));
      section("This week for your teams", null, week.slice(0, 12));
    } else if (favList().length) {
      box.appendChild(el("div", "foryou-empty", "Nothing from your teams tonight. Here’s what’s big:"));
    }
    // Always offer "what's big" when the user has little of their own on.
    if (live.length + today.length < 3) {
      var big = (state.data.games || []).filter(function (g) { return BIG[g.league] && g.status !== "post" && !mineMatch(g); });
      big.sort(gameOrder);
      section("Big games", "popular right now", big.slice(0, 8));
    }
    if (!box.children.length) box.appendChild(el("div", "empty", "No games to show right now."));
    setFoot();
  }

  // ============================ MY BETS (organizer only) ============================
  // GAME FINDER never places, changes or settles a bet. It shows the user's OWN bets next to
  // the game and links OUT to the book/market. Plain links, no affiliate tags. Read-only.
  function gameById(id) { return (state.data.games || []).filter(function (g) { return g.id === id; })[0]; }
  function betsForGame(id) { return store.bets.filter(function (b) { return b.gameId === id; }); }

  function renderBets(owned) {
    var box = $("#list");
    if (!store.ageOk) { box.appendChild(ageGate()); setFoot(); return; }
    var head = el("div", "day", "My Bets"); head.appendChild(el("span", "sub", "your bets, next to the game — we never place or handle bets")); box.appendChild(head);

    var actions = el("div", "betactions");
    var add = el("button", "betbtn", "+ Add a bet"); add.onclick = addBetSheet; actions.appendChild(add);
    var conn = el("button", "betbtn ghost", "Connect Kalshi / Polymarket"); conn.onclick = connectSheet; actions.appendChild(conn);
    box.appendChild(actions);

    var bets = store.bets;
    if (!bets.length) { box.appendChild(el("div", "foryou-empty", "No bets yet. Add one, or connect Kalshi (read-only) or a Polymarket wallet. Sportsbook bets (DraftKings, FanDuel…) have no public feed — add those by hand or via the share sheet.")); setFoot(); return; }
    var open = bets.filter(function (b) { return b.status !== "settled"; }), done = bets.filter(function (b) { return b.status === "settled"; });
    if (open.length) { box.appendChild(el("div", "day", "Open")); open.forEach(function (b) { box.appendChild(betCard(b, owned)); }); }
    if (done.length) { box.appendChild(el("div", "day", "Settled")); done.forEach(function (b) { box.appendChild(betCard(b, owned)); }); }
    setFoot();
  }

  function betCard(b, owned) {
    var c = el("div", "card bet-card");
    var g = b.gameId && gameById(b.gameId);
    var top = el("div", "bet-top");
    top.appendChild(el("span", "bet-book", b.book || b.source || "Bet"));
    if (b.source === "kalshi" || b.source === "polymarket") top.appendChild(el("span", "bet-src", b.source + " · read-only"));
    c.appendChild(top);

    c.appendChild(el("div", "bet-market", b.market || b.title || "Your bet"));
    var pos = el("div", "bet-pos");
    var pick = (b.pick ? b.pick + " " : "") + (b.entry ? "@ " + b.entry : "");
    pos.appendChild(el("span", "bet-pick", pick || "position"));
    if (b.current) { var up = priceNum2(b.current) >= priceNum2(b.entry); pos.appendChild(el("span", "bet-now " + (up ? "up" : "down"), "now " + b.current)); }
    c.appendChild(pos);

    if (g) {
      var gl = el("button", "bet-game");
      var title = (g.away && (g.away.short || g.away.name)) + " @ " + (g.home && (g.home.short || g.home.name));
      var score = g.score ? (" · " + (g.status_detail || "") + " " + g.score.away + "–" + g.score.home) : (g.status === "in" ? " · " + (g.status_detail || "LIVE") : "");
      gl.appendChild(el("div", "bg1", title + score));
      var why = GFRank.whyLine(g, owned, SVC);
      gl.appendChild(el("div", "bg2 c-" + why.color, "Watch: " + why.text.replace(/^On /, "")));
      gl.onclick = function () { state.view = "foryou"; state.focus = null; state.q = (g.home && g.home.name) || ""; $("#q").value = state.q; syncSeg(); render(); };
      c.appendChild(gl);
    } else if (b.gameText) {
      c.appendChild(el("div", "bet-gametext", b.gameText));
    }

    var row = el("div", "bet-row");
    if (b.link) { var m = el("a", "betbtn sm"); m.href = b.link; m.target = "_blank"; m.rel = "noopener"; m.textContent = "Manage bet →"; row.appendChild(m); }
    var ed = el("button", "betbtn sm ghost", b.status === "settled" ? "Reopen" : "Mark settled");
    ed.onclick = function () { var a = store.bets; a.forEach(function (x) { if (x.id === b.id) x.status = x.status === "settled" ? "open" : "settled"; }); store.bets = a; render(); };
    row.appendChild(ed);
    var del = el("button", "betbtn sm ghost", "Remove"); del.onclick = function () { store.bets = store.bets.filter(function (x) { return x.id !== b.id; }); render(); };
    row.appendChild(del);
    c.appendChild(row);
    return c;
  }
  function priceNum2(p) { if (!p) return 0; var m = String(p).match(/([0-9]+(\.[0-9]+)?)/); return m ? parseFloat(m[1]) : 0; }

  function ageGate() {
    var w = el("div", "foryou-empty");
    w.appendChild(el("div", "age-h", "Bets — 18+ (21+ where required)"));
    w.appendChild(el("div", null, "My Bets only displays bets you already made and links out to the book. It never takes, places or settles a bet. You must be of legal age in your location to use it."));
    var row = el("div", "bet-row");
    var ok = el("button", "betbtn", "I'm of legal age"); ok.onclick = function () { store.ageOk = true; render(); };
    var no = el("button", "betbtn ghost", "Not now"); no.onclick = function () { state.view = "foryou"; syncSeg(); render(); };
    row.appendChild(ok); row.appendChild(no); w.appendChild(row);
    return w;
  }

  function sheet(titleText, buildBody) {
    var back = el("div", "opensheet-bg"); var box = el("div", "opensheet betsheet");
    box.appendChild(el("h3", null, titleText));
    buildBody(box, function () { document.body.removeChild(back); });
    var cancel = el("button", "opencancel", "Close"); cancel.onclick = function () { document.body.removeChild(back); };
    box.appendChild(cancel);
    back.appendChild(box); back.onclick = function (e) { if (e.target === back) document.body.removeChild(back); };
    document.body.appendChild(back);
  }

  function field(box, label, ph) {
    var l = el("label", "betfield"); l.appendChild(el("span", null, label));
    var i = el("input"); i.placeholder = ph || ""; l.appendChild(i); box.appendChild(l); return i;
  }

  function addBetSheet() {
    sheet("Add a bet", function (box, close) {
      var book = field(box, "Book / market", "DraftKings, Kalshi, FanDuel…");
      var market = field(box, "What's the bet", "Dodgers to win NLCS");
      var pick = field(box, "Your pick", "YES / Dodgers / Over 8.5");
      var entry = field(box, "Entry price / odds", "58¢ or -110");
      var link = field(box, "Manage link (optional)", "paste the book/market URL");
      // link to a game
      var gl = el("label", "betfield"); gl.appendChild(el("span", null, "Link to a game (optional)"));
      var gsel = el("input"); gsel.placeholder = "type a team…"; gl.appendChild(gsel); box.appendChild(gl);
      var res = el("div", "chips wrap"); box.appendChild(res);
      var chosen = { id: null, text: "" };
      gsel.oninput = function () {
        res.innerHTML = ""; var q = gsel.value.trim().toLowerCase(); if (q.length < 2) return;
        (state.data.games || []).filter(function (g) { return g.status !== "post" && ((g.home && (g.home.name || "").toLowerCase().indexOf(q) >= 0) || (g.away && (g.away.name || "").toLowerCase().indexOf(q) >= 0)); }).slice(0, 6).forEach(function (g) {
          var t = (g.away && g.away.short) + " @ " + (g.home && g.home.short) + " · " + g.league_name;
          var ch = el("button", "chip", t); ch.onclick = function () { chosen = { id: g.id, text: t }; [].forEach.call(res.children, function (x) { x.classList.remove("on"); }); ch.classList.add("on"); };
          res.appendChild(ch);
        });
      };
      var save = el("button", "betbtn", "Save bet");
      save.onclick = function () {
        if (!market.value && !book.value) { close(); return; }
        var a = store.bets; a.unshift({ id: "b" + Date.now(), source: "manual", book: book.value, market: market.value, pick: pick.value, entry: entry.value, link: link.value, gameId: chosen.id, gameText: chosen.id ? "" : "", status: "open" });
        store.bets = a; close(); render();
      };
      box.appendChild(save);
    });
  }

  function connectSheet() {
    sheet("Connect your bets (read-only)", function (box, close) {
      box.appendChild(el("div", "muted", "We only READ your positions and link out. We never place bets, and never ask for a password."));
      // Polymarket: public wallet, no credentials
      box.appendChild(el("h4", null, "Polymarket"));
      var w = field(box, "Wallet address", "0x… (public, no password)");
      var pbtn = el("button", "betbtn sm", "Import positions");
      pbtn.onclick = function () { importPolymarket(w.value.trim(), close); };
      box.appendChild(pbtn);
      // Kalshi: user's own read-only API key, stored on device only
      box.appendChild(el("h4", null, "Kalshi"));
      box.appendChild(el("div", "muted", "Paste your own read-only API key (Settings → API on Kalshi). It stays on this device; we never see your password."));
      var k = field(box, "Kalshi API key id", "");
      var kbtn = el("button", "betbtn sm", "Save key");
      kbtn.onclick = function () { save("gf_kalshi_key", k.value.trim()); close(); alert("Saved on this device. Live position import needs the companion fetcher (see README) — your key is never sent anywhere else."); };
      box.appendChild(kbtn);
    });
  }

  function importPolymarket(addr, close) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) { alert("Enter a valid 0x wallet address."); return; }
    fetch("https://data-api.polymarket.com/positions?user=" + addr + "&sizeThreshold=1", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (list) {
        if (!Array.isArray(list) || !list.length) { alert("No open positions found for that wallet (or the public API didn't return any)."); return; }
        var a = store.bets, n = 0;
        list.slice(0, 50).forEach(function (p) {
          var id = "pm:" + (p.conditionId || p.asset || Math.random());
          if (a.some(function (x) { return x.id === id; })) return;
          a.push({ id: id, source: "polymarket", book: "Polymarket", market: p.title || p.outcome || "Position",
            pick: p.outcome, entry: p.avgPrice != null ? (Math.round(p.avgPrice * 100) + "¢") : "", current: p.curPrice != null ? (Math.round(p.curPrice * 100) + "¢") : "",
            link: p.slug ? ("https://polymarket.com/event/" + p.slug) : "https://polymarket.com/", gameId: null, status: "open" });
          n++;
        });
        store.bets = a; close(); render();
        alert("Imported " + n + " Polymarket position(s).");
      })
      .catch(function () { alert("Couldn't reach Polymarket's public API from here (it may be blocked by the browser). You can still add these by hand."); });
  }

  function setFoot() {
    var d = state.data, when = d.generated ? new Date(d.generated).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
    var ver = window.GF_VERSION || "dev";
    $("#foot").innerHTML = "Data checked " + when + " · no ads, no tracking · " + (PUBLIC ? '<a href="./privacy.html" style="color:inherit">Privacy</a>' : "on-device only") + ' · <span style="opacity:.6">' + ver + "</span>";
  }

  function teamBadge(t) {
    // Public/app-store build: colored abbreviation badge instead of a hotlinked logo image.
    var ab = (t && (t.abbr || t.short || t.name || "")).slice(0, 4).toUpperCase();
    var b = el("span", "badge", ab);
    var col = (t && t.color) || "#2a313c";
    b.style.background = col; b.style.color = contrastInk(col);
    return b;
  }
  function contrastInk(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || ""); if (!m) return "#fff";
    var n = parseInt(m[1], 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? "#111" : "#fff";
  }
  function teamRow(t, league) {
    var r = el("div", "t");
    if (PUBLIC) { r.appendChild(teamBadge(t)); }
    else if (t && t.logo) { var i = el("img"); i.src = t.logo; i.alt = ""; i.loading = "lazy"; r.appendChild(i); }
    r.appendChild(el("span", "n", (t && (t.name || t.short)) || "TBD"));
    if (t && t.id && league) {
      var key = teamKey(league, t.id);
      var pinned = store.teams.indexOf(key) >= 0;
      var st = el("button", "star team" + (pinned ? " on" : ""), pinned ? "★" : "☆");
      st.title = pinned ? "Unpin" : "Pin this team";
      st.onclick = function (e) {
        e.stopPropagation();
        var a = store.teams, i = a.indexOf(key);
        if (i >= 0) a.splice(i, 1); else a.push(key);
        store.teams = a; this.classList.toggle("on");
        this.textContent = this.classList.contains("on") ? "★" : "☆";
        buildFavbar(); buildFollowedTeams();
      };
      r.appendChild(st);
    }
    return r;
  }

  function card(g, owned) {
    var c = el("div", "card");
    var meta = el("div", "meta");
    var s = parse(g.start);
    var time = el("span", null, g.status === "in" ? "" : (g.start ? fmtTimeG(g) : ""));
    if (g.status === "in") {
      meta.appendChild(el("span", "livepill", "LIVE"));           // pulsing pill (CSS)
      meta.appendChild(el("span", "livestate", GFLive.liveLine(g)));
    }
    else if (g.status === "post") meta.appendChild(el("span", "finalpill", g.status_detail || "Final"));
    else meta.appendChild(time);
    meta.appendChild(el("span", "lg", g.league_name));
    if (g.stale) meta.appendChild(el("span", "conf", "cached"));
    var star = el("button", "star" + (store.fav.indexOf(g.id) >= 0 ? " on" : ""), store.fav.indexOf(g.id) >= 0 ? "★" : "☆");
    star.onclick = function () { var f = store.fav, i = f.indexOf(g.id); if (i >= 0) f.splice(i, 1); else f.push(g.id); store.fav = f; this.classList.toggle("on"); this.textContent = this.classList.contains("on") ? "★" : "☆"; };
    meta.appendChild(star);
    c.appendChild(meta);

    if (g.home || g.away) {
      var tw = el("div", "teams");
      [g.away, g.home].forEach(function (t, i) {
        var row = teamRow(t, g.league);
        if (g.score) { row.appendChild(el("span", "s", i === 0 ? g.score.away : g.score.home)); }
        tw.appendChild(row);
      });
      c.appendChild(tw);
    } else {
      c.appendChild(el("div", "title", g.name || g.short));
    }
    if (g.note && (g.home || g.away)) c.appendChild(el("div", "muted", g.note));

    // WHERE TO WATCH
    var ranked = GFRank.rankWatch(g.watch, owned);
    var why = GFRank.whyLine(g, owned, SVC);
    var w = el("div", "why c-" + why.color, why.text); c.appendChild(w);

    var opts = el("div", "opts");
    var dividerPut = false;
    ranked.forEach(function (r) {
      // one divider before the first pay (orange) option
      if (r.cat === "pay" && !dividerPut && opts.children.length) { opts.appendChild(el("span", "optdiv", "pay / download")); dividerPut = true; }
      opts.appendChild(watchBtn(r));
    });
    // Fallback pay-TV bundles that carry these channels (YouTube TV, Fubo, Sling…), shown last.
    var bundleIds = {};
    ranked.forEach(function (r) { if (r.cat === "pay" && !r.tba) (r.w.bundles || []).forEach(function (b) { if (b !== "cable" && !owned.has(b)) bundleIds[b] = 1; }); });
    var bl = Object.keys(bundleIds);
    if (bl.length) {
      if (!dividerPut && opts.children.length) opts.appendChild(el("span", "optdiv", "pay / download"));
      opts.appendChild(el("span", "bundlelbl", "or a live-TV bundle:"));
      bl.forEach(function (b) {
        var web = svcWeb(b);
        var a = el(web ? "a" : "span", "opt bundle");
        if (web) { a.href = web; a.onclick = function (e) { e.preventDefault(); handleWatchTap(b, web); }; }
        a.textContent = svcName(b);
        opts.appendChild(a);
      });
    }
    if (ranked.length) c.appendChild(opts);

    // LISTEN (short line + expand) — show BOTH teams' flagships + a national feed, not just one side.
    if ((g.listen || []).length) {
      var team = g.listen.filter(function (l) { return l.kind === "team" || l.kind === "game"; });
      var nat = g.listen.filter(function (l) { return l.kind !== "team" && l.kind !== "game"; });
      var parts = [];
      var away = team.filter(function (l) { return l.side === "away"; })[0];
      var home = team.filter(function (l) { return l.side === "home"; })[0];
      var sideLabel = function (l, t) { return esc(l.name) + (t ? ' <span class="rteam">' + esc(t) + "</span>" : ""); };
      if (away || home) {
        if (away) parts.push(sideLabel(away, away.team));
        if (home) parts.push(sideLabel(home, home.team));
      } else { parts = team.slice(0, 2).map(function (l) { return esc(l.name); }); }
      // prefer a true national feed (ESPN Radio) over a satellite channel on the one-liner
      var national = nat.filter(function (l) { return l.kind === "national"; })[0] || nat.filter(function (l) { return l.kind === "satellite"; })[0];
      if (national) parts.push(esc(national.name));
      if (!parts.length && nat[0]) parts.push(esc(nat[0].name));
      var line = el("div", "listen");
      line.innerHTML = "📻 <b>Listen:</b> " + (parts.join("  ·  ") || "see options");
      c.appendChild(line);
    }

    // Your bets on this game (organizer link; only if the user has any)
    var mybets = betsForGame(g.id);
    if (mybets.length) {
      var bl = el("button", "yourbets", "💰 Your bet" + (mybets.length > 1 ? "s" : "") + " on this game (" + mybets.length + ")");
      bl.onclick = function () { state.view = "bets"; state.focus = null; syncSeg(); render(); };
      c.appendChild(bl);
    }

    var more = el("button", "more", "Details & sources");
    var det = null;
    more.onclick = function () {
      if (det) { det.remove(); det = null; more.textContent = "Details & sources"; return; }
      det = detail(g, ranked); c.appendChild(det); more.textContent = "Hide details";
    };
    c.appendChild(more);
    return c;
  }

  function svcName(id) { for (var i = 0; i < SVC.length; i++) if (SVC[i].id === id) return SVC[i].name; return id; }
  function svcWeb(id) { for (var i = 0; i < SVC.length; i++) if (SVC[i].id === id) return SVC[i].web; return ""; }

  // ---- Movies & TV title card ----
  function offerText(ro) {
    var o = ro.o, svc = svcName(o.service);
    if (ro.cat === "free") return svc + " · Free" + (o.needs_account ? " (free account)" : "");
    if (ro.cat === "have") return svc + " · Included (you have it)";
    if (o.offer === "flatrate") return svc + " · Subscription";
    return svc + " · " + (o.offer === "rent" ? "Rent" : "Buy") + (o.price ? " " + o.price : "");
  }
  function titleCard(t, owned) {
    var c = el("div", "card title-card");
    var head = el("div", "tc-head");
    if (t.poster) { var img = el("img", "poster"); img.src = t.poster; img.alt = ""; img.loading = "lazy"; head.appendChild(img); }
    var h = el("div", "tc-main");
    h.appendChild(el("div", "tc-title", t.title + (t.year ? " (" + t.year + ")" : "")));
    h.appendChild(el("div", "tc-sub", (t.type === "show" ? (t.seasons ? t.seasons + " seasons" : "TV series") : "Movie")));
    head.appendChild(h);
    c.appendChild(head);

    var ranked = GFRank.rankOffers(t, owned);
    if (!ranked.length) { c.appendChild(el("div", "why c-none", "No US availability found yet")); return c; }
    var top = ranked[0];
    var why = top.cat === "free" ? ("Free on " + svcName(top.o.service))
      : top.cat === "have" ? ("Included with your " + svcName(top.o.service))
      : ("Cheapest: " + offerText(top).replace(svcName(top.o.service) + " · ", svcName(top.o.service) + " "));
    c.appendChild(el("div", "why c-" + top.color, why));

    var opts = el("div", "opts"); var dividerPut = false;
    ranked.forEach(function (ro) {
      if (ro.cat === "pay" && !dividerPut && opts.children.length) { opts.appendChild(el("span", "optdiv", "pay / rent / buy")); dividerPut = true; }
      var b = el("button", "opt c-" + ro.color + (ro.o.confidence === "unverified" ? " unv" : ""));
      b.appendChild(document.createTextNode(svcName(ro.o.service)));
      var sub = ro.cat === "free" ? "Free" : ro.cat === "have" ? "included" : (ro.o.offer === "flatrate" ? "subscription" : ((ro.o.offer === "rent" ? "rent" : "buy") + (ro.o.price ? " " + ro.o.price : "")));
      b.appendChild(el("small", null, sub));
      b.onclick = function () { offerTap(t, ro, owned); };
      opts.appendChild(b);
    });
    c.appendChild(opts);

    var more = el("button", "more", "Details & sources"); var det = null;
    more.onclick = function () {
      if (det) { det.remove(); det = null; more.textContent = "Details & sources"; return; }
      det = titleDetail(t, ranked); c.appendChild(det); more.textContent = "Hide details";
    };
    c.appendChild(more);
    return c;
  }

  function titleDetail(t, ranked) {
    var d = el("div", "detail"); d.appendChild(el("h4", null, "Where to watch"));
    var ul = el("ul");
    ranked.forEach(function (ro) {
      var li = el("li");
      li.innerHTML = '<i class="dot ' + ro.color + '"></i> <b>' + esc(svcName(ro.o.service)) + "</b> · " + esc(offerText(ro).split(" · ").slice(1).join(" · ")) +
        (ro.o.seasons ? " · " + esc(GFRank.fmtSeasons(GFRank.seasonSet(ro.o.seasons, t.seasons))) : "") +
        ' <span class="conf ' + ro.o.confidence + '">' + ro.o.confidence + "</span>";
      if (ro.o.source) li.innerHTML += " · " + srcLink(ro.o.source);
      ul.appendChild(li);
    });
    d.appendChild(ul);
    return d;
  }

  function offerTap(t, ro, owned) {
    // Before leaving for a paid option, warn if the same seasons are on a service you have (or free).
    if (ro.cat === "pay") {
      var noWarn = load("gf_nowarn_title", {});
      var have = GFRank.alreadyHave(t, ro.o, owned);
      if (have && !noWarn[t.id]) { showHaveAlert(t, ro, have, owned); return; }
    }
    handleWatchTap(ro.o.service, svcWeb(ro.o.service) || "");
  }

  function showHaveAlert(t, ro, have, owned) {
    var back = el("div", "opensheet-bg"); var box = el("div", "opensheet");
    box.appendChild(el("h3", null, "Heads up"));
    var msg = t.title + " " + have.seasonsText + " is " + (have.free ? "free on " : "included with your ") + svcName(have.service) + ".";
    box.appendChild(el("div", "havemsg", msg));
    var watch = el("button", "openbtn"); watch.appendChild(el("div", "ob1", "Watch on " + svcName(have.service)));
    watch.appendChild(el("div", "ob2", have.free ? "Free" : "You already pay for this"));
    watch.onclick = function () { document.body.removeChild(back); handleWatchTap(have.service, svcWeb(have.service) || ""); };
    box.appendChild(watch);
    var cont = el("button", "openbtn"); cont.appendChild(el("div", "ob1", "Continue anyway"));
    cont.appendChild(el("div", "ob2", offerText(ro)));
    cont.onclick = function () { document.body.removeChild(back); handleWatchTap(ro.o.service, svcWeb(ro.o.service) || ""); };
    box.appendChild(cont);
    var rem = el("label", "rememberrow"); var chk = el("input"); chk.type = "checkbox";
    chk.onchange = function () { var m = load("gf_nowarn_title", {}); if (chk.checked) m[t.id] = 1; else delete m[t.id]; save("gf_nowarn_title", m); };
    rem.appendChild(chk); rem.appendChild(document.createTextNode(" Don't warn me for this title"));
    box.appendChild(rem);
    var cancel = el("button", "opencancel", "Cancel"); cancel.onclick = function () { document.body.removeChild(back); };
    box.appendChild(cancel);
    back.appendChild(box); back.onclick = function (e) { if (e.target === back) document.body.removeChild(back); };
    document.body.appendChild(back);
  }

  function watchBtn(r) {
    if (r.tba) { var t = el("span", "opt c-orange unv"); t.appendChild(document.createTextNode("Network TBA")); t.appendChild(el("small", null, "check listings")); return t; }
    var url = svcWeb(r.open) || (r.cat === "free" && r.w.free_evidence) || "";
    var a = el(url ? "a" : "span", "opt c-" + r.color + (r.w.confidence === "unverified" ? " unv" : ""));
    if (url) { a.href = url; a.onclick = function (e) { e.preventDefault(); handleWatchTap(r.open, url); }; }
    a.appendChild(document.createTextNode(r.w.name));
    var tag = r.cat === "free" ? r.freeNote : (r.open ? (r.viaBundle ? "via " : "") + svcName(r.open) : "");
    if (tag) a.appendChild(el("small", null, tag));
    return a;
  }

  // ---- "Open in app / browser" choice (phone) ----
  function svcObj(id) { for (var i = 0; i < SVC.length; i++) if (SVC[i].id === id) return SVC[i]; return null; }
  function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent); }
  function isAndroid() { return /android/i.test(navigator.userAgent); }
  function storeUrl(sv) {
    if (!sv) return "";
    if (isIOS()) return sv.ios_store || "";
    if (isAndroid()) return sv.play_pkg ? ("https://play.google.com/store/apps/details?id=" + sv.play_pkg)
      : ("https://play.google.com/store/search?q=" + encodeURIComponent(sv.name) + "&c=apps");
    return "";
  }
  function openInBrowser(web) { try { window.open(web, "_blank", "noopener"); } catch (e) { location.href = web; } }
  function openInApp(id, web) {
    var sv = svcObj(id), store = storeUrl(sv);
    if (!isIOS() && !isAndroid()) { openInBrowser(web); return; }   // desktop: just open the site
    // Universal link opens the app if installed; if we're still visible after 1.5s, go to the store.
    var opened = false, onhide = function () { opened = true; };
    document.addEventListener("visibilitychange", onhide);
    try { window.location.href = web; } catch (e) {}
    setTimeout(function () {
      document.removeEventListener("visibilitychange", onhide);
      if (!opened && document.visibilityState === "visible" && store) window.location.href = store;
    }, 1500);
  }
  function doOpen(choice, id, web) { if (choice === "browser") openInBrowser(web); else openInApp(id, web); }

  function handleWatchTap(id, web) {
    var perSvc = load("gf_open_svc", {}), global = load("gf_open_default", "ask");
    var pref = (id && perSvc[id]) || global;
    if (pref === "app" || pref === "browser") { doOpen(pref, id, web); return; }
    openSheet(id, web);
  }

  function openSheet(id, web) {
    var sv = svcObj(id), name = sv ? sv.name : "this service";
    var back = el("div", "opensheet-bg");
    var box = el("div", "opensheet");
    box.appendChild(el("h3", null, "Open " + name));
    var mk = function (label, sub, choice) {
      var b = el("button", "openbtn"); b.appendChild(el("div", "ob1", label)); if (sub) b.appendChild(el("div", "ob2", sub));
      b.onclick = function () {
        if ($("#rememberChk").checked) {
          if (id) { var m = load("gf_open_svc", {}); m[id] = choice; save("gf_open_svc", m); }
          else save("gf_open_default", choice);
        }
        document.body.removeChild(back); doOpen(choice, id, web);
      };
      return b;
    };
    box.appendChild(mk("Open in app", "Launches the app · not installed? → app store", "app"));
    box.appendChild(mk("Open in browser", "Opens " + (sv && sv.web ? new URL(sv.web).hostname.replace(/^www\./, "") : "the website"), "browser"));
    var rem = el("label", "rememberrow");
    var chk = el("input"); chk.type = "checkbox"; chk.id = "rememberChk";
    rem.appendChild(chk); rem.appendChild(document.createTextNode(" Remember my choice"));
    box.appendChild(rem);
    var cancel = el("button", "opencancel", "Cancel"); cancel.onclick = function () { document.body.removeChild(back); };
    box.appendChild(cancel);
    back.appendChild(box);
    back.onclick = function (e) { if (e.target === back) document.body.removeChild(back); };
    document.body.appendChild(back);
  }

  function detail(g, ranked) {
    var d = el("div", "detail");
    d.appendChild(el("h4", null, "Where to watch"));
    var ul = el("ul");
    ranked.forEach(function (r) {
      var li = el("li");
      var tail = r.cat === "free" ? (" · " + esc(r.freeNote)) : (r.open ? " → " + esc(svcName(r.open)) + (r.viaBundle ? " (bundle)" : "") : "");
      li.innerHTML = '<i class="dot ' + r.color + '"></i> <b>' + esc(r.w.name) + "</b>" + tail +
        (r.w.lang === "es" ? " · Spanish" : "") +
        ' <span class="conf ' + r.w.confidence + '">' + r.w.confidence + "</span>";
      if (r.cat === "free" && r.w.free_evidence) li.innerHTML += ' · free: ' + srcLink(r.w.free_evidence);
      if (r.w.source) li.innerHTML += ' · ' + srcLink(r.w.source);
      ul.appendChild(li);
    });
    if (!ranked.length) ul.appendChild(el("li", "muted", "No confirmed US TV/stream listing yet."));
    d.appendChild(ul);

    if ((g.listen || []).length) {
      d.appendChild(el("h4", null, "Where to listen"));
      var lu = el("ul");
      g.listen.forEach(function (l) {
        var li = el("li");
        var label = l.name + (l.team ? " (" + l.team + ")" : "") + (l.app ? " · " + l.app : "") + (l.lang === "es" ? " · Spanish" : "");
        li.innerHTML = l.link ? '<a href="' + esc(l.link) + '" target="_blank" rel="noopener">' + esc(label) + "</a>" : esc(label);
        li.innerHTML += ' <span class="conf ' + l.confidence + '">' + l.confidence + "</span>";
        if (l.source) li.innerHTML += " · " + srcLink(l.source);
        if (l.note) li.appendChild(el("div", "muted", l.note));
        lu.appendChild(li);
      });
      d.appendChild(lu);
    }
    if (g.link) { var p = el("div"); p.style.marginTop = "8px"; p.innerHTML = '<a href="' + esc(g.link) + '" target="_blank" rel="noopener">Game page ↗</a>'; d.appendChild(p); }
    return d;
  }

  function srcLink(s) {
    if (/^https?:/.test(s)) { try { var h = new URL(s).hostname.replace(/^www\./, ""); return '<a href="' + esc(s) + '" target="_blank" rel="noopener">' + esc(h) + "</a>"; } catch (e) {} }
    return '<span class="muted">' + esc(s) + "</span>";
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (m) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[m]; }); }

  // ---- settings
  function openSettings() { var dlg = $("#settings"); if (!dlg.open) dlg.showModal(); }
  function buildSettings() {
    var box = $("#svcList"); box.innerHTML = "";
    SVC.forEach(function (sv) {
      var lab = el("label");
      var cb = el("input"); cb.type = "checkbox"; cb.checked = store.services.indexOf(sv.id) >= 0;
      cb.onchange = function () { var a = store.services, i = a.indexOf(sv.id); if (cb.checked && i < 0) a.push(sv.id); if (!cb.checked && i >= 0) a.splice(i, 1); store.services = a; render(); };
      lab.appendChild(cb); lab.appendChild(document.createTextNode(" " + sv.name));
      box.appendChild(lab);
    });
    buildTzSettings();
    buildOpenPrefs();
    // follow sports / leagues
    var groups = {}, leagues = {};
    (state.data.games || []).forEach(function (g) { groups[g.group] = 1; leagues[g.league] = g.league_name; });
    chipPicker($("#followGroups"), Object.keys(groups).sort(), function (x) { return x; }, "groups");
    chipPicker($("#followLeagues"), Object.keys(leagues).sort(function (a, b) { return leagues[a] < leagues[b] ? -1 : 1; }), function (x) { return leagues[x]; }, "leagues");
    buildFollowedTeams();
    $("#teamQ").addEventListener("input", teamSearch);
  }
  function cityLabel(c) { return c.name + " · " + tzShort(c.tz); }
  function buildTzSettings() {
    var cur = $("#tzCurrent"); if (!cur) return;
    var useL = load("gf_use_location", false), city = load("gf_city", null);
    var tz = activeTz();
    cur.innerHTML = useL ? ("Using your device's time zone: <b>" + tz + " (" + tzShort(tz) + ")</b>")
      : (city ? ("Showing times in <b>" + esc(city.name) + " (" + tzShort(city.tz) + ")</b>") : ("Showing times in your device zone <b>" + tz + " (" + tzShort(tz) + ")</b> — pick a city to lock it."));
    $("#useLoc").checked = useL;
    $("#useLoc").onchange = function () { save("gf_use_location", this.checked); buildTzSettings(); tzBanner(); render(); };
    $("#cityQ").oninput = function () {
      var q = this.value.trim().toLowerCase(), box = $("#cityResults"); box.innerHTML = "";
      if (q.length < 2) return;
      var list = CITIES.filter(function (c) { return c[0].toLowerCase().indexOf(q) >= 0; });
      try { (Intl.supportedValuesOf ? Intl.supportedValuesOf("timeZone") : []).forEach(function (z) { if (z.toLowerCase().indexOf(q) >= 0 && !list.some(function (c) { return c[1] === z; })) list.push([z.split("/").pop().replace(/_/g, " "), z]); }); } catch (e) {}
      list.slice(0, 12).forEach(function (c) {
        var ch = el("button", "chip", c[0] + " · " + tzShort(c[1]));
        ch.onclick = function () { save("gf_city", { name: c[0], tz: c[1] }); save("gf_use_location", false); $("#cityQ").value = ""; box.innerHTML = ""; buildTzSettings(); tzBanner(); render(); };
        box.appendChild(ch);
      });
    };
  }

  // Travel reminder: location off + device zone differs from the saved city's zone.
  function tzBanner() {
    var b = $("#tzbanner"); if (!b) return;
    var useL = load("gf_use_location", false), city = load("gf_city", null);
    if (useL || !city) { b.hidden = true; return; }
    var dev = deviceTz();
    if (!dev || dev === city.tz || tzShort(dev) === tzShort(city.tz)) { b.hidden = true; return; }
    var devCity = (CITIES.filter(function (c) { return c[1] === dev; })[0] || [dev.split("/").pop().replace(/_/g, " ")])[0];
    b.hidden = false; b.innerHTML = "";
    b.appendChild(el("span", "tzmsg", "Looks like you're in " + devCity + " time. Switch from " + city.name + "?"));
    var sw = el("button", "tzbtn", "Switch"); sw.onclick = function () { save("gf_city", { name: devCity, tz: dev }); buildTzSettings(); tzBanner(); render(); };
    var keep = el("button", "tzbtn ghost", "Keep " + city.name); keep.onclick = function () { save("gf_tz_dismiss", dev); b.hidden = true; };
    if (load("gf_tz_dismiss", null) === dev) { b.hidden = true; return; }
    b.appendChild(sw); b.appendChild(keep);
  }

  function buildOpenPrefs() {
    var box = $("#openDefault"); if (!box) return; box.innerHTML = "";
    var cur = load("gf_open_default", "ask");
    [["ask", "Always ask"], ["app", "Open in app"], ["browser", "Open in browser"]].forEach(function (o) {
      var b = el("button", cur === o[0] ? "on" : "", o[1]);
      b.onclick = function () { save("gf_open_default", o[0]); buildOpenPrefs(); };
      box.appendChild(b);
    });
    // per-service overrides: only for services Saint follows/has, that are real apps
    var ov = $("#openOverrides"); ov.innerHTML = "";
    var map = load("gf_open_svc", {});
    var ids = store.services.slice();
    if (!ids.length) return;
    ov.appendChild(el("div", "muted", "Per-service (optional):"));
    ids.forEach(function (id) {
      var sv = svcObj(id); if (!sv || (!sv.web && !sv.ios_store)) return;
      var row = el("div", "ovr"); row.appendChild(el("span", "nm", sv.name));
      var sel = el("select");
      [["", "use default"], ["app", "app"], ["browser", "browser"]].forEach(function (o) {
        var op = el("option", null, o[1]); op.value = o[0]; if ((map[id] || "") === o[0]) op.selected = true; sel.appendChild(op);
      });
      sel.onchange = function () { var m = load("gf_open_svc", {}); if (sel.value) m[id] = sel.value; else delete m[id]; save("gf_open_svc", m); };
      row.appendChild(sel); ov.appendChild(row);
    });
  }
  function chipPicker(box, keys, label, storeKey) {
    box.innerHTML = "";
    keys.forEach(function (k) {
      var on = store[storeKey].indexOf(k) >= 0;
      var c = el("button", "chip" + (on ? " on" : ""), label(k));
      c.onclick = function () { var a = store[storeKey], i = a.indexOf(k); if (i >= 0) a.splice(i, 1); else a.push(k); store[storeKey] = a; c.classList.toggle("on"); render(); };
      box.appendChild(c);
    });
  }
  function allTeams() {
    var m = {};
    (state.data.games || []).forEach(function (g) {
      [g.home, g.away].forEach(function (t) { if (t && t.id && t.name) { var k = teamKey(g.league, t.id); m[k] = { id: k, name: t.name, lg: g.league_name }; } });
    });
    return m;
  }
  function buildFollowedTeams() {
    var box = $("#followTeams"), m = allTeams(); box.innerHTML = "";
    store.teams.forEach(function (id) {
      var t = m[id]; var c = el("button", "chip on", (t ? t.name : id) + " ✕");
      c.onclick = function () { var a = store.teams, i = a.indexOf(id); if (i >= 0) a.splice(i, 1); store.teams = a; buildFollowedTeams(); render(); };
      box.appendChild(c);
    });
  }
  function teamSearch() {
    var q = $("#teamQ").value.trim().toLowerCase(), box = $("#teamResults"); box.innerHTML = "";
    if (q.length < 2) return;
    var m = allTeams(), out = [];
    for (var id in m) if (m[id].name.toLowerCase().indexOf(q) >= 0) out.push(m[id]);
    out.slice(0, 20).forEach(function (t) {
      var on = store.teams.indexOf(t.id) >= 0;
      var c = el("button", "chip" + (on ? " on" : ""), t.name + " · " + t.lg);
      c.onclick = function () { var a = store.teams; if (a.indexOf(t.id) < 0) { a.push(t.id); store.teams = a; } buildFollowedTeams(); render(); };
      box.appendChild(c);
    });
  }

  syncSeg();

  // --- live score polling: refresh only the live/soon leagues' scoreboards every ~45s ---
  function liveRerender() { var y = window.scrollY; render(); window.scrollTo(0, y); }
  function pollLive() {
    if (!state.data || document.visibilityState !== "visible") return;
    if (document.querySelector(".opensheet-bg")) return;    // don't re-render under a popup
    try { if (window.GFLive) GFLive.refreshLive(state.data.games, liveRerender); } catch (e) {}
  }
  setInterval(pollLive, 45000);
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") pollLive(); });
  setTimeout(pollLive, 3000);

  // --- app auto-update: keep the saved copy (instant open), check often, swap in safely ---
  function updatedToast() {
    var b = el("div", null, "Updated ✓"); b.id = "gfupd";
    b.style.cssText = "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:99;background:#3fb68b;color:#062b1d;font-weight:700;padding:10px 18px;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.5);font-size:14px";
    document.body.appendChild(b); setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); }, 2500);
  }
  function safeToSwap() {
    // never yank the page mid-popup or while typing
    if (document.querySelector(".opensheet-bg")) return false;
    var dlg = $("#settings"); if (dlg && dlg.open) return false;
    var a = document.activeElement; if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable)) return false;
    return true;
  }
  if ("serviceWorker" in navigator) {
    try { if (sessionStorage.getItem("gf_updated")) { sessionStorage.removeItem("gf_updated"); setTimeout(updatedToast, 400); } } catch (e) {}
    var swReg = null, pendingSwap = false, reloading = false;
    var applyUpdate = function () {
      if (!swReg || !swReg.waiting) return;
      if (!safeToSwap()) { pendingSwap = true; return; }   // defer until safe
      pendingSwap = false;
      try { sessionStorage.setItem("gf_updated", "1"); } catch (e) {}
      swReg.waiting.postMessage({ type: "skipWaiting" });
    };
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (reloading) return; reloading = true; location.reload();   // new version took over -> reload once
    });
    var reg = navigator.serviceWorker.register("sw.js", { updateViaCache: "none" });
    reg.then(function (r) {
      swReg = r;
      if (r.waiting && navigator.serviceWorker.controller) applyUpdate();  // one was already ready
      r.addEventListener("updatefound", function () {
        var nw = r.installing; if (!nw) return;
        nw.addEventListener("statechange", function () {
          if (nw.state === "installed" && navigator.serviceWorker.controller) applyUpdate();  // update (not first install)
        });
      });
      r.update().catch(function () {});
      setInterval(function () { r.update().catch(function () {}); }, 5 * 60 * 1000);   // every 5 min
    }).catch(function () {});
    var recheck = function () { if (document.visibilityState === "visible" && swReg) { swReg.update().catch(function () {}); if (pendingSwap) applyUpdate(); } };
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener("focus", recheck);
  }
})();
