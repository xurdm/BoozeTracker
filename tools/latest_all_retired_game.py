#!/usr/bin/env python3
"""
latest_all_retired_game.py

Find the most recent NHL regular-season or playoff game in which EVERY skater and
goalie who played is no longer an NHL player (retired / in the minors / overseas /
otherwise not currently in the league).

------------------------------------------------------------------------------
The idea (why this is cheap enough for "normal compute")
------------------------------------------------------------------------------
A naive scan would fetch a box score for every historical game (~1,300/season for
~20+ seasons = tens of thousands of requests). Instead we invert it:

  1. Determine the set of players who are STILL NHL players ("active set").
     Definition (configurable): appeared on an NHL roster / in an NHL game within
     the last N seasons.

  2. For each active player, fetch their FULL career game log and union all the
     game IDs they ever appeared in. Call this the "disqualified" set -- every one
     of those games contains at least one still-active player, so it can never be
     an all-retired game.

  3. Walk the league schedule BACKWARD from today. The first game (most recent)
     whose ID is NOT in the disqualified set is, by definition, the latest game
     where none of the participants are still active -> the answer.

  4. Fetch that one game's box score and print every participant plus the last
     NHL season they played, to prove the result.

Cost: ~roster calls + (active players x their seasons) game-log calls + a schedule
walk that stops as soon as it finds the answer. Everything is cached on disk, so
re-runs are nearly free and the whole thing is resumable.

------------------------------------------------------------------------------
Data source
------------------------------------------------------------------------------
The modern public NHL API at https://api-web.nhle.com (no key required).
Endpoints used:
  - /v1/roster/{team}/{season}                      current rosters
  - /v1/player/{playerId}/landing                   career season list (leagues)
  - /v1/player/{playerId}/game-log/{season}/{type}  per-season game log
  - /v1/gamecenter/{gameId}/boxscore                answer game's rosters
  - /v1/schedule/{YYYY-MM-DD}                        weekly schedule (chained back)
  - /v1/standings/{YYYY-MM-DD}                       team list for a season

These endpoints are unofficial and occasionally change shape. Parsing is defensive
and each accessor is isolated so you can patch one spot if a field moves. If the
schedule chain ever dead-ends on very old seasons, use --floor-season to bound it
and the per-team fallback kicks in.

------------------------------------------------------------------------------
Caveats baked into the definitions (all tunable via CLI)
------------------------------------------------------------------------------
  * "Still an NHL player" == appeared in the last --active-seasons seasons. A player
    injured for a whole season reads as "not active"; widen the window if you care.
  * Preseason (gameType 1) and All-Star (gameType 4) games are ignored; only
    regular season (2) and playoffs (3) count.
  * "Played" == present in the box score's skater/goalie lists. A dressed backup
    goalie who never took the ice still counts as having played, matching how most
    people read the question. Use --dressed-goalies-count 0 to require TOI > 0.

Usage:
    python latest_all_retired_game.py                  # full run, sensible defaults
    python latest_all_retired_game.py --active-seasons 1
    python latest_all_retired_game.py --floor-season 20002001 --verbose
    python latest_all_retired_game.py --active-from rosters   # fast active set
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Iterable

import urllib.request
import urllib.error

API = "https://api-web.nhle.com"
STATS_API = "https://api.nhle.com/stats/rest/en"
CACHE_DIR = Path(__file__).with_name(".nhl_cache")
USER_AGENT = "latest-all-retired-game/1.0 (personal research script)"

REG = 2  # regular season gameType
PLAYOFF = 3  # playoff gameType
COUNTED_TYPES = (REG, PLAYOFF)


# --------------------------------------------------------------------------- #
# HTTP with on-disk cache, polite rate limiting, and retries
# --------------------------------------------------------------------------- #
class Client:
    def __init__(self, delay: float = 0.15, verbose: bool = False, use_cache: bool = True):
        self.delay = delay
        self.verbose = verbose
        self.use_cache = use_cache
        self._last = 0.0
        CACHE_DIR.mkdir(parents=True, exist_ok=True)

    def _cache_path(self, url: str) -> Path:
        h = hashlib.sha1(url.encode()).hexdigest()
        return CACHE_DIR / f"{h}.json"

    def get(self, url: str, allow_404: bool = False) -> Any:
        """GET url -> parsed JSON. Cached forever on disk. Returns None on 404
        when allow_404 (historical teams/dates that don't exist)."""
        cp = self._cache_path(url)
        if self.use_cache and cp.exists():
            try:
                return json.loads(cp.read_text("utf-8"))
            except json.JSONDecodeError:
                cp.unlink(missing_ok=True)  # corrupt cache entry; refetch

        for attempt in range(5):
            # polite rate limit
            wait = self.delay - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
            try:
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=30) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                if self.use_cache:
                    cp.write_text(json.dumps(data), "utf-8")
                if self.verbose:
                    print(f"  GET {url}", file=sys.stderr)
                return data
            except urllib.error.HTTPError as e:
                if e.code == 404 and allow_404:
                    if self.use_cache:
                        cp.write_text("null", "utf-8")
                    return None
                if e.code in (429, 500, 502, 503, 504):
                    time.sleep(1.5 * (attempt + 1))
                    continue
                raise
            except (urllib.error.URLError, TimeoutError):
                time.sleep(1.5 * (attempt + 1))
                continue
        raise RuntimeError(f"failed after retries: {url}")


