#!/usr/bin/env python3
# builds the light/dark svgs for the profile readme

import base64
import html
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
FONTS = ROOT / "fonts"
CFG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
# birthday and api key never go in the repo: env vars in ci, a gitignored file locally
_priv = ROOT / ".private.json"
PRIVATE = json.loads(_priv.read_text(encoding="utf-8")) if _priv.exists() else {}
BIRTHDAY = os.environ.get("BIRTHDAY") or PRIVATE.get("birthday", "")
LASTFM_KEY = os.environ.get("LASTFM_API_KEY") or PRIVATE.get("lastfm_api_key", "")

W = 840
COL = 210  # where the right column starts, labels sit left of it

THEMES = {
    "light": {
        "ink": "#2B2B29",
        "muted": "#86847C",
        "rule": "#E4E1D8",
        "tile": "#F1EFE8",
        "live": "#387478",
        "btn_ink": "#FBFAF6",
    },
    "dark": {
        "ink": "#EEECE5",
        "muted": "#8F8C84",
        "rule": "#2C2B28",
        "tile": "#1C1C1A",
        "live": "#8FB5B0",
        "btn_ink": "#161614",
    },
}


def b64(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("ascii")


def emote(name: str, x: float, y: float, size: float) -> str:
    return (
        f'<image href="data:image/png;base64,{b64(ASSETS / f"{name}.png")}" '
        f'x="{x}" y="{y}" width="{size}" height="{size}"/>'
    )


def now() -> datetime:
    tz = ZoneInfo(CFG.get("timezone") or "UTC")
    # --at 2026-12-24T15:00 renders a specific moment, handy for checking states
    if "--at" in sys.argv:
        return datetime.fromisoformat(sys.argv[sys.argv.index("--at") + 1]).replace(tzinfo=tz)
    return datetime.now(tz)


def clock(t: datetime) -> str:
    h = t.hour % 12 or 12
    return f"{h}{'am' if t.hour < 12 else 'pm'}"


def bday_week(year: int):
    # the whole mon-sun week around the birthday, so neither the readme nor the
    # git history ever points at the exact day
    if not BIRTHDAY:
        return None
    _, m, d = (int(p) for p in BIRTHDAY.split("-"))
    day = date(year, m, d)
    start = day - timedelta(days=day.weekday())
    return start, start + timedelta(days=6)


def in_bday_week(t: datetime) -> bool:
    for y in (t.year, t.year + 1):
        week = bday_week(y)
        if week and week[0] <= t.date() <= week[1]:
            return True
    return False


def age(t: datetime) -> str:
    if not BIRTHDAY:
        return CFG["fallback"]["age"]
    born = int(BIRTHDAY.split("-")[0])
    start, _ = bday_week(t.year)
    # ticks over on the monday of the week, not the real day
    return str(t.year - born - (1 if t.date() < start else 0))


def status(t: datetime) -> tuple[str, str]:
    md = t.strftime("%m-%d")
    here = f"{clock(t)} here"
    if in_bday_week(t):
        return "cocoBirthdayToot", "birthday week!!"
    if md == "01-01":
        return "cocoYippee", "happy new year"
    if md in ("12-24", "12-25", "12-26"):
        return "cocoDecoratingTree", "merry christmas"
    name, text = "cocoSleep", "probably asleep"
    for start, n, txt in CFG["day"]:
        if t.hour >= start:
            name, text = n, txt
    # seasons only swap the face, the text still follows the clock
    if t.month == 12:
        name = "cocoChristmasHat"
    elif t.month == 6:
        name = "cocoFlagRainbow"
    elif t.month in (1, 2) and name != "cocoSleep":
        name = "cocoSnow"
    return name, f"{here} · {text}"


def fonts(*keys: str) -> str:
    table = {
        "sans": ("Sans", 400, "normal", "sans-400.woff2"),
        "sans-med": ("Sans", 500, "normal", "sans-500.woff2"),
        "serif-i": ("Serif", 400, "italic", "serif-italic.woff2"),
    }
    out = []
    for k in keys:
        fam, wt, st, f = table[k]
        out.append(
            f"@font-face{{font-family:'{fam}';font-weight:{wt};font-style:{st};"
            f"src:url(data:font/woff2;base64,{b64(FONTS / f)}) format('woff2');}}"
        )
    out.append(
        ".s{font-family:'Sans',system-ui,sans-serif}"
        ".i{font-family:'Serif',Georgia,serif;font-style:italic}"
    )
    return "".join(out)


def e(s: str) -> str:
    return html.escape(str(s), quote=True)


def wrap(text: str, width: int) -> list[str]:
    lines, cur = [], ""
    for word in text.split():
        nxt = f"{cur} {word}".strip()
        if len(nxt) > width and cur:
            lines.append(cur)
            cur = word
        else:
            cur = nxt
    if cur:
        lines.append(cur)
    return lines


def clip(s: str, n: int) -> str:
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def svg(h: int, body: str, style: str, label: str) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{h}" '
        f'viewBox="0 0 {W} {h}" role="img" aria-label="{e(label)}">'
        f"<style>{style}</style>{body}</svg>\n"
    )


