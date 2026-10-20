"""GAME FINDER refresh loop.

Collects every game for the next week across all configured leagues, attaches
where to WATCH (TV / streaming) and where to LISTEN (radio / satellite / apps),
and writes data/games.json for the app.

Every listing carries: source, confidence, checked (UTC ISO time).
Confidence ladder:
  confirmed   per-game listing from a schedule feed (ESPN, TheSportsDB) or an AI check with a source URL
  league-deal league-wide rights deal that covers ALL matches (sourced in config/rights.json)
  season      team radio flagship for the season (sourced in data/research/radio_*.json)
  unverified  we have a hint but no per-game confirmation -> shown as "check"

Usage:
  python refresh.py            full sweep (yesterday .. +7 days)
  python refresh.py --soon     only re-check games starting in the next 6 hours (fast)
Stdlib only. The optional AI step lives in ai_reconcile.py and runs after this.
"""
import json, os, re, sys, time, socket, functools, datetime as dt, urllib.request, urllib.parse, glob
from concurrent.futures import ThreadPoolExecutor

# The home DNS server sometimes stalls; resolve each host once per run instead of per request.
_real_gai = socket.getaddrinfo
socket.getaddrinfo = functools.lru_cache(maxsize=256)(lambda *a, **k: _real_gai(*a, **k))
socket.setdefaulttimeout(30)

ROOT = os.path.dirname(os.path.abspath(__file__))
CFG = os.path.join(ROOT, "config")
DATA = os.path.join(ROOT, "data")
RESEARCH = os.path.join(DATA, "research")
ESPN = "https://site.api.espn.com/apis/site/v2/sports/"
TSDB = "https://www.thesportsdb.com/api/v1/json/123/"
UA = {"User-Agent": "Mozilla/5.0 (GameFinder personal schedule app)"}

NOW = dt.datetime.now(dt.timezone.utc)
CHECKED = NOW.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def get_json(url, tries=2):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=25) as r:
                return json.load(r)
        except Exception as e:  # network blips: retry once, then give up quietly
            err = e
            time.sleep(1 + i)
    log("  fetch failed", url[:110], err)
    return None