# --------------------------------------------------------------------------- #
# Season helpers
# --------------------------------------------------------------------------- #
def season_id(start_year: int) -> str:
    """2023 -> '20232024'."""
    return f"{start_year}{start_year + 1}"


def current_season_start(today: dt.date) -> int:
    """NHL season labeled by its starting year; new season rolls over ~October."""
    return today.year if today.month >= 9 else today.year - 1


def recent_seasons(today: dt.date, n: int) -> list[str]:
    start = current_season_start(today)
    return [season_id(start - i) for i in range(n)]


# --------------------------------------------------------------------------- #
# Step 1: the "still an NHL player" set
# --------------------------------------------------------------------------- #
def team_tricodes_for_season(client: Client, season: str) -> list[str]:
    """Teams that existed in a season, via that season's final standings."""
    # standings/{season-end-date}; use a fixed in-season date (Feb 1 of end year).
    end_year = int(season[4:])
    data = client.get(f"{API}/v1/standings/{end_year}-02-01", allow_404=True)
    codes: set[str] = set()
    if data:
        for row in data.get("standings", []):
            tri = (row.get("teamAbbrev") or {}).get("default")
            if tri:
                codes.add(tri)
    if not codes:
        # fallback: full franchise list (may include defunct/relocated teams)
        rest = client.get(f"{STATS_API}/team", allow_404=True) or {}
        for t in rest.get("data", []):
            if t.get("triCode"):
                codes.add(t["triCode"])
    return sorted(codes)


def active_from_rosters(client: Client, seasons: list[str], verbose: bool) -> set[int]:
    """Active set = anyone on any team roster in the given seasons. Cheap (~32/season)."""
    active: set[int] = set()
    for season in seasons:
        for tri in team_tricodes_for_season(client, season):
            data = client.get(f"{API}/v1/roster/{tri}/{season}", allow_404=True)
            if not data:
                continue
            for group in ("forwards", "defensemen", "goalies"):
                for p in data.get(group, []):
                    if p.get("id"):
                        active.add(int(p["id"]))
        if verbose:
            print(f"  active set after {season}: {len(active)} players", file=sys.stderr)
    return active


def active_from_games(client: Client, seasons: list[str], verbose: bool,
                      dressed_goalies_count: bool) -> set[int]:
    """Active set = anyone who actually appeared in a game in the given seasons.
    More correct than rosters (catches call-ups / traded players) but pricier."""
    active: set[int] = set()
    for gid, *_ in iter_schedule_games(client, seasons_desc=seasons, verbose=verbose):
        for pid in boxscore_player_ids(client, gid, dressed_goalies_count):
            active.add(pid)
    if verbose:
        print(f"  active set from games: {len(active)} players", file=sys.stderr)
    return active


# --------------------------------------------------------------------------- #
# Step 2: disqualified games = every game any active player ever played
# --------------------------------------------------------------------------- #
def player_nhl_seasons(client: Client, pid: int) -> list[str]:
    """All NHL seasons (as '20232024') the player has regular/playoff totals for."""
    data = client.get(f"{API}/v1/player/{pid}/landing", allow_404=True)
    if not data:
        return []
    seasons: set[str] = set()
    for row in data.get("seasonTotals", []):
        if row.get("leagueAbbrev") != "NHL":
            continue
        if row.get("gameTypeId") not in COUNTED_TYPES:
            continue
        s = row.get("season")
        if s:
            seasons.add(str(s))
    return sorted(seasons)


