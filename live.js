// GAME FINDER live scores (shared by the phone/public app and the TV app).
// Polls ESPN's PUBLIC scoreboard (CORS-open) for the leagues that have a live game, one call per
// league+date per cycle, with per-league backoff on error. Updates score/state in place; the app
// re-renders only the affected cards. (A licensed score feed is recommended before a big launch.)
(function (root) {
  "use strict";
  var ESPN = "https://site.api.espn.com/apis/site/v2/sports/";
  var backoff = {};   // league slug -> timestamp before which we won't retry

  function isSoon(g) { if (!g.start) return false; var t = new Date(g.start).getTime() - Date.now(); return t < 15 * 60000 && t > -6 * 3600000 && g.status !== "post"; }

  // The US/Eastern calendar day ESPN groups a game under (YYYYMMDD), so a game that has rolled past
  // ESPN's "today" boundary - a late-night game, or the viewer in a western/overseas time zone - is
  // still queried on the right day instead of silently dropping off the default scoreboard.
  function espnDate(iso) {
    try {
      var parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
      var o = {}; parts.forEach(function (p) { o[p.type] = p.value; });
      if (o.year && o.month && o.day) return o.year + o.month + o.day;
    } catch (e) {}
    return null;
  }

  function parseEvent(e) {
    var c = (e.competitions || [])[0] || {};
    // Prefer the EVENT-level status. For MMA/boxing fight cards the event is the whole card and
    // competitions[] are individual bouts, so competitions[0].status is one fight, not the card.
    var st = ((e.status || c.status || {}).type) || {};
    var home, away;
    (c.competitors || []).forEach(function (x) { if (x.homeAway === "home") home = x; else if (x.homeAway === "away") away = x; });
    var score = null;
    if ((st.state === "in" || st.state === "post") && home && away && home.score != null && away.score != null)
      score = { home: String(home.score), away: String(away.score) };
    return { eid: String(e.id), state: st.state || "pre", detail: st.shortDetail || st.detail || "", score: score, situation: c.situation || null };
  }

  // fetch with a hard 15s timeout so a hung ESPN request can't stall the poll cycle forever.
  function fetchJSON(url) {
    var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 15000) : null;
    return fetch(url, { cache: "no-store", signal: ctrl ? ctrl.signal : undefined }).then(function (r) {
      if (timer) clearTimeout(timer);
      if (!r || !r.ok) throw new Error("http " + (r && r.status));
      return r.json();
    }, function (err) { if (timer) clearTimeout(timer); throw err; });
  }

  // Pull one league across the given US/Eastern dates (explicit ?dates= per day). Resolves to a map
  // eid -> parsed event. Throws only if EVERY date request failed (so backoff kicks in); partial
  // success still returns what we got.
  function pollLeague(slug, dates) {
    var days = (dates && dates.length) ? dates : [null];
    return Promise.all(days.map(function (d) {
      return fetchJSON(ESPN + slug + "/scoreboard" + (d ? "?dates=" + d : "")).then(
        function (j) { return (j && j.events) || []; },
        function () { return null; });
    })).then(function (lists) {
      if (lists.every(function (x) { return x === null; })) throw new Error("all date requests failed");
      var m = {};
      lists.forEach(function (evs) { (evs || []).forEach(function (e) { var p = parseEvent(e); m[p.eid] = p; }); });
      return m;
    });
  }

  // Only per-league "/{sport}/{league}/scoreboard" endpoints are CORS-open. Cricket/rugby come
  // from ESPN's "scorepanel" (bare sport slug, no "/"), which blocks cross-origin, so skip those
  // for live polling - their scores still update on the full data refresh.
  function pollable(slug) { return slug && slug.indexOf("/") >= 0; }

  // Update live/soon ESPN games in `games` in place; call onUpdate(nChanged) if anything changed.
  function refreshLive(games, onUpdate) {
    var bySlug = {};   // slug -> set of YYYYMMDD dates to query
    (games || []).forEach(function (g) {
      if (!pollable(g.espn) || !(g.status === "in" || isSoon(g))) return;
      var set = bySlug[g.espn] || (bySlug[g.espn] = {});
      var d = g.start ? espnDate(g.start) : null;
      if (d) set[d] = 1;
    });
    var now = Date.now();
    var jobs = Object.keys(bySlug).filter(function (s) { return !backoff[s] || backoff[s] < now; });
    if (!jobs.length) return Promise.resolve(0);
    var changed = 0;
    return Promise.all(jobs.map(function (slug) {
      return pollLeague(slug, Object.keys(bySlug[slug])).then(function (m) {
        delete backoff[slug];
        games.forEach(function (g) {
          if (g.espn !== slug) return;
          var eid = g.eid || (g.id || "").split(":").pop();
          var p = m[eid]; if (!p) return;
          if (p.state !== g.status || JSON.stringify(p.score) !== JSON.stringify(g.score) || p.detail !== g.status_detail) {
            g.status = p.state; g.score = p.score; g.status_detail = p.detail; g.situation = p.situation; changed++;
          }
        });
      }).catch(function () { backoff[slug] = Date.now() + 120000; });   // 2-min backoff on error
    })).then(function () { if (changed && onUpdate) onUpdate(changed); return changed; });
  }

  // The live-state line for a card.
  function liveLine(g) {
    if (g.status === "post") return g.status_detail || "Final";
    if (g.status !== "in") return "";
    var s = (g.status_detail || "LIVE").replace(/^Top /, "▲ ").replace(/^Bot /, "▼ ");  // MLB inning arrows
    var sit = g.situation;
    if (sit) {
      if (sit.downDistanceText) s += " · " + sit.downDistanceText;                 // NFL/CFB down & distance
      else if (typeof sit.outs === "number") s += " · " + sit.outs + " out" + (sit.outs === 1 ? "" : "s");  // MLB outs
    }
    return s;
  }

  // Is this game actually live RIGHT NOW for display? A game left in the "in" state long past when
  // it could still be playing is stale data, not a live game, so don't show a pulsing LIVE pill for
  // it. Multiday events (test cricket, tennis/golf tournaments) are exempt; everything else caps at
  // 8 hours after start. (Live polling still uses the raw status, so a reachable game self-corrects.)
  function isLive(g) {
    if (!g || g.status !== "in") return false;
    if (!g.multiday && g.start) {
      var hrs = (Date.now() - new Date(g.start).getTime()) / 3600000;
      if (hrs > 8 || hrs < -0.1) return false;
    }
    return true;
  }

  var api = { refreshLive: refreshLive, liveLine: liveLine, isSoon: isSoon, isLive: isLive };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.GFLive = api;
})(this);
