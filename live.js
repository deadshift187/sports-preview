// GAME FINDER live scores (shared by the phone/public app and the TV app).
// Polls ESPN's PUBLIC scoreboard (CORS-open) for the leagues that have a live game, one call per
// league per cycle, with per-league backoff on error. Updates score/state in place; the app
// re-renders only the affected cards. (A licensed score feed is recommended before a big launch.)
(function (root) {
  "use strict";
  var ESPN = "https://site.api.espn.com/apis/site/v2/sports/";
  var backoff = {};   // league slug -> timestamp before which we won't retry

  function isSoon(g) { if (!g.start) return false; var t = new Date(g.start).getTime() - Date.now(); return t < 15 * 60000 && t > -6 * 3600000 && g.status !== "post"; }

  function parseEvent(e) {
    var c = (e.competitions || [])[0] || {}, st = (c.status || {}).type || {};
    var home, away;
    (c.competitors || []).forEach(function (x) { if (x.homeAway === "home") home = x; else if (x.homeAway === "away") away = x; });
    var score = null;
    if ((st.state === "in" || st.state === "post") && home && away && home.score != null && away.score != null)
      score = { home: String(home.score), away: String(away.score) };
    return { eid: String(e.id), state: st.state || "pre", detail: st.shortDetail || st.detail || "", score: score, situation: c.situation || null };
  }

  function pollLeague(slug) {
    return fetch(ESPN + slug + "/scoreboard", { cache: "no-store" }).then(function (r) { return r.json(); })
      .then(function (d) { var m = {}; (d.events || []).forEach(function (e) { var p = parseEvent(e); m[p.eid] = p; }); return m; });
  }

  // Only per-league "/{sport}/{league}/scoreboard" endpoints are CORS-open. Cricket/rugby come
  // from ESPN's "scorepanel" (bare sport slug, no "/"), which blocks cross-origin, so skip those
  // for live polling - their scores still update on the full data refresh.
  function pollable(slug) { return slug && slug.indexOf("/") >= 0; }

  // Update live/soon ESPN games in `games` in place; call onUpdate(nChanged) if anything changed.
  function refreshLive(games, onUpdate) {
    var slugs = {};
    (games || []).forEach(function (g) { if (pollable(g.espn) && (g.status === "in" || isSoon(g))) slugs[g.espn] = 1; });
    var now = Date.now();
    var jobs = Object.keys(slugs).filter(function (s) { return !backoff[s] || backoff[s] < now; });
    if (!jobs.length) return Promise.resolve(0);
    var changed = 0;
    return Promise.all(jobs.map(function (slug) {
      return pollLeague(slug).then(function (m) {
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

  var api = { refreshLive: refreshLive, liveLine: liveLine, isSoon: isSoon };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.GFLive = api;
})(this);