def player_game_ids(client: Client, pid: int) -> set[int]:
    """Union of every NHL reg/playoff gameId this player ever appeared in."""
    ids: set[int] = set()
    for season in player_nhl_seasons(client, pid):
        for gtype in COUNTED_TYPES:
            data = client.get(
                f"{API}/v1/player/{pid}/game-log/{season}/{gtype}", allow_404=True
            )
            if not data:
                continue
            for g in data.get("gameLog", []):
                if g.get("gameId"):
                    ids.add(int(g["gameId"]))
    return ids


def build_disqualified_set(client: Client, active: Iterable[int], verbose: bool) -> set[int]:
    disq: set[int] = set()
    active = list(active)
    for i, pid in enumerate(active, 1):
        disq |= player_game_ids(client, pid)
        if verbose and i % 50 == 0:
            print(f"  logs {i}/{len(active)} players -> {len(disq)} games poisoned",
                  file=sys.stderr)
    return disq


# --------------------------------------------------------------------------- #
# Step 3: walk the schedule backward until we find a game not in the set
# --------------------------------------------------------------------------- #
def iter_schedule_games(client: Client, start_date: dt.date | None = None,
                        floor_season: str | None = None,
                        seasons_desc: list[str] | None = None,
                        verbose: bool = False):
    """Yield (gameId, gameDate, awayTri, homeTri, gameType) newest-first.

    Chains /v1/schedule/{date} via previousStartDate. If seasons_desc is given,
    only yields games whose season is in that list (used for building active set)."""
    if start_date is None:
        start_date = dt.date.today()
    cursor = start_date.isoformat()
    seen_dates: set[str] = set()
    season_filter = set(seasons_desc) if seasons_desc else None
    floor_year = int(floor_season[:4]) if floor_season else None

    while cursor and cursor not in seen_dates:
        seen_dates.add(cursor)
        data = client.get(f"{API}/v1/schedule/{cursor}", allow_404=True)
        if not data:
            break
        weeks = data.get("gameWeek", [])
        # collect this week's games, sorted newest-first within the week
        day_games: list[tuple] = []
        for day in weeks:
            for g in day.get("games", []):
                gtype = g.get("gameType")
                if gtype not in COUNTED_TYPES:
                    continue
                gid = g.get("id")
                gdate = g.get("gameDate") or day.get("date")
                if not gid:
                    continue
                sid = str(g.get("season") or "")
                if season_filter and sid not in season_filter:
                    continue
                if floor_year and sid and int(sid[:4]) < floor_year:
                    continue
                away = (g.get("awayTeam") or {}).get("abbrev", "?")
                home = (g.get("homeTeam") or {}).get("abbrev", "?")
                day_games.append((int(gid), gdate, away, home, gtype))
        day_games.sort(key=lambda t: (t[1], t[0]), reverse=True)
        for row in day_games:
            yield row
        # step to the previous week
        nxt = data.get("previousStartDate")
        if not nxt or nxt == cursor:
            # fall back to jumping one week earlier by date
            try:
                cursor = (dt.date.fromisoformat(cursor) - dt.timedelta(days=7)).isoformat()
            except ValueError:
                break
        else:
            cursor = nxt
        if floor_year and cursor and int(cursor[:4]) < floor_year - 1:
            break


# --------------------------------------------------------------------------- #
# Box score parsing (only used for the active-set game scan and the final answer)
# --------------------------------------------------------------------------- #
def boxscore_player_ids(client: Client, gid: int, dressed_goalies_count: bool) -> set[int]:
    data = client.get(f"{API}/v1/gamecenter/{gid}/boxscore", allow_404=True)
    ids: set[int] = set()
    if not data:
        return ids
    stats = data.get("playerByGameStats") or {}
    for side in ("awayTeam", "homeTeam"):
        team = stats.get(side) or {}
        for group in ("forwards", "defense", "goalies"):
            for p in team.get(group, []):
                pid = p.get("playerId")
                if not pid:
                    continue
                if group == "goalies" and not dressed_goalies_count:
                    toi = p.get("toi") or "0:00"
                    if toi in ("0:00", "00:00", ""):
                        continue
                ids.add(int(pid))
    return ids


def boxscore_roster(client: Client, gid: int) -> dict[str, Any]:
    """Return a structured roster for pretty printing the answer."""
    data = client.get(f"{API}/v1/gamecenter/{gid}/boxscore", allow_404=True) or {}
    stats = data.get("playerByGameStats") or {}
    out: dict[str, Any] = {"meta": data, "players": []}
    for side, side_key in (("awayTeam", "away"), ("homeTeam", "home")):
        team = stats.get(side) or {}
        tri = (data.get(side) or {}).get("abbrev", side_key)
        for group in ("forwards", "defense", "goalies"):
            for p in team.get(group, []):
                out["players"].append({
                    "playerId": p.get("playerId"),
                    "name": (p.get("name") or {}).get("default", str(p.get("playerId"))),
                    "team": tri,
                    "pos": p.get("position") or group[:1].upper(),
                })
    return out


