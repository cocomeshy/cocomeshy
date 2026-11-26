import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = resolve(ROOT, "assets");
const FONTS_DIR = resolve(ROOT, "fonts");
const CFG = JSON.parse(readFileSync(resolve(ROOT, "config.json"), "utf8"));

const b64 = (path) => readFileSync(path).toString("base64");

const FONTS = {
  sans: b64(resolve(FONTS_DIR, "sans-400.woff2")),
  "serif-i": b64(resolve(FONTS_DIR, "serif-italic.woff2")),
};
const PFP = b64(resolve(ASSETS, "pfp.jpg"));

const emoteNames = new Set([
  "cocoBirthdayToot",
  "cocoYippee",
  "cocoDecoratingTree",
  "cocoSleep",
  "cocoChristmasHat",
  "cocoFlagRainbow",
  "cocoSnow",
  "cocoPeek",
  "cocoSing",
  "cocoHeart",
  "cocoNoThoughts",
]);
for (const [, name] of CFG.day) {
  emoteNames.add(name);
}
const EMOTES = Object.fromEntries(
  [...emoteNames].map((name) => [name, b64(resolve(ASSETS, `${name}.png`))])
);

const W = 840;
const COL = 210;

const THEMES = {
  light: {
    ink: "#2B2B29",
    muted: "#86847C",
    rule: "#E4E1D8",
    tile: "#F1EFE8",
    live: "#387478",
    btn_ink: "#FBFAF6",
  },
  dark: {
    ink: "#EEECE5",
    muted: "#8F8C84",
    rule: "#2C2B28",
    tile: "#1C1C1A",
    live: "#8FB5B0",
    btn_ink: "#161614",
  },
};

const FONT_META = {
  sans: ["Sans", 400, "normal"],
  "serif-i": ["Serif", 400, "italic"],
};

const LASTFM_TTL_MS = 15_000;
const REPOS_TTL_MS = 600_000;
const MAX_ART_CACHE = 16;

let lastfmCache = null;
let lastfmInFlight = null;
let reposCache = null;
let reposInFlight = null;
const artCache = new Map();

function escapeXml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

function clip(s, n) {
  const chars = [...String(s)];
  if (chars.length <= n) return String(s);
  return chars.slice(0, n - 1).join("").trimEnd() + "…";
}

function emote(name, x, y, size) {
  const data = EMOTES[name] || EMOTES.cocoNoThoughts;
  return `<image href="data:image/png;base64,${data}" x="${x}" y="${y}" width="${size}" height="${size}"/>`;
}

function fontsCss(...keys) {
  let out = "";
  for (const k of keys) {
    const [fam, wt, st] = FONT_META[k];
    out += `@font-face{font-family:'${fam}';font-weight:${wt};font-style:${st};src:url(data:font/woff2;base64,${FONTS[k]}) format('woff2');}`;
  }
  out += ".s{font-family:'Sans',system-ui,sans-serif}.i{font-family:'Serif',Georgia,serif;font-style:italic}";
  return out;
}

function svg(h, body, style, label) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" ` +
    `viewBox="0 0 ${W} ${h}" role="img" aria-label="${escapeXml(label)}">` +
    `<style>${style}</style>${body}</svg>\n`
  );
}

function nowParts(date = new Date()) {
  const tz = CFG.timezone || "UTC";
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const map = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== "literal") map[p.type] = Number(p.value);
  }
  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour === 24 ? 0 : map.hour,
  };
}

function clock(hour) {
  const h = hour % 12 || 12;
  return `${h}${hour < 12 ? "am" : "pm"}`;
}

// mon-sun week around birthday so exact day is never exposed
function bdayWeek(birthday, year) {
  if (!birthday) return null;
  const parts = birthday.split("-").map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  const [, m, d] = parts;
  const dayMs = Date.UTC(year, m - 1, d);
  const weekday = (new Date(dayMs).getUTCDay() + 6) % 7;
  const startMs = dayMs - weekday * 86_400_000;
  return [startMs, startMs + 6 * 86_400_000];
}