def load(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except Exception as e:
        log("  bad json", path, e)
        return default


def save(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


# ---------------------------------------------------------------- services
SERVICES = load(os.path.join(CFG, "services.json"), {"services": [], "channels": []})
CHANNEL_RULES = []  # (compiled regex, channel entry)
for ch in SERVICES.get("channels", []):
    CHANNEL_RULES.append((re.compile(ch["match"], re.I), ch))


BUNDLE_IDS = {"youtubetv", "fubo", "hululive", "sling", "directv", "cable"}
CARRIAGE = SERVICES.get("carriage", {})  # bundle key -> [bundle service ids], sourced in research/services.json


def split_services(ch):
    """Network's own app(s) first; pay-TV bundles only as a fallback list (never ranked above the network app)."""
    if not ch:
        return [], []
    svcs = ch.get("services", [])
    apps = [s for s in svcs if s not in BUNDLE_IDS]
    bundles = [s for s in svcs if s in BUNDLE_IDS]
    for b in CARRIAGE.get(ch.get("bundle") or "", []):
        if b not in bundles:
            bundles.append(b)
    return apps, bundles


def classify_channel(name):
    """Map a broadcaster name from a feed to our channel entry (display name + services)."""
    n = (name or "").strip()
    for rx, ch in CHANNEL_RULES:
        if rx.fullmatch(n):
            return ch
    return None


# Multi-network placeholder (e.g. "ESPN/ABC/ESPN2/ESPNU/SEC Network/..."): the feed hasn't
# assigned the actual channel yet. Treat as "Network TBA", not one broken channel.
_RADIO_NAMES = {"ERADM": None, "ESPNRM": "ESPN Radio", "ESPN RADIO": "ESPN Radio",
                "WWONE": "Westwood One", "COMPASS": "Compass Media"}


def is_network_tba(name):
    n = (name or "")
    return n.count("/") >= 2 or n.count(" / ") >= 2


def dedup_freq(name):
    """Collapse a radio name that repeats its frequency, e.g. '97.1 The Fan 97.1 FM' -> '97.1 The
    Fan'. Removes the first bare occurrence of any frequency that appears 2+ times in the string."""
    n = (name or "").strip()
    if not n:
        return n
    for num in set(re.findall(r"\d{2,3}\.\d", n)):
        if n.count(num) >= 2:
            n = re.sub(r"\s*\b" + re.escape(num) + r"\s*(FM|AM)?\b", " ", n, count=1)
            n = re.sub(r"\s{2,}", " ", n).strip(" /·-")
    return n or (name or "").strip()


def clean_radio_name(name):
    """Return a human radio name, or None to drop an internal code.
    US/Canada call signs start with W, K or C; anything else all-caps and codey is an internal id."""
    n = (name or "").strip()
    if not n:
        return None
    up = n.upper()
    if up in _RADIO_NAMES:
        return _RADIO_NAMES[up]
    if " " in n or "." in n or "-" in n:   # real station strings have spaces/dots/dashes
        return n
    if re.fullmatch(r"[A-Z]{3,6}", up):     # bare all-caps code
        return n if up[0] in "WKC" else None
    return n


# ---------------------------------------------------------------- ESPN
FAILED = set()  # (league key, day) pairs that could not be fetched this run
SRC_FAILED = set()  # supplemental sources ("scorepanel"/"tsdb") that had a failed request this run


def espn_day(league, day):
    q = "dates=" + day
    if league.get("params"):
        q += "&" + league["params"]
    d = get_json(f"{ESPN}{league['espn']}/scoreboard?{q}")
    if d is None and league.get("params"):  # some slugs reject groups/limit
        d = get_json(f"{ESPN}{league['espn']}/scoreboard?dates={day}")
    if d is None:
        FAILED.add((league["key"], day))
    return (d or {}).get("events", [])


def team_of(c):
    t = c.get("team") or c.get("athlete") or {}
    name = t.get("displayName") or t.get("fullName") or t.get("name") or ""
    logo = t.get("logo") or (t.get("logos") or [{}])[0].get("href") or (t.get("flag") or {}).get("href")
    return {
        "id": str(t.get("id", "")),
        "name": name,
        "short": t.get("shortDisplayName") or t.get("abbreviation") or name,
        "abbr": t.get("abbreviation") or "",
        "logo": logo or "",
        "color": ("#" + t["color"]) if t.get("color") else "",
        "alt": ("#" + t["alternateColor"]) if t.get("alternateColor") else "",
    }


def espn_broadcasts(comp):
    out = []
    for g in comp.get("geoBroadcasts") or []:
        if (g.get("region") or "us").lower() != "us":
            continue
        out.append({
            "name": (g.get("media") or {}).get("shortName") or "",
            "kind": ((g.get("type") or {}).get("shortName") or "TV").lower(),
            "market": ((g.get("market") or {}).get("type") or "national").lower(),
            "lang": g.get("lang") or "en",
        })
    if not out:
        for b in comp.get("broadcasts") or []:
            for n in b.get("names") or []:
                out.append({"name": n, "kind": "tv", "market": (b.get("market") or "national").lower(), "lang": "en"})
    return [b for b in out if b["name"]]


def norm_espn_event(league, e):
    comps = e.get("competitions") or [{}]
    main = comps[0]
    # Fight cards list one competition per bout; the main event is last.
    if league["group"] == "Fights" and len(comps) > 1:
        main = comps[-1]
    status = (e.get("status") or main.get("status") or {}).get("type", {})
    time_tbd = (main.get("timeValid") is False) or (e.get("timeValid") is False)
    home = away = None
    competitors = main.get("competitors") or []
    for c in competitors:
        if c.get("homeAway") == "home":
            home = team_of(c)
        elif c.get("homeAway") == "away":
            away = team_of(c)
    if not home and len(competitors) == 2:
        home, away = team_of(competitors[0]), team_of(competitors[1])
    bcs, seen = [], set()
    for comp in comps:
        for b in espn_broadcasts(comp):
            k = (b["name"].lower(), b["kind"], b["market"])
            if k not in seen:
                seen.add(k)
                bcs.append(b)
    link = ""
    for l in e.get("links") or []:
        if "summary" in (l.get("rel") or []) or "event" in (l.get("rel") or []):
            link = l.get("href", "")
            break
    score = None
    if status.get("state") in ("in", "post") and home and away:
        hs = next((c.get("score") for c in competitors if c.get("homeAway") == "home"), None)
        as_ = next((c.get("score") for c in competitors if c.get("homeAway") == "away"), None)
        if isinstance(hs, (str, int)) and isinstance(as_, (str, int)):
            score = {"home": str(hs), "away": str(as_)}
    return {
        "id": f"espn:{league['key']}:{e.get('id')}",
        "league": league["key"],
        "league_name": league["name"],
        "group": league["group"],
        "start": e.get("date"),
        "end": e.get("endDate"),
        "multiday": bool(league.get("multiday")),
        "time_tbd": bool(time_tbd),
        "espn": league.get("espn", ""),   # sport/league slug, for client-side live score polling
        "eid": str(e.get("id", "")),
        "name": e.get("name") or "",
        "short": e.get("shortName") or "",
        "home": home,
        "away": away,
        "venue": ((main.get("venue") or {}).get("fullName")) or "",
        "status": status.get("state") or "pre",
        "status_detail": status.get("shortDetail") or status.get("detail") or "",
        "score": score,
        "note": ((main.get("notes") or [{}])[0].get("headline")) if main.get("notes") else "",
        "link": link,
        "_raw_broadcasts": bcs,
        "sources": [{"name": "ESPN scoreboard", "url": f"{ESPN}{league['espn']}/scoreboard"}],
    }


_STATUS_RANK = {"post": 3, "in": 2, "pre": 1}


def _more_complete(new, old):
    """When a game shows up under more than one day query, keep the most advanced one
    (final > live > scheduled), and prefer one that actually has a score."""
    if old is None:
        return True
    rn, ro = _STATUS_RANK.get(new["status"], 0), _STATUS_RANK.get(old["status"], 0)
    if rn != ro:
        return rn > ro
    return bool(new.get("score")) and not old.get("score")


def fetch_espn(leagues, days):
    jobs = [(lg, d) for lg in leagues for d in days]
    events = {}
    with ThreadPoolExecutor(16) as ex:
        for (lg, d), evs in zip(jobs, ex.map(lambda j: espn_day(*j), jobs)):
            for e in evs:
                g = norm_espn_event(lg, e)
                if _more_complete(g, events.get(g["id"])):
                    events[g["id"]] = g
    return list(events.values())


# ESPN "scorepanel" returns every event that day for a whole sport (cricket/rugby have many
# sub-leagues ESPN doesn't expose as individual scoreboard slugs). One call per day per sport.
SCOREPANEL = [
    {"key": "cricket", "name": "Cricket", "group": "Cricket", "sport": "cricket"},
    {"key": "rugby", "name": "Rugby Union", "group": "Rugby", "sport": "rugby"},
]


def fetch_scorepanel(days):
    out = {}

    def one(j):
        p, day = j
        d = get_json(f"{ESPN}{p['sport']}/scorepanel?dates={day}")
        if d is None:
            SRC_FAILED.add("scorepanel")   # so cricket/rugby carry over instead of vanishing
        evs = []
        for sb in (d or {}).get("scores", []) or []:
            lgmeta = (sb.get("leagues") or [{}])[0]
            for e in sb.get("events", []) or []:
                lg = {"key": p["key"], "name": lgmeta.get("name") or p["name"],
                      "espn": p["sport"], "group": p["group"]}
                evs.append(norm_espn_event(lg, e))
        return evs

    jobs = [(p, d) for p in SCOREPANEL for d in days]
    with ThreadPoolExecutor(8) as ex:
        for evs in ex.map(one, jobs):
            for g in evs:
                # keep the real competition name as the league label
                g["league"] = re.sub(r"[^a-z0-9]+", "-", (g["league_name"] or g["league"]).lower()).strip("-") or g["league"]
                out[g["id"]] = g
    return list(out.values())


def fetch_nascar(days):
    """cf.nascar.com lists each series' races with the TV network (better than ESPN here)."""
    d = get_json("https://cf.nascar.com/cacher/2026/race_list_basic.json")
    if not d:
        return []
    daystr = set(days)
    series = {1: ("nascar", "NASCAR Cup"), 2: ("xfinity", "NASCAR O'Reilly Series"), 3: ("trucks", "NASCAR Trucks")}
    out = []
    races = d if isinstance(d, list) else sum((v for v in d.values() if isinstance(v, list)), [])
    for r in races:
        sid = r.get("series_id")
        if sid not in series:
            continue
        start = r.get("race_date") or r.get("tunein_date") or ""
        day = start[:10].replace("-", "")
        if day not in daystr:
            continue
        key, name = series[sid]
        tv = r.get("television_broadcaster") or r.get("broadcaster") or ""
        bcs = [{"name": tv, "kind": "tv", "market": "national", "lang": "en"}] if tv else []
        out.append({
            "id": f"nascar:{sid}:{r.get('race_id')}", "league": key, "league_name": name, "group": "Racing",
            "start": (start.replace(" ", "T") + "Z") if start and "T" not in start else start,
            "end": None, "multiday": True, "name": r.get("race_name") or name, "short": r.get("race_name") or "",
            "home": None, "away": None, "venue": r.get("track_name") or "", "status": "pre",
            "status_detail": "", "score": None, "note": r.get("scheduled_distance") and "", "link": "",
            "_raw_broadcasts": bcs,
            "sources": [{"name": "NASCAR.com", "url": "https://cf.nascar.com/cacher/2026/race_list_basic.json"}],
        })
    return out


# ---------------------------------------------------------------- TheSportsDB (supplement)
# Cricket + Rugby now come from ESPN scorepanel (fuller, faster); keep the rest on TheSportsDB.
TSDB_SPORTS = {"Fighting": "Fights", "Cycling": "Other",
               "Motorsport": "Racing", "Australian Football": "Other", "Darts": "Other", "Snooker": "Other",
               "Handball": "Other", "Volleyball": "Other", "Esports": "Other"}
TSDB_SKIP_LEAGUES = re.compile(r"^(UFC|PFL)\b", re.I)  # ESPN already covers these with broadcasts


def fetch_tsdb(days):
    out = {}
    jobs = [(s, d) for s in TSDB_SPORTS for d in days]

    def one(j):
        s, d = j
        iso = f"{d[:4]}-{d[4:6]}-{d[6:]}"
        time.sleep(2.1)  # free key = 30 requests/minute
        r = get_json(TSDB + "eventsday.php?" + urllib.parse.urlencode({"d": iso, "s": s}))
        if r is None:
            SRC_FAILED.add("tsdb")   # so TheSportsDB-sourced games carry over instead of vanishing
        return s, (r or {}).get("events") or []

    with ThreadPoolExecutor(1) as ex:
        for s, evs in ex.map(one, jobs):
            for e in evs:
                if TSDB_SKIP_LEAGUES.search(e.get("strLeague") or ""):
                    continue
                ts = e.get("strTimestamp")
                start = (ts + "Z") if ts and not ts.endswith("Z") and "+" not in ts else ts
                # TheSportsDB uses midnight when only the DATE is known. Don't present that as a real
                # 12:00 AM UTC tip-off - mark the time as TBD so the UI shows the day, not a wrong time.
                tsdb_tbd = ((e.get("strTime") or "")[:5] in ("", "00:00")) or ("00:00:00" in str(start or ""))
                lkey = "tsdb:" + re.sub(r"[^a-z0-9]+", "-", (e.get("strLeague") or s).lower()).strip("-")
                home = {"id": "", "name": e.get("strHomeTeam") or "", "short": e.get("strHomeTeam") or "", "abbr": "", "logo": e.get("strHomeTeamBadge") or ""} if e.get("strHomeTeam") else None
                away = {"id": "", "name": e.get("strAwayTeam") or "", "short": e.get("strAwayTeam") or "", "abbr": "", "logo": e.get("strAwayTeamBadge") or ""} if e.get("strAwayTeam") else None
                g = {
                    "id": "tsdb:" + str(e.get("idEvent")),
                    "league": lkey, "league_name": e.get("strLeague") or s,
                    "group": TSDB_SPORTS[s], "start": start, "end": None, "multiday": False, "time_tbd": tsdb_tbd,
                    "name": e.get("strEvent") or "", "short": e.get("strEventAlternate") or e.get("strEvent") or "",
                    "home": home, "away": away, "venue": e.get("strVenue") or "",
                    "status": "post" if (e.get("strStatus") or "").upper() in ("FT", "MATCH FINISHED", "AET") else "pre",
                    "status_detail": e.get("strStatus") or "", "score": None, "note": "",
                    "link": f"https://www.thesportsdb.com/event/{e.get('idEvent')}",
                    "_raw_broadcasts": [],
                    "sources": [{"name": "TheSportsDB", "url": "https://www.thesportsdb.com"}],
                }
                out[g["id"]] = g
    # TV listings (free key returns a sample; US entries only)
    for d in days:
        iso = f"{d[:4]}-{d[4:6]}-{d[6:]}"
        time.sleep(2.1)
        r = get_json(TSDB + "eventstv.php?d=" + iso) or {}
        for t in r.get("tvevents") or []:
            if (t.get("strCountry") or "") not in ("United States", "USA"):
                continue
            g = out.get("tsdb:" + str(t.get("idEvent")))
            if g:
                g["_raw_broadcasts"].append({"name": t.get("strChannel"), "kind": "tv", "market": "national", "lang": "en", "source": "TheSportsDB TV"})
    return list(out.values())


# ---------------------------------------------------------------- watch listings
def build_watch(g, rights):
    watch = []
    for b in g.pop("_raw_broadcasts", []):
        if b["kind"] == "radio":
            continue
        if is_network_tba(b["name"]):
            watch.append({"name": "Network TBA", "feed_name": b["name"], "kind": "tv",
                          "market": b["market"], "lang": b.get("lang", "en"), "apps": [], "bundles": [],
                          "free_ota": False, "free": False, "needs_account": False, "free_evidence": "",
                          "tba": True, "source": b.get("source") or "ESPN scoreboard",
                          "confidence": "unverified", "checked": CHECKED,
                          "why": "channel not assigned yet - check listings closer to game time"})
            continue
        # A two-network simulcast ("NBC / Peacock") resolves to the first (usually the free/OTA) network.
        feed = b["name"]
        ch = classify_channel(feed)
        if not ch and " / " in feed:
            first = feed.split(" / ")[0].strip()
            ch = classify_channel(first)
            if ch:
                feed = first
        watch.append({
            "name": (ch.get("label") if ch else None) or feed,
            "feed_name": b["name"],
            "kind": "stream" if b["kind"] == "streaming" else ("stream" if ch and ch.get("stream_only") else "tv"),
            "market": b["market"],
            "lang": b.get("lang", "en"),
            "apps": split_services(ch)[0], "bundles": split_services(ch)[1],
            "free_ota": bool(ch and ch.get("free_ota")),
            "free": bool(ch and ch.get("free")),
            "needs_account": bool(ch and ch.get("needs_account")),
            "free_evidence": (ch or {}).get("free_evidence", ""),
            "source": b.get("source") or "ESPN scoreboard",
            "confidence": "confirmed",
            "checked": CHECKED,
        })
    # League-wide deals: only auto-add when the deal covers ALL matches (sourced in rights.json).
    lr = rights.get(g["league"]) or {}
    have = {w["name"].lower() for w in watch}
    for h in lr.get("holders", []):
        if h.get("verified") is False:
            continue
        ch = classify_channel(h["name"])
        label = (ch.get("label") if ch else None) or h["name"]
        if label.lower() in have:
            continue
        if h.get("all"):
            if watch and h.get("only_if_empty"):
                continue
            watch.append({
                "name": label, "feed_name": h["name"], "kind": "stream" if ch and ch.get("stream_only") else "tv",
                "market": "national", "lang": h.get("lang", "en"), "apps": split_services(ch)[0], "bundles": split_services(ch)[1],
                # A league-wide deal infers THIS game onto a network; it is not a per-game confirmation,
                # so never carry a free/OTA promise on it. Only a "confirmed" listing can be green.
                "free_ota": False,
                "free": False,
                "needs_account": bool(ch and ch.get("needs_account")),
                "free_evidence": "",
                "source": h.get("source") or "rights.json", "confidence": "league-deal", "checked": CHECKED,
                "why": h.get("share", "league deal"),
            })
        elif not watch:
            watch.append({
                "name": label, "feed_name": h["name"], "kind": "tv", "market": "national", "lang": h.get("lang", "en"),
                "apps": split_services(ch)[0], "bundles": split_services(ch)[1], "free_ota": False,
                "source": h.get("source") or "rights.json", "confidence": "unverified", "checked": CHECKED,
                "why": "rights holder for some matches - not confirmed for this one",
            })
    g["watch"] = watch


# ---------------------------------------------------------------- listen listings
def load_radio():
    by_team = {}   # (league_key, espn_team_id) -> team entry
    league_audio = {}
    for path in glob.glob(os.path.join(RESEARCH, "radio_*.json")):
        d = load(path, {}) or {}
        lg = (d.get("league") or "").lower()
        keys = {"nfl": ["nfl"], "nba": ["nba"], "wnba": ["wnba"], "mlb": ["mlb"], "nhl": ["nhl"], "mls": ["mls"],
                "nwsl": ["nwsl"], "college": ["cfb", "mcbb", "wcbb"], "ncaa": ["cfb", "mcbb", "wcbb"]}
        for k in keys.get(lg, keys.get(lg.split()[0], []) if lg else []):
            for t in d.get("teams", []):
                if t.get("espn_id"):
                    by_team[(k, str(t["espn_id"]))] = t
            if d.get("league_audio"):
                league_audio[k] = d["league_audio"]
    national = load(os.path.join(RESEARCH, "radio_national.json"), {}) or {}
    return by_team, league_audio, national


def station_link(st):
    s = st.get("stream") or {}
    return s.get("url") or ""


def build_listen(g, radio):
    by_team, league_audio, rules = radio
    listen = []
    # 1) per-game radio from the feed (ESPN lists radio for some MLB games)
    for b in [b for b in g.get("_radio", [])]:
        listen.append(b)
    # 2) team flagships
    for side in ("away", "home"):
        t = g.get(side)
        if not t or not t.get("id"):
            continue
        entry = by_team.get((g["league"], t["id"]))
        if not entry:
            continue
        for st in entry.get("stations", []):
            call, freq = st.get("call"), st.get("freq")
            # De-dupe a frequency that's already in the call name (e.g. call "97.1 The Fan" + freq
            # "97.1 FM" -> just "97.1 The Fan", not "97.1 The Fan 97.1 FM").
            if call and freq:
                m = re.search(r"\d{2,3}\.\d", call)
                if m and m.group(0) in freq:
                    freq = None
            label = " ".join(x for x in [call, freq] if x)
            listen.append({
                "name": label or st.get("name", "Team radio"),
                "kind": "team",
                "team": t.get("short") or t.get("name"),
                "side": side,
                "market": st.get("market", ""),
                "lang": st.get("lang", "en"),
                "app": (st.get("stream") or {}).get("app", ""),
                "link": station_link(st) or entry.get("team_audio_url") or "",
                "network": entry.get("network", ""),
                "source": entry.get("source", ""),
                "confidence": "season" if entry.get("verified", True) else "unverified",
                "checked": (entry.get("checked") or "")[:10] or None,
                "note": st.get("note") or entry.get("note") or "",
            })
    # 3) national radio / satellite / league apps from rule table (config/radio_rules.json)
    for r in rules.get("rules", []) if isinstance(rules, dict) else []:
        if g["league"] not in r.get("leagues", []):
            continue
        if r.get("when") and not re.search(r["when"], (g.get("note") or "") + " " + (g.get("name") or ""), re.I):
            continue
        if r.get("weekday") is not None:
            try:
                local = dt.datetime.fromisoformat(g["start"].replace("Z", "+00:00")).astimezone(dt.timezone(dt.timedelta(hours=-4)))
                if local.weekday() not in r["weekday"]:
                    continue
                if r.get("after_hour") is not None and local.hour < r["after_hour"]:
                    continue
            except Exception:
                continue
        listen.append({
            "name": r["name"], "kind": r.get("kind", "national"), "app": r.get("app", ""), "link": r.get("link", ""),
            "lang": r.get("lang", "en"), "source": r.get("source", ""), "confidence": r.get("confidence", "unverified"),
            "checked": r.get("checked"), "note": r.get("note", ""),
        })
    for l in listen:
        l["name"] = dedup_freq(l.get("name"))
    g["listen"] = listen
    g.pop("_radio", None)


# ---------------------------------------------------------------- AI / manual overrides
def apply_overrides(games):
    ov = load(os.path.join(DATA, "ai_overrides.json"), {}) or {}
    n = 0
    for g in games:
        o = ov.get(g["id"])
        if not o:
            continue
        for w in o.get("watch", []):
            if not w.get("source_url"):
                continue  # never accept an unsourced claim
            if any(x["name"].lower() == w["name"].lower() for x in g["watch"]):
                for x in g["watch"]:
                    if x["name"].lower() == w["name"].lower() and x["confidence"] != "confirmed":
                        x.update(confidence="confirmed", source=w["source_url"], checked=w.get("checked", CHECKED), via="AI check")
                continue
            ch = classify_channel(w["name"])
            g["watch"].append({
                "name": (ch.get("label") if ch else None) or w["name"], "feed_name": w["name"], "kind": w.get("kind", "tv"),
                "market": w.get("market", "national"), "lang": w.get("lang", "en"),
                "apps": split_services(ch)[0], "bundles": split_services(ch)[1], "free_ota": bool(ch and ch.get("free_ota")),
                "source": w["source_url"], "confidence": "confirmed" if w.get("confidence") == "high" else "unverified",
                "checked": w.get("checked", CHECKED), "via": "AI check",
            })
            n += 1
        for l in o.get("listen", []):
            if not l.get("source_url"):
                continue
            if any(x["name"].lower() == l["name"].lower() for x in g["listen"]):
                continue
            g["listen"].append({"name": l["name"], "kind": l.get("kind", "national"), "app": l.get("app", ""),
                                "link": l.get("link", ""), "lang": l.get("lang", "en"), "source": l["source_url"],
                                "confidence": "confirmed" if l.get("confidence") == "high" else "unverified",
                                "checked": l.get("checked", CHECKED), "via": "AI check"})
            n += 1
        # Drop league-deal "unverified" hints once the AI found the real answer.
        if any(w.get("via") == "AI check" and w["confidence"] == "confirmed" for w in g["watch"]):
            g["watch"] = [w for w in g["watch"] if w["confidence"] != "unverified"]
    return n


# ---------------------------------------------------------------- main
def load_rights():
    r = load(os.path.join(CFG, "rights.json"), {}) or {}
    return {k: v for k, v in (r.get("leagues") or {}).items()}


def coverage(games):
    rep = {}
    for g in games:
        k = g["league_name"]
        c = rep.setdefault(k, {"group": g["group"], "league": g["league"], "games": 0, "watch_confirmed": 0,
                               "watch_any": 0, "listen_any": 0, "listen_team": 0})
        c["games"] += 1
        if any(w["confidence"] == "confirmed" for w in g["watch"]):
            c["watch_confirmed"] += 1
        if g["watch"]:
            c["watch_any"] += 1
        if g["listen"]:
            c["listen_any"] += 1
        if any(l.get("kind") == "team" for l in g["listen"]):
            c["listen_team"] += 1
    return rep


def main():
    soon = "--soon" in sys.argv
    leagues = load(os.path.join(CFG, "leagues.json"))["leagues"]
    os.makedirs(DATA, exist_ok=True)
    out_path = os.path.join(DATA, "games.json")
    prev = load(out_path, {}) or {}

    today = NOW.astimezone(dt.timezone(dt.timedelta(hours=-8))).date()  # Pacific-ish day boundary
    if soon:
        days = sorted({(NOW + dt.timedelta(hours=h)).astimezone(dt.timezone(dt.timedelta(hours=-8))).strftime("%Y%m%d") for h in (0, 6)})
    else:
        days = [(today + dt.timedelta(days=i)).strftime("%Y%m%d") for i in range(-1, 8)]
    log(f"refresh {'soon' if soon else 'full'}: {len(leagues)} leagues x {len(days)} days")

    # Source policy: ESPN + ESPN scorepanel are DEV-ONLY (undocumented API, not licensed for
    # commercial use). TheSportsDB needs a written commercial OK (GF_TSDB_OK) in release. Release
    # builds (GF_RELEASE=1) take schedules/scores ONLY from licensed providers (providers.py).
    RELEASE = os.environ.get("GF_RELEASE") == "1"
    tsdb_ok = (not RELEASE) or os.environ.get("GF_TSDB_OK") == "1"
    with ThreadPoolExecutor(3) as ex:
        f_tsdb = ex.submit(fetch_tsdb, days) if (not soon and tsdb_ok) else None
        f_panel = ex.submit(fetch_scorepanel, days) if (not soon and not RELEASE) else None
        games = [] if RELEASE else fetch_espn(leagues, days)
        log(f"  ESPN: {len(games)} events" + (" [dev-only — OFF in release]" if RELEASE else ""))
        if f_panel:
            have = {g["id"] for g in games}
            panel = [g for g in f_panel.result() if g["id"] not in have]
            log(f"  ESPN scorepanel (cricket/rugby): {len(panel)} events")
            games += panel
        if f_tsdb:
            extra = [g for g in f_tsdb.result() if g["id"] not in {x["id"] for x in games}]
            log(f"  TheSportsDB: {len(extra)} events")
            games += extra
    # Licensed providers (BALLDONTLIE etc.): the ONLY schedule/score source in release builds, and
    # also run in dev when configured (so a key can be validated before flipping GF_RELEASE on).
    # These run server-side here, never on user devices.
    try:
        import providers as _providers
        for prov in _providers.active(release=RELEASE):
            have = {g["id"] for g in games}
            pg = [g for g in prov.fetch(days) if g["id"] not in have]
            log(f"  provider {prov.name}: {len(pg)} events")
            games += pg
    except Exception as e:
        log(f"  providers error: {e}")

    # Never let a network blip blank a league: carry over last good games for any league/day that failed.
    if FAILED and prev.get("games"):
        have = {g["id"] for g in games}
        failed_leagues = {k for k, _ in FAILED}
        cutoff = (NOW - dt.timedelta(hours=4)).isoformat().replace("+00:00", "Z")
        kept = []
        for g in prev["games"]:
            if g["league"] not in failed_leagues or g["id"] in have:
                continue
            # Don't resurrect a stale not-yet-final game whose start is well in the past -
            # it has almost certainly finished, and a fresh fetch will replace it next run.
            if g.get("status") != "post" and (g.get("start") or "") < cutoff:
                continue
            g.setdefault("_raw_broadcasts", [])
            g["stale"] = True
            kept.append(g)
        games += kept
        log(f"  {len(FAILED)} league-days failed; carried over {len(kept)} games from last run")
    # Same safety net for the supplemental sources (ESPN scorepanel cricket/rugby, TheSportsDB):
    # a failed request there would otherwise silently blank those whole groups.
    if SRC_FAILED and prev.get("games"):
        have = {g["id"] for g in games}
        panel_sports = {p["sport"] for p in SCOREPANEL}
        cutoff = (NOW - dt.timedelta(hours=4)).isoformat().replace("+00:00", "Z")
        kept2 = []
        for g in prev["games"]:
            if g["id"] in have:
                continue
            is_panel = ("scorepanel" in SRC_FAILED) and (g.get("espn") in panel_sports)
            is_tsdb = ("tsdb" in SRC_FAILED) and str(g.get("id", "")).startswith("tsdb:")
            if not (is_panel or is_tsdb):
                continue
            if g.get("status") != "post" and (g.get("start") or "") < cutoff:
                continue
            g.setdefault("_raw_broadcasts", [])
            g["stale"] = True
            kept2.append(g)
        games += kept2
        if kept2:
            log(f"  source failures {sorted(SRC_FAILED)}; carried over {len(kept2)} scorepanel/TSDB games")
    rights = load_rights()
    radio = load_radio()
    for g in games:
        if g.get("stale"):
            continue
        g["_radio"] = []
        for b in list(g.get("_raw_broadcasts", [])):
            if b["kind"] == "radio":
                nm = clean_radio_name(b["name"])
                if not nm:
                    continue
                b = dict(b, name=nm)
                g["_radio"].append({"name": b["name"], "kind": "game", "market": b["market"], "lang": b.get("lang", "en"),
                                    "app": "", "link": "", "source": "ESPN scoreboard", "confidence": "confirmed", "checked": CHECKED})
        build_watch(g, rights)
        build_listen(g, radio)
        g["checked"] = CHECKED

    if soon and prev.get("games"):
        fresh = {g["id"]: g for g in games}
        merged = [fresh.pop(g["id"], g) for g in prev["games"]]
        games = merged + list(fresh.values())

    n_ai = apply_overrides(games)

    # Final normalization (catches stale carry-overs and soon-merged games too):
    # multi-network placeholders -> Network TBA; drop internal radio codes that slipped through.
    for g in games:
        for w in g.get("watch", []):
            fn = w.get("feed_name") or w.get("name", "")
            if not w.get("tba") and is_network_tba(fn):
                w.update(name="Network TBA", kind="tv", apps=[], bundles=[], free_ota=False, free=False,
                         tba=True, confidence="unverified",
                         why="channel not assigned yet - check listings closer to game time")
            elif not w.get("tba") and " / " in w.get("name", ""):
                # unresolved 2-network simulcast (e.g. carried-over "NBC / Peacock") -> first network
                first = w["name"].split(" / ")[0].strip()
                ch = classify_channel(first)
                if ch:
                    w["name"] = ch.get("label") or first
                    w["apps"], w["bundles"] = split_services(ch)
                    w["free_ota"] = bool(ch.get("free_ota")); w["free"] = bool(ch.get("free"))
        # GREEN is confirmed-only: strip any free/OTA flag off a row that isn't a per-game confirmed
        # listing, so the stored data itself never implies "free" for a guess (matches rank.js).
        for w in g.get("watch", []):
            if w.get("confidence") != "confirmed":
                w["free"] = False
                w["free_ota"] = False
        g["listen"] = [l for l in g.get("listen", [])
                       if l.get("kind") != "game" or clean_radio_name(l.get("name")) is not None]
        for l in g.get("listen", []):
            if l.get("kind") == "game":
                l["name"] = clean_radio_name(l["name"]) or l["name"]
            l["name"] = dedup_freq(l.get("name"))

    games.sort(key=lambda g: (g.get("start") or "", g["league_name"]))
    # Publish guard: never overwrite good data with a broken/empty pull (a bad fetch day, an outage).
    prev_count = int(prev.get("count") or len(prev.get("games") or []))
    if not soon and prev_count >= 100 and len(games) < 0.6 * prev_count:
        log(f"  ABORT: only {len(games)} games vs {prev_count} last run (<60%) - keeping previous data")
        return
    cov = coverage(games)
    save(out_path, {"generated": CHECKED, "mode": "soon" if soon else "full", "days": days, "count": len(games),
                    "ai_applied": n_ai, "services": SERVICES.get("services", []), "games": games})
    save(os.path.join(DATA, "coverage.json"), {"generated": CHECKED, "leagues": cov})
    # gaps = games the AI step should look at (no confirmed US watch option, or no radio)
    gaps = [{"id": g["id"], "league": g["league_name"], "name": g["name"], "start": g["start"],
             "need": [x for x, bad in (("watch", not any(w["confidence"] == "confirmed" for w in g["watch"])),
                                       ("listen", not g["listen"])) if bad],
             "have_watch": [w["name"] for w in g["watch"]]}
            for g in games if g["status"] != "post"]
    gaps = [x for x in gaps if x["need"]]
    save(os.path.join(DATA, "gaps.json"), {"generated": CHECKED, "count": len(gaps), "gaps": gaps})
    log(f"  wrote {len(games)} games, {len(gaps)} with gaps, {n_ai} AI fills applied")


if __name__ == "__main__":
    main()