def get_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "cocomeshy-readme"})
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read().decode("utf-8"))


def github_repos() -> str:
    try:
        return str(get_json(f"https://api.github.com/users/{CFG['github_user']}")["public_repos"])
    except Exception:
        return CFG["fallback"]["repos"]


def lastfm() -> dict:
    fb = CFG["fallback"]
    user = os.environ.get("LASTFM_USER") or CFG.get("lastfm_user", "")
    key = LASTFM_KEY
    base = {"track": fb["track"], "artist": fb["artist"], "status": "", "live": False,
            "art": None, "scrobbles": fb["scrobbles"]}
    if not user or not key:
        return base
    try:
        data = get_json(
            "https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks"
            f"&user={urllib.parse.quote(user)}&api_key={urllib.parse.quote(key)}&format=json&limit=1"
        )["recenttracks"]
        tr = data["track"][0] if isinstance(data["track"], list) else data["track"]
        live = tr.get("@attr", {}).get("nowplaying") == "true"
        status = "now"
        if not live:
            mins = max(1, int((time.time() - int(tr["date"]["uts"])) // 60))
            status = f"{mins}m ago" if mins < 60 else f"{mins // 60}h ago" if mins < 1440 else f"{mins // 1440}d ago"
        art = None
        url = next((i["#text"] for i in reversed(tr.get("image", [])) if i.get("#text")), "")
        # last.fm hands out a grey star placeholder when there's no cover
        if url and "2a96cbd8b46e442fc41c2b86b821562f" not in url:
            # a slow cover shouldn't take the whole row down with it
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "cocomeshy-readme"})
                with urllib.request.urlopen(req, timeout=10) as r:
                    art = (r.headers.get_content_type() or "image/jpeg", base64.b64encode(r.read()).decode())
            except Exception:
                art = None
        total = data.get("@attr", {}).get("total", "")
        return {
            "track": tr.get("name", fb["track"]),
            "artist": tr.get("artist", {}).get("#text", ""),
            "status": status,
            "live": live,
            "art": art,
            "scrobbles": f"{int(total):,}" if str(total).isdigit() else fb["scrobbles"],
        }
    except Exception:
        return base


def hero(mode: str, when: datetime) -> str:
    t = THEMES[mode]
    h = 300
    size = 236
    x = W - size
    lines = CFG["headline"]
    face, mood = status(when)
    mood_svg = (
        f'<text x="{W - 42}" y="283" text-anchor="end" class="s" font-size="14" fill="{t["muted"]}">{e(mood)}</text>'
        + emote(face, W - 34, 258, 34)
    )
    # peeks out from behind the photo, the wall in the drawing ends up hidden under it
    peek = emote("cocoPeek", x - 40, 150, 68)
    body = f"""
<text x="0" y="34" class="s" font-size="14" fill="{t['muted']}">{e(CFG['handle'])}  ·  {e(CFG['say'])}</text>
<text x="0" y="112" class="s" font-size="54" fill="{t['ink']}" style="letter-spacing:-0.045em">{e(lines[0])}</text>
<text x="0" y="170" class="s" font-size="54" fill="{t['ink']}" style="letter-spacing:-0.045em">{e(lines[1])}</text>
<text x="0" y="230" class="i" font-size="58" fill="{t['ink']}" style="letter-spacing:-0.02em">{e(CFG['headline_italic'])}</text>
<text x="0" y="282" class="s" font-size="16" fill="{t['muted']}">{e(CFG['subline'])}</text>
<clipPath id="p"><rect x="{x}" y="14" width="{size}" height="{size}" rx="24"/></clipPath>
{peek}
<image href="data:image/jpeg;base64,{b64(ASSETS / 'pfp.jpg')}" x="{x}" y="14" width="{size}" height="{size}" clip-path="url(#p)" preserveAspectRatio="xMidYMid slice"/>
{mood_svg}
"""
    return svg(h, body, fonts("sans", "serif-i"), "hi, i'm coco")


def stats(mode: str, repos: str, scrobbles: str, years: str) -> str:
    t = THEMES[mode]
    cols = []
    step = W / len(CFG["stats"])
    for n, (num, label) in enumerate(CFG["stats"]):
        num = num.replace("{repos}", repos).replace("{scrobbles}", scrobbles).replace("{age}", years)
        x = n * step
        cols.append(
            f'<text x="{x:.0f}" y="84" class="s" font-size="46" fill="{t["ink"]}" style="letter-spacing:-0.04em">{e(num)}</text>'
            f'<text x="{x:.0f}" y="112" class="s" font-size="14" fill="{t["muted"]}">{e(label)}</text>'
        )
    body = f'<rect x="0" y="0" width="{W}" height="1" fill="{t["rule"]}"/>' + "".join(cols)
    return svg(136, body, fonts("sans"), "numbers")