function inBdayWeek(birthday, t) {
  if (!birthday) return false;
  const todayMs = Date.UTC(t.year, t.month - 1, t.day);
  for (const y of [t.year - 1, t.year, t.year + 1]) {
    const wk = bdayWeek(birthday, y);
    if (wk && todayMs >= wk[0] && todayMs <= wk[1]) return true;
  }
  return false;
}

function age(birthday, t) {
  if (!birthday) return CFG.fallback.age;
  const born = Number(birthday.split("-")[0]);
  const wk = bdayWeek(birthday, t.year);
  if (!wk || Number.isNaN(born)) return CFG.fallback.age;
  const todayMs = Date.UTC(t.year, t.month - 1, t.day);
  return String(t.year - born - (todayMs < wk[0] ? 1 : 0));
}

function status(birthday, t) {
  const md = `${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
  const here = `${clock(t.hour)} here`;
  if (inBdayWeek(birthday, t)) return ["cocoBirthdayToot", "birthday week!!"];
  if (md === "01-01") return ["cocoYippee", "happy new year"];
  if (md === "12-24" || md === "12-25" || md === "12-26") {
    return ["cocoDecoratingTree", "merry christmas"];
  }
  let name = "cocoSleep";
  let text = "probably asleep";
  for (const [start, n, txt] of CFG.day) {
    if (t.hour >= start) {
      name = n;
      text = txt;
    }
  }
  if (t.month === 12) {
    name = "cocoChristmasHat";
  } else if (t.month === 6) {
    name = "cocoFlagRainbow";
  } else if ((t.month === 1 || t.month === 2) && name !== "cocoSleep") {
    name = "cocoSnow";
  }
  return [name, `${here} · ${text}`];
}

async function fetchArt(url) {
  if (!url || url.includes("2a96cbd8b46e442fc41c2b86b821562f")) return null;
  if (artCache.has(url)) return artCache.get(url);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "cocomeshy-readme" },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const mime = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
    const data = Buffer.from(await res.arrayBuffer()).toString("base64");
    const pair = [mime, data];
    if (artCache.size >= MAX_ART_CACHE) {
      artCache.delete(artCache.keys().next().value);
    }
    artCache.set(url, pair);
    return pair;
  } catch {
    return null;
  }
}

async function fetchLastfmRaw() {
  const fb = CFG.fallback;
  const user = process.env.LASTFM_USER || CFG.lastfm_user || "";
  const key = process.env.LASTFM_API_KEY || "";
  const fallback = {
    track: fb.track,
    artist: fb.artist,
    status: "",
    live: false,
    artUrl: "",
    scrobbles: fb.scrobbles,
  };
  if (!user || !key) return fallback;

  const now = Date.now();
  if (lastfmCache && now - lastfmCache.at < LASTFM_TTL_MS) {
    return lastfmCache.data;
  }
  if (lastfmInFlight) return lastfmInFlight;

  lastfmInFlight = (async () => {
    try {
      const url =
        "https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks" +
        `&user=${encodeURIComponent(user)}&api_key=${encodeURIComponent(key)}&format=json&limit=1`;
      const res = await fetch(url, {
        headers: { "User-Agent": "cocomeshy-readme" },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return lastfmCache?.data || fallback;
      const json = await res.json();
      const data = json?.recenttracks;
      if (!data?.track) return lastfmCache?.data || fallback;
      const tr = Array.isArray(data.track) ? data.track[0] : data.track;
      const live = tr?.["@attr"]?.nowplaying === "true";
      let st = "now";
      if (!live && tr?.date?.uts) {
        const mins = Math.max(1, Math.floor((Date.now() / 1000 - Number(tr.date.uts)) / 60));
        st =
          mins < 60
            ? `${mins}m ago`
            : mins < 1440
              ? `${Math.floor(mins / 60)}h ago`
              : `${Math.floor(mins / 1440)}d ago`;
      } else if (!live) {
        st = "";
      }
      const images = Array.isArray(tr.image) ? [...tr.image].reverse() : [];
      const artUrl = images.find((i) => i?.["#text"])?.["#text"] || "";
      const total = data?.["@attr"]?.total ?? "";
      const scrobbles = /^\d+$/.test(String(total))
        ? Number(total).toLocaleString("en-US")
        : fb.scrobbles;
      const parsed = {
        track: tr.name || fb.track,
        artist: tr.artist?.["#text"] || "",
        status: st,
        live,
        artUrl,
        scrobbles,
      };
      lastfmCache = { at: Date.now(), data: parsed };
      return parsed;
    } catch {
      return lastfmCache?.data || fallback;
    } finally {
      lastfmInFlight = null;
    }
  })();

  return lastfmInFlight;
}

async function fetchGithubRepos() {
  const now = Date.now();
  if (reposCache && now - reposCache.at < REPOS_TTL_MS) {
    return reposCache.value;
  }
  if (reposInFlight) return reposInFlight;

  reposInFlight = (async () => {
    try {
      const res = await fetch(`https://api.github.com/users/${CFG.github_user}`, {
        headers: { "User-Agent": "cocomeshy-readme" },
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return reposCache?.value || CFG.fallback.repos;
      const data = await res.json();
      if (typeof data?.public_repos !== "number") {
        return reposCache?.value || CFG.fallback.repos;
      }
      const value = String(data.public_repos);
      reposCache = { at: Date.now(), value };
      return value;
    } catch {
      return reposCache?.value || CFG.fallback.repos;
    } finally {
      reposInFlight = null;
    }
  })();

  return reposInFlight;
}

