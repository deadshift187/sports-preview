// GAME FINDER ranking rules — shared by the phone app, the TV app, and tests/test_rank.js.
//
// THREE RULES, in order:
//  1. FREE FIRST. A proven-free route (over-the-air with an antenna, or a service's official
//     free tier) ranks above everything. "Free" is never guessed — a watch option is only
//     green when the data says free_ota (a broadcast network) or free:true with an evidence
//     source. Otherwise it is gold (you have it) or orange (pay/download).
//  2. NEVER THE WRONG APP. A channel opens in the NETWORK'S OWN app first (ESPN->ESPN app,
//     CBS->Paramount+, NBC->Peacock, FOX/FS1->Fox One, TNT->HBO Max). Pay-TV bundles
//     (YouTube TV, Fubo, Sling, DIRECTV, Hulu Live) are a fallback only, never above a free
//     or owned route.
//  3. NO PAID PLACEMENT. Order is category (free/have/pay) -> own-app-before-bundle ->
//     confidence -> national-before-local. Nothing is ranked for money.
//
// Colors: free = green, have = gold, pay = orange.
(function (root) {
  var BUNDLES = ["youtubetv", "fubo", "hululive", "sling", "directv", "cable"];
  var CONF = { "confirmed": 0, "league-deal": 1, "unverified": 2 };
  var CAT = { "free": 0, "have": 1, "pay": 2 };
  var COLOR = { "free": "green", "have": "gold", "pay": "orange" };

  function pick(list, owned) {
    for (var i = 0; i < (list || []).length; i++) if (owned.has(list[i])) return list[i];
    return null;
  }
  function firstReal(list) {
    for (var i = 0; i < (list || []).length; i++) if (list[i] !== "antenna" && list[i] !== "cable") return list[i];
    return (list && list[0]) || null;
  }

  // Classify one watch option -> {w, cat, color, owned, open, viaBundle, needsAccount, freeNote}
  function classify(w, owned, idx) {
    if (w.tba) return { w: w, cat: "pay", color: "orange", owned: false, open: null, viaBundle: false, needsAccount: false, freeNote: "", tba: true, idx: idx };
    var apps = w.apps || [], bundles = w.bundles || [];
    var isFree = !!(w.free_ota || w.free);
    var ownedApp = pick(apps, owned), ownedBundle = pick(bundles, owned);
    var cat, open = null, viaBundle = false;

    if (isFree) {
      cat = "free";
      if (w.free && firstReal(apps)) open = ownedApp || firstReal(apps); // a free streaming service
      else open = "antenna";                                             // over-the-air
    } else if (ownedApp && ownedApp !== "antenna") { cat = "have"; open = ownedApp; }
    else if (ownedBundle) { cat = "have"; open = ownedBundle; viaBundle = true; }
    else { // pay / download
      cat = "pay";
      open = firstReal(apps) || firstReal(bundles);
      viaBundle = !firstReal(apps) && !!firstReal(bundles);
    }
    return {
      w: w, cat: cat, color: COLOR[cat], owned: cat !== "pay",
      open: open, viaBundle: viaBundle,
      needsAccount: !!w.needs_account,
      freeNote: w.free_ota ? "Free · antenna" : (w.needs_account ? "Free · free account" : "Free"),
      idx: idx
    };
  }

  function rankWatch(watch, owned) {
    owned = owned instanceof Set ? owned : new Set(owned || []);
    var out = (watch || []).map(function (w, i) { return classify(w, owned, i); });
    out.sort(function (a, b) {
      return (CAT[a.cat] - CAT[b.cat]) ||
        ((a.viaBundle ? 1 : 0) - (b.viaBundle ? 1 : 0)) ||
        ((CONF[a.w.confidence] || 0) - (CONF[b.w.confidence] || 0)) ||
        ((a.w.market === "national" ? 0 : 1) - (b.w.market === "national" ? 0 : 1)) ||
        (a.idx - b.idx);
    });
    return out;
  }

  function svcName(services, id) {
    for (var i = 0; i < services.length; i++) if (services[i].id === id) return services[i].name;
    return id || "";
  }

  // One plain sentence for the top of a game card.
  function whyLine(game, owned, services) {
    var r = rankWatch(game.watch, owned);
    if (!r.length) return { text: "No confirmed US listing yet", tone: "none", color: "none" };
    var top = r[0], ch = top.w.name, check = top.w.confidence === "unverified" ? " (unconfirmed)" : "";
    if (top.tba) return { text: "Channel not announced yet — check listings", tone: "need", color: "orange" };
    if (top.cat === "free") {
      if (top.w.free_ota) return { text: "On " + ch + " → free with an antenna" + check, tone: "have", color: "green" };
      return { text: "On " + ch + " → " + top.freeNote + check, tone: "have", color: "green" };
    }
    if (top.cat === "have") return { text: "On " + ch + " → open " + svcName(services, top.open) + " (you have it)" + check, tone: "have", color: "gold" };
    return { text: "On " + ch + " → needs " + svcName(services, top.open) + " (pay / download)" + check, tone: "need", color: "orange" };
  }

  // ---------------------------------------------------------------- MOVIES & TV ----
  // Services that are free to watch (ad-supported / library). An offer on one of these,
  // or an offer whose own type is "free", is green.
  var FREE_SERVICES = { tubi: 1, pluto: 1, roku: 1, victory: 1, kanopy: 1, hoopla: 1, youtube: 1, freevee: 1, vix: 1 };

  function seasonSet(spec, total) {
    // "1-6" -> {1..6}; "3" -> {3}; "all"/null -> {1..total}
    var s = {};
    if (spec == null || spec === "all" || spec === "") { for (var i = 1; i <= (total || 1); i++) s[i] = 1; return s; }
    String(spec).split(",").forEach(function (part) {
      part = part.trim();
      var m = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) { for (var j = +m[1]; j <= +m[2]; j++) s[j] = 1; }
      else if (/^\d+$/.test(part)) s[+part] = 1;
    });
    return s;
  }
  function fmtSeasons(setObj) {
    var ns = Object.keys(setObj).map(Number).sort(function (a, b) { return a - b; });
    if (!ns.length) return "";
    var out = [], i = 0;
    while (i < ns.length) { var a = ns[i], b = a; while (i + 1 < ns.length && ns[i + 1] === ns[i] + 1) { i++; b = ns[i]; } out.push(a === b ? "S" + a : "S" + a + "–S" + b); i++; }
    return out.join(", ");
  }
  function priceNum(p) { if (!p) return Infinity; var m = String(p).match(/([0-9]+(\.[0-9]+)?)/); return m ? parseFloat(m[1]) : Infinity; }

  function offerCat(o, owned) {
    var free = o.offer === "free" || o.offer === "ads" || FREE_SERVICES[o.service];
    if (free) return "free";
    if (o.offer === "flatrate" && owned.has(o.service)) return "have";
    return "pay"; // subscription not owned, or rent/buy
  }

  // Rank a title's offers. Green(free) > gold(included) > orange(pay), cheapest first within a tier.
  function rankOffers(title, owned) {
    owned = owned instanceof Set ? owned : new Set(owned || []);
    var total = title.seasons || 1;
    var out = (title.offers || []).map(function (o, i) {
      var cat = offerCat(o, owned);
      return {
        o: o, cat: cat, color: COLOR[cat], idx: i,
        seasons: seasonSet(o.seasons, total),
        price: priceNum(o.price),
        isBuyRent: o.offer === "rent" || o.offer === "buy"
      };
    });
    out.sort(function (a, b) {
      return (CAT[a.cat] - CAT[b.cat]) || (a.price - b.price) ||
        ((CONF[a.o.confidence] || 0) - (CONF[b.o.confidence] || 0)) || (a.idx - b.idx);
    });
    return out;
  }

  // "You already have this" check: tapping a pay offer when the SAME seasons are included
  // with an owned service or free. Returns null, or {service, label, seasonsText} for the alert.
  function alreadyHave(title, paidOffer, owned) {
    owned = owned instanceof Set ? owned : new Set(owned || []);
    var total = title.seasons || 1;
    var want = seasonSet(paidOffer.seasons, total);
    var best = null;
    (title.offers || []).forEach(function (o) {
      if (o === paidOffer) return;
      var cat = offerCat(o, owned);
      if (cat === "pay") return; // only owned-included or free count
      var cover = seasonSet(o.seasons, total), overlap = {};
      Object.keys(want).forEach(function (s) { if (cover[s]) overlap[s] = 1; });
      if (!Object.keys(overlap).length) return;
      var cand = { service: o.service, cat: cat, overlap: overlap, n: Object.keys(overlap).length };
      if (!best || cand.n > best.n || (cand.n === best.n && cat === "have")) best = cand;
    });
    if (!best) return null;
    return { service: best.service, free: best.cat === "free", seasonsText: fmtSeasons(best.overlap) };
  }

  var api = { rankWatch: rankWatch, whyLine: whyLine, classify: classify,
              rankOffers: rankOffers, alreadyHave: alreadyHave, seasonSet: seasonSet, fmtSeasons: fmtSeasons,
              FREE_SERVICES: FREE_SERVICES, BUNDLES: BUNDLES, COLOR: COLOR };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.GFRank = api;
})(this);