def about(mode: str) -> str:
    t = THEMES[mode]
    lines = wrap(CFG["about"], 56)
    h = 44 + len(lines) * 29 + 22
    rows = "".join(
        f'<text x="{COL}" y="{52 + i * 29}" class="s" font-size="20" fill="{t["ink"]}" style="letter-spacing:-0.01em">{e(l)}</text>'
        for i, l in enumerate(lines)
    )
    body = (
        f'<rect x="0" y="0" width="{W}" height="1" fill="{t["rule"]}"/>'
        f'<text x="0" y="50" class="s" font-size="14" fill="{t["muted"]}">about</text>{rows}'
    )
    return svg(h, body, fonts("sans"), "about")


def music(mode: str, m: dict) -> str:
    t = THEMES[mode]
    art_x, art_y, sz = COL, 30, 76
    if m["art"]:
        mime, data = m["art"]
        cover = (
            f'<clipPath id="a"><rect x="{art_x}" y="{art_y}" width="{sz}" height="{sz}" rx="10"/></clipPath>'
            f'<image href="data:{mime};base64,{data}" x="{art_x}" y="{art_y}" width="{sz}" height="{sz}" '
            f'clip-path="url(#a)" preserveAspectRatio="xMidYMid slice"/>'
        )
    else:
        cover = (
            f'<rect x="{art_x}" y="{art_y}" width="{sz}" height="{sz}" rx="10" fill="{t["tile"]}"/>'
            f'<circle cx="{art_x + sz / 2}" cy="{art_y + sz / 2}" r="22" fill="none" stroke="{t["rule"]}" stroke-width="1.5"/>'
            f'<circle cx="{art_x + sz / 2}" cy="{art_y + sz / 2}" r="4" fill="{t["rule"]}"/>'
        )
    # singing while something plays, holding a heart if it was recent, blank stare otherwise
    if m["live"]:
        face = "cocoSing"
    elif m["status"] and m["status"].endswith(("m ago", "h ago")) and not (
        m["status"].endswith("h ago") and int(m["status"].split("h")[0]) >= 12
    ):
        face = "cocoHeart"
    else:
        face = "cocoNoThoughts"
    status = ""
    if m["status"]:
        dot = (
            f'<circle cx="{W - 6}" cy="45" r="4" fill="{t["live"]}" class="pulse"/>'
            if m["live"] else ""
        )
        tx = W - 18 if m["live"] else W
        status = f'{dot}<text x="{tx}" y="50" text-anchor="end" class="s" font-size="14" fill="{t["muted"]}">{e(m["status"])}</text>'
    body = f"""
<rect x="0" y="0" width="{W}" height="1" fill="{t['rule']}"/>
<text x="0" y="50" class="s" font-size="14" fill="{t['muted']}">listening</text>
{emote(face, -4, 62, 52)}
{cover}
<text x="{art_x + sz + 20}" y="62" class="s" font-size="20" fill="{t['ink']}" style="letter-spacing:-0.01em">{e(clip(m['track'], 40))}</text>
<text x="{art_x + sz + 20}" y="88" class="s" font-size="15" fill="{t['muted']}">{e(clip(m['artist'], 52))}</text>
{status}
"""
    style = fonts("sans") + (
        "@keyframes p{0%,100%{opacity:1}50%{opacity:.3}}.pulse{animation:p 2s ease-in-out infinite}"
    )
    return svg(136, body, style, "listening on last.fm")


def pill(mode: str, link: dict) -> str:
    t = THEMES[mode]
    w = int(len(link["label"]) * 7.7 + 44)
    if link.get("primary"):
        shape = f'<rect x="0" y="0" width="{w}" height="40" rx="20" fill="{t["ink"]}"/>'
        ink = t["btn_ink"]
    else:
        shape = f'<rect x="0.75" y="0.75" width="{w - 1.5}" height="38.5" rx="19.25" fill="none" stroke="{t["rule"]}" stroke-width="1.5"/>'
        ink = t["ink"]
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="40" viewBox="0 0 {w} 40" '
        f'role="img" aria-label="{e(link["label"])}"><style>{fonts("sans-med")}</style>{shape}'
        f'<text x="{w / 2}" y="25" text-anchor="middle" class="s" font-weight="500" font-size="14" fill="{ink}">{e(link["label"])}</text></svg>\n'
    )


def main() -> None:
    repos = github_repos()
    m = lastfm()
    when = now()
    for mode in THEMES:
        files = {
            "hero": hero(mode, when),
            "stats": stats(mode, repos, m["scrobbles"], age(when)),
            "about": about(mode),
            "music": music(mode, m),
        }
        for link in CFG["links"]:
            files[f"link-{link['id']}"] = pill(mode, link)
        for name, content in files.items():
            (ASSETS / f"{name}-{mode}.svg").write_text(content, encoding="utf-8")
    print("built", len(list(ASSETS.glob("*.svg"))), "svgs")


if __name__ == "__main__":
    main()