function renderHero(mode, birthday, when) {
  const t = THEMES[mode];
  const h = 300;
  const size = 236;
  const x = W - size;
  const lines = CFG.headline;
  const [face, mood] = status(birthday, when);
  const moodSvg =
    `<text x="${W - 42}" y="283" text-anchor="end" class="s" font-size="14" fill="${t.muted}">${escapeXml(mood)}</text>` +
    emote(face, W - 34, 258, 34);
  const peek = emote("cocoPeek", x - 40, 150, 68);
  const body = `
<text x="0" y="34" class="s" font-size="14" fill="${t.muted}">${escapeXml(CFG.handle)}  ·  ${escapeXml(CFG.say)}</text>
<text x="0" y="112" class="s" font-size="54" fill="${t.ink}" style="letter-spacing:-0.045em">${escapeXml(lines[0])}</text>
<text x="0" y="170" class="s" font-size="54" fill="${t.ink}" style="letter-spacing:-0.045em">${escapeXml(lines[1])}</text>
<text x="0" y="230" class="i" font-size="58" fill="${t.ink}" style="letter-spacing:-0.02em">${escapeXml(CFG.headline_italic)}</text>
<text x="0" y="282" class="s" font-size="16" fill="${t.muted}">${escapeXml(CFG.subline)}</text>
<clipPath id="p"><rect x="${x}" y="14" width="${size}" height="${size}" rx="24"/></clipPath>
${peek}
<image href="data:image/jpeg;base64,${PFP}" x="${x}" y="14" width="${size}" height="${size}" clip-path="url(#p)" preserveAspectRatio="xMidYMid slice"/>
${moodSvg}
`;
  return svg(h, body, fontsCss("sans", "serif-i"), "hi, i'm coco");
}

function renderStats(mode, repos, scrobbles, years) {
  const t = THEMES[mode];
  const step = W / CFG.stats.length;
  const cols = CFG.stats.map(([rawNum, label], n) => {
    const num = rawNum
      .replace("{repos}", repos)
      .replace("{scrobbles}", scrobbles)
      .replace("{age}", years);
    const x = Math.round(n * step);
    return (
      `<text x="${x}" y="84" class="s" font-size="46" fill="${t.ink}" style="letter-spacing:-0.04em">${escapeXml(num)}</text>` +
      `<text x="${x}" y="112" class="s" font-size="14" fill="${t.muted}">${escapeXml(label)}</text>`
    );
  });
  const body = `<rect x="0" y="0" width="${W}" height="1" fill="${t.rule}"/>` + cols.join("");
  return svg(136, body, fontsCss("sans"), "numbers");
}

