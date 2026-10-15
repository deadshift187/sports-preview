"""Coverage audit for GAME FINDER (Saint's 'make sure it's everywhere it's playing').

For every game this week it checks each dimension:
  TV, streaming, FREE/OTA, Spanish-language, team radio, national/satellite radio.
Writes data/audit.json and prints a per-league summary + the biggest gaps, honestly.

  python audit.py            # full report
  python audit.py --gaps     # only the games missing something
"""
import json, os, sys, collections

ROOT = os.path.dirname(os.path.abspath(__file__))
G = os.path.join(ROOT, "data", "games.json")


def dims(g):
    w = g.get("watch", [])
    l = g.get("listen", [])
    return {
        "tv":        any(x.get("kind") == "tv" for x in w),
        "stream":    any(x.get("kind") == "stream" for x in w),
        "free":      any(x.get("free_ota") or x.get("free") for x in w),
        "spanish":   any(x.get("lang") == "es" for x in w) or any(x.get("lang") == "es" for x in l),
        "confirmed": any(x.get("confidence") == "confirmed" for x in w),
        "radio_team": any(x.get("kind") == "team" for x in l),
        "radio_nat":  any(x.get("kind") in ("national", "satellite", "app", "game") for x in l),
    }


def main():
    gaps_only = "--gaps" in sys.argv
    data = json.load(open(G, encoding="utf-8"))
    games = data["games"]
    per_league = collections.defaultdict(lambda: collections.Counter())
    audited = []
    for g in games:
        if g.get("status") == "post":
            continue
        d = dims(g)
        lg = g["league_name"]
        per_league[lg]["games"] += 1
        for k, v in d.items():
            if v:
                per_league[lg][k] += 1
        need = []
        if not (d["tv"] or d["stream"] or d["free"]):
            need.append("no US watch option")
        elif not d["confirmed"]:
            need.append("watch unconfirmed")
        if not (d["radio_team"] or d["radio_nat"]):
            need.append("no radio")
        if need:
            audited.append({"id": g["id"], "league": lg, "name": g.get("short") or g.get("name"),
                            "start": g.get("start"), "need": need, "dims": d})

    out = {"generated": data.get("generated"), "league_summary": {}, "gaps": audited}
    for lg, c in sorted(per_league.items(), key=lambda x: -x[1]["games"]):
        out["league_summary"][lg] = dict(c)
    json.dump(out, open(os.path.join(ROOT, "data", "audit.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    if gaps_only:
        print(f"{len(audited)} upcoming games missing something:")
        for a in audited[:60]:
            print(f"  {a['league'][:22]:22s} {str(a['name'])[:28]:28s} {', '.join(a['need'])}")
        return

    print(f"{'league':26s} {'g':>3} {'TV':>3} {'str':>3} {'FREE':>4} {'ES':>3} {'rTeam':>5} {'rNat':>4}")
    tot = collections.Counter()
    for lg, c in sorted(per_league.items(), key=lambda x: -x[1]["games"]):
        print(f"{lg[:26]:26s} {c['games']:3d} {c['tv']:3d} {c['stream']:3d} {c['free']:4d} {c['spanish']:3d} {c['radio_team']:5d} {c['radio_nat']:4d}")
        for k in ("games", "tv", "stream", "free", "spanish", "radio_team", "radio_nat"):
            tot[k] += c[k]
    print("-" * 60)
    print(f"{'TOTAL':26s} {tot['games']:3d} {tot['tv']:3d} {tot['stream']:3d} {tot['free']:4d} {tot['spanish']:3d} {tot['radio_team']:5d} {tot['radio_nat']:4d}")
    print(f"\n{len(audited)} upcoming games with a gap (see data/audit.json or run: python audit.py --gaps)")


if __name__ == "__main__":
    main()