def player_last_nhl_season(client: Client, pid: int) -> str | None:
    seasons = player_nhl_seasons(client, pid)
    return max(seasons) if seasons else None


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--active-seasons", type=int, default=2,
                    help="How many recent seasons define 'still an NHL player' (default 2).")
    ap.add_argument("--active-from", choices=["rosters", "games"], default="rosters",
                    help="Build active set from team rosters (fast) or box scores (thorough).")
    ap.add_argument("--floor-season", default="20002001",
                    help="Oldest season to bother scanning back to (default 20002001).")
    ap.add_argument("--dressed-goalies-count", type=int, choices=[0, 1], default=1,
                    help="1: a dressed backup goalie counts as having played (default). "
                         "0: require ice time.")
    ap.add_argument("--delay", type=float, default=0.15, help="Seconds between requests.")
    ap.add_argument("--no-cache", action="store_true", help="Ignore the on-disk cache.")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    client = Client(delay=args.delay, verbose=args.verbose, use_cache=not args.no_cache)
    today = dt.date.today()
    dressed = bool(args.dressed_goalies_count)

    seasons = recent_seasons(today, args.active_seasons)
    print(f"Reference 'active' seasons: {', '.join(seasons)}", file=sys.stderr)

    # Step 1 -------------------------------------------------------------
    print("Building the set of still-active NHL players...", file=sys.stderr)
    if args.active_from == "rosters":
        active = active_from_rosters(client, seasons, args.verbose)
    else:
        active = active_from_games(client, seasons, args.verbose, dressed)
    print(f"  {len(active)} players counted as currently active.", file=sys.stderr)
    if not active:
        print("ERROR: empty active set -- API shape may have changed. Try --verbose.",
              file=sys.stderr)
        return 2

    # Step 2 -------------------------------------------------------------
    print("Fetching career game logs for active players "
          "(this is the slow part; cached)...", file=sys.stderr)
    disqualified = build_disqualified_set(client, active, args.verbose)
    print(f"  {len(disqualified)} games poisoned by at least one active player.",
          file=sys.stderr)

    # Step 3 -------------------------------------------------------------
    print("Walking the schedule backward for the latest all-retired game...",
          file=sys.stderr)
    answer = None
    for gid, gdate, away, home, gtype in iter_schedule_games(
        client, start_date=today, floor_season=args.floor_season, verbose=args.verbose
    ):
        if gid in disqualified:
            continue
        # Guard against schedule/gamelog mismatches: confirm via the box score that
        # none of the *actually dressed* players are in the active set.
        played = boxscore_player_ids(client, gid, dressed)
        if played and played & active:
            continue
        if not played:
            continue  # no box score (postponed/relocated data hole) -> skip
        answer = (gid, gdate, away, home, gtype)
        break

    if not answer:
        print("No all-retired game found above the floor season. "
              "Lower --floor-season.", file=sys.stderr)
        return 1

    # Report -------------------------------------------------------------
    gid, gdate, away, home, gtype = answer
    kind = "Playoff" if gtype == PLAYOFF else "Regular season"
    print("\n" + "=" * 70)
    print(f"LATEST ALL-RETIRED GAME: {gdate}  {away} @ {home}")
    print(f"  {kind} game  |  gameId {gid}")
    print(f"  https://www.nhl.com/gamecenter/{gid}")
    print("=" * 70)
    roster = boxscore_roster(client, gid)
    rows = []
    for p in roster["players"]:
        last = player_last_nhl_season(client, p["playerId"])
        last_disp = f"{last[:4]}-{last[4:]}" if last else "?"
        rows.append((p["team"], p["pos"], p["name"], last_disp))
    rows.sort(key=lambda r: (r[0], r[1]))
    print(f"\n{'Team':6} {'Pos':4} {'Player':26} {'Last NHL season'}")
    print("-" * 60)
    for team, pos, name, last in rows:
        print(f"{team:6} {pos:4} {name:26} {last}")
    print(f"\n{len(rows)} participants, none active in {seasons[0][:4]}-"
          f"{seasons[0][4:]} or newer.")
    print("\nNote: 'active' = appeared in the last "
          f"{args.active_seasons} season(s). Adjust with --active-seasons.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
