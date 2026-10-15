"""AI gap-filler for GAME FINDER (optional step).

Reads data/gaps.json (games with no confirmed US watch option, or no radio) and asks
Claude to find where each airs/streams in the US and where to listen - WITH A SOURCE URL
for every claim. Writes data/ai_overrides.json, which refresh.py folds in on its next run.

HARD RULES mirrored in the prompt:
  - Never guess. If you can't find a published source, return nothing for that game.
  - Every listing must carry a source_url and a confidence ("high" | "low").
  - Only US availability.

Runs only if the Anthropic SDK + credentials are present. Without them it exits 0 and
the loop keeps working on feed + rights + radio data alone (listings just stay
"unverified" where the feeds were silent). Uses web search so Claude checks live pages.

  python ai_reconcile.py           # up to MAX_GAMES gaps, cheapest-first
  python ai_reconcile.py --limit 40
"""
import json, os, sys, datetime as dt

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")


def _atomic_json(path, obj):
    """Write JSON to a temp file then os.replace() it in, so a crash mid-write can't leave a
    truncated/corrupt ai_overrides.json that refresh.py would then fail to parse."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


MODEL = "claude-opus-5-5"            # current model id (see claude-api skill)
FALLBACK_MODEL = "claude-opus-4-8"
MAX_GAMES = int(os.environ.get("GF_AI_LIMIT", "60"))
CHECKED = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

TOOL = {"type": "web_search_20260209", "name": "web_search", "max_uses": 4}
TOOL_BASIC = {"type": "web_search_20250305", "name": "web_search", "max_uses": 4}

SYS = (
    "You tell a US sports fan exactly where to WATCH and LISTEN to a specific game. "
    "Use web_search to confirm against official sources (league/team 'how to watch' or 'how to listen' pages, "
    "broadcaster pages, reputable schedule sites). NEVER guess. If you cannot find a published source for a game, "
    "return an empty watch and listen list for it. Only include US availability. "
    "For every single listing include a source_url you actually saw and a confidence of 'high' (official/primary) "
    "or 'low' (secondary/indirect). Prefer the network's own streaming app name in 'name' "
    "(ESPN, Paramount+, Peacock, Fox One, Apple TV, HBO Max, Prime Video, Netflix, DAZN, etc.), "
    "or the TV channel if that's how it airs."
)

SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "listings",
        "schema": {
            "type": "object", "additionalProperties": False,
            "required": ["games"],
            "properties": {"games": {"type": "array", "items": {
                "type": "object", "additionalProperties": False,
                "required": ["id", "watch", "listen"],
                "properties": {
                    "id": {"type": "string"},
                    "watch": {"type": "array", "items": {
                        "type": "object", "additionalProperties": False,
                        "required": ["name", "kind", "lang", "source_url", "confidence"],
                        "properties": {
                            "name": {"type": "string"},
                            "kind": {"type": "string", "enum": ["tv", "stream"]},
                            "market": {"type": "string"},
                            "lang": {"type": "string", "enum": ["en", "es", "other"]},
                            "source_url": {"type": "string"},
                            "confidence": {"type": "string", "enum": ["high", "low"]}}}},
                    "listen": {"type": "array", "items": {
                        "type": "object", "additionalProperties": False,
                        "required": ["name", "kind", "lang", "source_url", "confidence"],
                        "properties": {
                            "name": {"type": "string"},
                            "kind": {"type": "string", "enum": ["national", "team", "satellite", "app"]},
                            "app": {"type": "string"},
                            "link": {"type": "string"},
                            "lang": {"type": "string", "enum": ["en", "es", "other"]},
                            "source_url": {"type": "string"},
                            "confidence": {"type": "string", "enum": ["high", "low"]}}}}}}}}}}}


def load(p, d=None):
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return d


def main():
    limit = MAX_GAMES
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])
    gaps = (load(os.path.join(DATA, "gaps.json"), {}) or {}).get("gaps", [])
    if not gaps:
        print("No gaps to fill."); return
    try:
        import anthropic
    except ImportError:
        print("anthropic SDK not installed - skipping AI step (loop still works). "
              "To enable: pip install anthropic"); return
    try:
        client = anthropic.Anthropic()  # resolves ANTHROPIC_API_KEY or an `ant auth login` profile
    except Exception as e:
        print("No Anthropic credentials - skipping AI step (loop still works):", e); return

    # cheapest first: soonest games with the most missing
    gaps = sorted(gaps, key=lambda g: g.get("start") or "")[:limit]
    overrides = load(os.path.join(DATA, "ai_overrides.json"), {}) or {}
    done = 0
    for g in gaps:
        need = ", ".join(g.get("need", []))
        prompt = (
            f"Game: {g['name']} ({g['league']}). Starts {g['start']} (UTC). "
            f"Feeds already show these TV/stream options: {g.get('have_watch') or 'none'}. "
            f"I need the US {need} option(s) that are missing. "
            "Search for where this exact game airs/streams in the US and where to listen on radio/satellite. "
            "Return only what you can confirm with a source_url."
        )
        for tool, model in ((TOOL, MODEL), (TOOL_BASIC, MODEL), (TOOL, FALLBACK_MODEL)):
            try:
                resp = client.messages.create(
                    model=model, max_tokens=2000, system=SYS,
                    tools=[tool], output_config={"format": SCHEMA, "effort": "low"},
                    messages=[{"role": "user", "content": prompt}])
                break
            except anthropic.NotFoundError:
                continue   # tool variant or model not available on this account
            except Exception as e:
                print("  error", g["id"], e); resp = None; break
        else:
            resp = None
        if not resp:
            continue
        try:
            parsed = json.loads(next(b.text for b in resp.content if b.type == "text"))
        except Exception:
            continue
        for game in parsed.get("games", []):
            gid = game.get("id") or g["id"]
            w = [x for x in game.get("watch", []) if x.get("source_url")]
            l = [x for x in game.get("listen", []) if x.get("source_url")]
            if w or l:
                overrides[g["id"]] = {"watch": w, "listen": l, "checked": CHECKED, "name": g["name"]}
                done += 1
        if done and done % 10 == 0:
            _atomic_json(os.path.join(DATA, "ai_overrides.json"), overrides)

    _atomic_json(os.path.join(DATA, "ai_overrides.json"), overrides)
    print(f"AI filled {done} of {len(gaps)} gaps -> data/ai_overrides.json "
          f"(run refresh.py to fold them in).")


if __name__ == "__main__":
    main()
