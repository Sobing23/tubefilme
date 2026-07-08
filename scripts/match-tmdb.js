// Schritt 3 der Pipeline: für jeden Kandidaten aus data/candidates.json
// den passenden TMDB-Eintrag suchen und Metadaten (Cover, Beschreibung,
// Erscheinungsjahr, Bewertung) anhängen.
//
// Titel-Extraktion in drei Stufen (Netzkino-Beschreibungen sind zum Glück
// sehr konsistent aufgebaut):
//   1. "TITEL (JAHR)\nOriginaltitel: X"  -> Jahr + Originaltitel, beste Qualität
//   2. "Originaltitel: X" ohne direkt davorstehendes Jahr -> Jahr wird separat gesucht
//   3. Fallback: Video-Titel, alles ab der ersten Klammer abgeschnitten
//
// Unsichere/fehlende Treffer landen in data/unmatched.json statt falsch
// zugeordnet zu werden. data/manual-matches.json (videoId -> tmdbId) hat
// immer Vorrang vor der automatischen Suche.

import fs from "fs/promises";

const BEARER_TOKEN = process.env.TMDB_BEARER_TOKEN;
const CANDIDATES_PATH = "data/candidates.json";
const MANUAL_MATCHES_PATH = "data/manual-matches.json";
const OUT_MATCHED = "data/filme.json";
const OUT_UNMATCHED = "data/unmatched.json";

const TMDB_BASE = "https://api.themoviedb.org/3";
const DELAY_MS = 120; // kleine Pause zwischen Requests, um TMDB nicht zu stressen