function renderMusic(mode, m, art) {
  const t = THEMES[mode];
  const artX = COL;
  const artY = 30;
  const sz = 76;
  let cover;
  if (art) {
    const [mime, data] = art;
    cover =
      `<clipPath id="a"><rect x="${artX}" y="${artY}" width="${sz}" height="${sz}" rx="10"/></clipPath>` +
      `<image href="data:${mime};base64,${data}" x="${artX}" y="${artY}" width="${sz}" height="${sz}" ` +
      `clip-path="url(#a)" preserveAspectRatio="xMidYMid slice"/>`;
  } else {
    cover =
      `<rect x="${artX}" y="${artY}" width="${sz}" height="${sz}" rx="10" fill="${t.tile}"/>` +
      `<circle cx="${artX + sz / 2}" cy="${artY + sz / 2}" r="22" fill="none" stroke="${t.rule}" stroke-width="1.5"/>` +
      `<circle cx="${artX + sz / 2}" cy="${artY + sz / 2}" r="4" fill="${t.rule}"/>`;
  }

  let face;
  if (m.live) {
    face = "cocoSing";
  } else if (
    m.status &&
    (m.status.endsWith("m ago") ||
      (m.status.endsWith("h ago") && Number(m.status.split("h")[0]) < 12))
  ) {
    face = "cocoHeart";
  } else {
    face = "cocoNoThoughts";
  }

  let statusSvg = "";
  if (m.status) {
    const dot = m.live
      ? `<circle cx="${W - 6}" cy="45" r="4" fill="${t.live}" class="pulse"/>`
      : "";
    const tx = m.live ? W - 18 : W;
    statusSvg = `${dot}<text x="${tx}" y="50" text-anchor="end" class="s" font-size="14" fill="${t.muted}">${escapeXml(m.status)}</text>`;
  }

  const body = `
<rect x="0" y="0" width="${W}" height="1" fill="${t.rule}"/>
<text x="0" y="50" class="s" font-size="14" fill="${t.muted}">listening</text>
${emote(face, -4, 62, 52)}
${cover}
<text x="${artX + sz + 20}" y="62" class="s" font-size="20" fill="${t.ink}" style="letter-spacing:-0.01em">${escapeXml(clip(m.track, 40))}</text>
<text x="${artX + sz + 20}" y="88" class="s" font-size="15" fill="${t.muted}">${escapeXml(clip(m.artist, 52))}</text>
${statusSvg}
`;
  const style =
    fontsCss("sans") +
    "@keyframes p{0%,100%{opacity:1}50%{opacity:.3}}.pulse{animation:p 2s ease-in-out infinite}";
  return svg(136, body, style, "listening on last.fm");
}

function sendSvg(res, body, method) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-store, max-age=0, must-revalidate");
  res.setHeader("CDN-Cache-Control", "no-store");
  res.setHeader("Vercel-CDN-Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(method === "HEAD" ? undefined : body);
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.end("method not allowed");
    return;
  }

  const url = new URL(req.url || "/", "http://localhost");
  let widget = url.searchParams.get("w") || "";
  let mode = url.searchParams.get("m") || "";

  if (!widget) {
    if (url.pathname === "/health") {
      widget = "health";
    } else {
      const m = url.pathname.match(/^\/(hero|stats|music)-(light|dark)\.svg$/);
      if (m) {
        [, widget, mode] = m;
      }
    }
  }

  if (widget === "health") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end("ok\n");
    return;
  }

  if (!["hero", "stats", "music"].includes(widget) || !THEMES[mode]) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }

  const birthday = process.env.BIRTHDAY || "";
  if (widget === "hero") {
    sendSvg(res, renderHero(mode, birthday, nowParts()), req.method);
    return;
  }
  if (widget === "stats") {
    const [repos, m] = await Promise.all([fetchGithubRepos(), fetchLastfmRaw()]);
    const years = age(birthday, nowParts());
    sendSvg(res, renderStats(mode, repos, m.scrobbles, years), req.method);
    return;
  }
  const m = await fetchLastfmRaw();
  const art = await fetchArt(m.artUrl);
  sendSvg(res, renderMusic(mode, m, art), req.method);
}