if (!BEARER_TOKEN) {
  console.error("Fehler: TMDB_BEARER_TOKEN ist nicht gesetzt.");
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -- Titel/Jahr aus der YouTube-Beschreibung extrahieren --
function extractSearchInfo(video) {
  const desc = video.description || "";

  let m = desc.match(/\(\s*(\d{4})\s*\)\s*[\r\n]+Originaltitel:\s*(.+?)\s*[\r\n]/);
  if (m) return { year: m[1], query: m[2].trim(), source: "originaltitel+jahr" };

  m = desc.match(/Originaltitel:\s*(.+?)\s*[\r\n]/);
  if (m) {
    const contextEnd = desc.indexOf(m[0]) + 50;
    const yearMatch = desc.slice(0, contextEnd).match(/\((\d{4})\)/);
    return {
      year: yearMatch ? yearMatch[1] : null,
      query: m[1].trim(),
      source: "originaltitel-ohne-jahr",
    };
  }

  const cleaned = video.title.split("(")[0].trim();
  return { year: null, query: cleaned, source: "titel-fallback" };
}

async function tmdbSearch(query, year) {
  const params = new URLSearchParams({ query, language: "de-DE", include_adult: "false" });
  if (year) params.set("primary_release_year", year);

  const res = await fetch(`${TMDB_BASE}/search/movie?${params}`, {
    headers: { Authorization: `Bearer ${BEARER_TOKEN}`, accept: "application/json" },
  });

  if (res.status === 429) {
    await sleep(1000);
    return tmdbSearch(query, year);
  }
  if (!res.ok) {
    throw new Error(`TMDB Fehler ${res.status}: ${await res.text()}`);
  }

  const json = await res.json();
  return json.results || [];
}

async function findBestMatch(video) {
  const info = extractSearchInfo(video);

  let results = await tmdbSearch(info.query, info.year);
  let yearWasApplied = Boolean(info.year);

  // Mit Jahr nichts gefunden -> ohne Jahr nochmal versuchen
  if (results.length === 0 && info.year) {
    await sleep(DELAY_MS);
    results = await tmdbSearch(info.query, null);
    yearWasApplied = false;
  }

  if (results.length === 0) {
    return { match: null, info, reason: "kein TMDB-Treffer" };
  }

  // Wenn wir ein Jahr erwartet haben, das Ergebnis dagegen prüfen
  const top = results[0];
  if (info.year && !yearWasApplied) {
    const resultYear = (top.release_date || "").slice(0, 4);
    const diff = Math.abs(parseInt(resultYear || "0", 10) - parseInt(info.year, 10));
    if (!resultYear || diff > 1) {
      return {
        match: null,
        info,
        reason: `Jahr weicht ab (erwartet ${info.year}, TMDB-Top-Treffer ${resultYear || "?"})`,
        topCandidate: { id: top.id, title: top.title, release_date: top.release_date },
      };
    }
  }

  const confidence =
    info.source === "originaltitel+jahr"
      ? "hoch"
      : info.source === "originaltitel-ohne-jahr"
      ? "mittel"
      : "niedrig";

  return { match: top, info, confidence };
}

async function main() {
  const candidates = JSON.parse(await fs.readFile(CANDIDATES_PATH, "utf-8"));

  let manualMatches = {};
  try {
    manualMatches = JSON.parse(await fs.readFile(MANUAL_MATCHES_PATH, "utf-8"));
  } catch {
    // Datei existiert noch nicht -- kein Problem, einfach ohne manuelle Treffer weitermachen
  }

  const matched = [];
  const unmatched = [];
  let processed = 0;

  for (const video of candidates) {
    processed++;
    if (processed % 200 === 0) {
      console.log(`... ${processed} / ${candidates.length} verarbeitet`);
    }

    // Manuelle Zuordnung hat immer Vorrang
    if (manualMatches[video.videoId]) {
      const tmdbId = manualMatches[video.videoId];
      const res = await fetch(`${TMDB_BASE}/movie/${tmdbId}?language=de-DE`, {
        headers: { Authorization: `Bearer ${BEARER_TOKEN}`, accept: "application/json" },
      });
      if (res.ok) {
        const movie = await res.json();
        matched.push(buildEntry(video, movie, "manuell", "hoch"));
        continue;
      }
    }

    try {
      const { match, info, reason, topCandidate, confidence } = await findBestMatch(video);
      if (match) {
        matched.push(buildEntry(video, match, info.source, confidence));
      } else {
        unmatched.push({
          videoId: video.videoId,
          youtubeTitle: video.title,
          suchbegriff: info.query,
          erwartetesJahr: info.year,
          grund: reason,
          tmdbTopKandidat: topCandidate || null,
        });
      }
    } catch (err) {
      unmatched.push({
        videoId: video.videoId,
        youtubeTitle: video.title,
        grund: `Fehler: ${err.message}`,
      });
    }

    await sleep(DELAY_MS);
  }

  await fs.writeFile(OUT_MATCHED, JSON.stringify(matched, null, 2), "utf-8");
  await fs.writeFile(OUT_UNMATCHED, JSON.stringify(unmatched, null, 2), "utf-8");

  console.log(`\nGesamt: ${candidates.length}`);
  console.log(`Zugeordnet:      ${matched.length}  -> ${OUT_MATCHED}`);
  console.log(`Nicht zugeordnet: ${unmatched.length}  -> ${OUT_UNMATCHED}`);

  const confidenceCounts = {};
  for (const m of matched) {
    confidenceCounts[m.matchConfidence] = (confidenceCounts[m.matchConfidence] || 0) + 1;
  }
  console.log("Konfidenz-Verteilung:", confidenceCounts);
}

function buildEntry(video, tmdbMovie, matchSource, matchConfidence) {
  return {
    videoId: video.videoId,
    youtubeTitle: video.title,
    youtubeThumbnail: video.thumbnail,
    duration: video.duration,
    publishedAt: video.publishedAt,
    channelName: video.channelName,
    channelId: video.channelId,
    tmdbId: tmdbMovie.id,
    title: tmdbMovie.title,
    originalTitle: tmdbMovie.original_title,
    overview: tmdbMovie.overview,
    releaseDate: tmdbMovie.release_date || null,
    posterUrl: tmdbMovie.poster_path
      ? `https://image.tmdb.org/t/p/w500${tmdbMovie.poster_path}`
      : null,
    backdropUrl: tmdbMovie.backdrop_path
      ? `https://image.tmdb.org/t/p/w1280${tmdbMovie.backdrop_path}`
      : null,
    voteAverage: tmdbMovie.vote_average,
    genreIds: tmdbMovie.genre_ids || [],
    matchSource,
    matchConfidence,
  };
}

main();
