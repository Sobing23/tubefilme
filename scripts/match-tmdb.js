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
//
// KANALÜBERGREIFENDES DEDUP: Lädt derselbe Film (gleiche tmdbId) über zwei
// verschiedene Kanäle in die Bibliothek, bleibt nur der zuerst gefundene
// Eintrag in data/filme.json ("erster Kanal gewinnt"). Der zweite Fund
// landet in data/duplicates.json, damit nichts kommentarlos verschwindet.
//
// INKREMENTELL: Videos, die schon in data/filme.json, data/unmatched.json
// ODER data/duplicates.json stehen, werden nicht erneut gegen TMDB gesucht.

import fs from "fs/promises";

const BEARER_TOKEN = process.env.TMDB_BEARER_TOKEN;
const CANDIDATES_PATH = "data/candidates.json";
const MANUAL_MATCHES_PATH = "data/manual-matches.json";
const OUT_MATCHED = "data/filme.json";
const OUT_UNMATCHED = "data/unmatched.json";
const OUT_DUPLICATES = "data/duplicates.json";
const IGNORED_PATH = "data/ignored.json"; // manuell als "nicht auffindbar" markierte Videos (Review-Seite)

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

// Entfernt ein versehentlich mitgefangenes "(JAHR)" am Ende des Suchtexts --
// passiert, wenn Netzkino Originaltitel und Jahr in einer Zeile schreibt.
// "A Boy Called Sailboat (2018)" als TMDB-Suchtext ist etwas anderes als
// "A Boy Called Sailboat" mit Jahr als separatem Filter.
function stripTrailingYear(text) {
  return text.replace(/\s*\(\d{4}\)\s*$/, "").trim();
}

// Zieht die Schauspieler aus der "Mit: A; B; C"-Zeile der Beschreibung
// (72% der Videos haben eine) und die Regie aus "Regie: X" (88%). Beides
// sind starke, bisher ungenutzte Signale, um zwischen mehreren ähnlich
// betitelten TMDB-Treffern den richtigen zu finden.
function extractPeople(desc) {
  const cast = [];
  const castLine = desc.match(/^\s*Mit:\s*(.+)$/m);
  if (castLine) {
    castLine[1]
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 2 && s.length < 60)
      .forEach((s) => cast.push(s));
  }

  const directors = [];
  const dirLine = desc.match(/^\s*Regie:\s*(.+)$/m);
  if (dirLine) {
    dirLine[1]
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 2 && s.length < 60)
      .forEach((s) => directors.push(s));
  }

  return { cast: cast.slice(0, 6), directors: directors.slice(0, 3) };
}

function extractSearchInfo(video) {
  const desc = video.description || "";
  const fallbackQuery = primaryTitleSegment(video.title);
  const people = extractPeople(desc);

  let m = desc.match(/\(\s*(\d{4})\s*\)\s*[\r\n]+Originaltitel:\s*(.+?)\s*[\r\n]/);
  if (m) {
    return {
      year: m[1],
      query: stripTrailingYear(m[2].trim()),
      fallbackQuery,
      ...people,
      source: "originaltitel+jahr",
    };
  }

  m = desc.match(/Originaltitel:\s*(.+?)\s*[\r\n]/);
  if (m) {
    const contextEnd = desc.indexOf(m[0]) + 50;
    const yearMatch = desc.slice(0, contextEnd).match(/\((\d{4})\)/);
    return {
      year: yearMatch ? yearMatch[1] : null,
      query: stripTrailingYear(m[1].trim()),
      fallbackQuery,
      ...people,
      source: "originaltitel-ohne-jahr",
    };
  }

  return { year: null, query: fallbackQuery, fallbackQuery, ...people, source: "titel-fallback" };
}

// Schneidet den Video-Titel am ersten "(" ODER "|" ab, je nachdem was zuerst
// kommt -- fängt sowohl Netzkinos "Titel (GENRE ganzer Film...)" als auch
// Comfy Movies' "Titel | Ganzer Film auf Deutsch" Format ab.
function primaryTitleSegment(title) {
  const candidates = ["(", "|"]
    .map((ch) => title.indexOf(ch))
    .filter((i) => i !== -1);
  if (candidates.length === 0) return title.trim();
  return title.slice(0, Math.min(...candidates)).trim();
}

// -- Zusätzliche Such-Varianten für hartnäckige Fälle --

// "JET LI - Once Upon a Time in China & America" -> "Once Upon a Time in China & America"
// Netzkino stellt bei vielen Actionfilmen den Schauspielernamen in Großbuchstaben
// voran. Das killt die TMDB-Suche, weil der echte Titel dann nicht mehr vorne steht.
function stripActorPrefix(text) {
  const m = text.match(/^([A-ZÄÖÜ][A-ZÄÖÜ.\s]{1,40})\s+(?:ist|in|-)\s+(.+)$/);
  return m ? m[2].trim() : null;
}

// "Yi jiu si er / AT: Back to 1942" -> ["Yi jiu si er", "Back to 1942"]
// Netzkino gibt bei asiatischen Filmen manchmal Originalsprache + Alternativtitel
// getrennt durch "/" an. Der Alternativtitel (oft Englisch) ist bei TMDB meist
// deutlich eher zu finden als die romanisierte Originalsprache.
function splitSlashVariants(text) {
  if (!text.includes("/")) return [];
  return text
    .split("/")
    .map((s) => s.replace(/^\s*AT:\s*/i, "").trim())
    .filter(Boolean);
}

// Generische Füllwörter, die bei Comfy Movies nach einem "|" stehen können
// und selbst kein Suchbegriff sind (z.B. "Ganzer Film auf Deutsch").
const GENERIC_SEGMENT = /ganzer film|ganze filme|in voller l[äa]nge|kostenlos anschauen|^komplett/i;

// "Eisfieber: Eine Liebe im Schnee | Ice Castles (1978) | Ganzer Film..."
// -> ["Eisfieber: Eine Liebe im Schnee", "Ice Castles"]
// Comfy Movies schreibt bei manchen (oft älteren/US-)Filmen den echten
// englischen Originaltitel direkt hinter einem "|" -- der ist bei TMDB
// meist viel eher zu finden als der deutsche Verleihtitel davor.
function splitPipeVariants(rawTitle) {
  if (!rawTitle.includes("|")) return [];
  return rawTitle
    .split("|")
    .map((s) => stripTrailingYear(s.trim()))
    .filter((s) => s && !GENERIC_SEGMENT.test(s));
}

// "Shampoo: Das totale Liebeschaos!" -> "Shampoo"
// Niedrigste Priorität, weil ein Doppelpunkt auch mal echter Titelbestandteil
// sein kann -- wird deshalb erst probiert, wenn alles andere fehlschlägt.
function stripColonSubtitle(text) {
  if (!text) return null;
  const idx = text.indexOf(":");
  if (idx < 2) return null;
  const before = text.slice(0, idx).trim();
  return before.length >= 2 ? before : null;
}

// Baut eine deduplizierte, priorisierte Liste an Suchbegriffen aus allen
// bekannten Varianten (Originaltitel, bereinigter YouTube-Titel, und deren
// Ableitungen).
function buildQueryCandidates(info, video) {
  const candidates = [];
  const seen = new Set();
  const add = (q) => {
    if (!q) return;
    const key = q.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(q);
  };

  add(info.query);
  add(stripActorPrefix(info.query));
  splitSlashVariants(info.query).forEach(add);

  if (info.fallbackQuery) {
    add(info.fallbackQuery);
    add(stripActorPrefix(info.fallbackQuery));
    splitSlashVariants(info.fallbackQuery).forEach(add);
  }

  splitPipeVariants(video.title).forEach(add);

  // Zuletzt: Doppelpunkt-Untertitel abtrennen, niedrigste Priorität
  add(stripColonSubtitle(info.fallbackQuery));
  add(stripColonSubtitle(info.query));

  return candidates;
}

// Normalisiert einen Titel für den Exakt-Vergleich (Groß/Klein, Akzente,
// Satzzeichen spielen dabei keine Rolle).
function normalizeTitle(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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

// -- Bewertung eines einzelnen TMDB-Suchtreffers --
//
// Der frühere Ansatz nahm blind results[0] -- die Reihenfolge von TMDB
// richtet sich aber nach Popularität, nicht nach Passgenauigkeit. Dadurch
// gewannen z.B. obskure gleichnamige Kurzfilme gegen den gesuchten Spielfilm.
// Stattdessen bewerten wir JEDEN Treffer und nehmen den besten.
function scoreResult(r, query, expectedYear) {
  const nq = normalizeTitle(query);
  const nt = normalizeTitle(r.title);
  const no = normalizeTitle(r.original_title || "");
  let score = 0;
  let exactTitle = false;

  // 1. Titel
  if (nq && (nt === nq || no === nq)) {
    score += 100;
    exactTitle = true;
  } else {
    const qTokens = nq.split(" ").filter((w) => w.length > 2);
    if (qTokens.length) {
      const hay = nt + " " + no;
      const hits = qTokens.filter((w) => hay.includes(w)).length;
      score += (hits / qTokens.length) * 55;
    }
  }

  // 2. Jahr
  if (expectedYear) {
    const ry = parseInt((r.release_date || "").slice(0, 4), 10);
    if (ry) {
      const diff = Math.abs(ry - parseInt(expectedYear, 10));
      if (diff === 0) score += 45;
      else if (diff <= 1) score += 35;
      else if (diff <= 3) score += 18;
      else if (diff <= 10) score -= 12;
      else score -= 35;
    } else {
      score -= 10;
    }
  }

  // 3. Substanz des Datensatzes. Ein Film, der auf einem lizenzierten
  // Kanal ausgewertet wird, hat bei TMDB praktisch immer Bewertungen,
  // Genres und eine Beschreibung. Leere Datensätze (Festivalmitschnitte,
  // Kurzfilme, Namensdubletten) sind fast nie der gesuchte Film -- genau
  // die haben früher die falschen Treffer verursacht.
  const votes = r.vote_count || 0;
  if (votes >= 50) score += 18;
  else if (votes >= 10) score += 12;
  else if (votes >= 1) score += 5;
  else score -= 25;

  score += (r.genre_ids || []).length > 0 ? 8 : -15;
  score += (r.overview || "").trim() ? 8 : -15;
  score += Math.min(r.popularity || 0, 30) * 0.25;

  return { score, exactTitle };
}

// Holt die Besetzung eines TMDB-Films, um sie gegen die Namen aus der
// YouTube-Beschreibung abzugleichen. Wird nur bei unklaren Fällen aufgerufen.
async function fetchTmdbPeople(tmdbId) {
  const res = await fetch(`${TMDB_BASE}/movie/${tmdbId}/credits`, {
    headers: { Authorization: `Bearer ${BEARER_TOKEN}`, accept: "application/json" },
  });
  if (res.status === 429) {
    await sleep(1000);
    return fetchTmdbPeople(tmdbId);
  }
  if (!res.ok) return { cast: [], directors: [] };
  const json = await res.json();
  return {
    cast: (json.cast || []).slice(0, 15).map((c) => normalizeTitle(c.name)),
    directors: (json.crew || []).filter((c) => c.job === "Director").map((c) => normalizeTitle(c.name)),
  };
}

// Wie viele der in der Beschreibung genannten Personen tauchen bei TMDB auf?
function personOverlap(expectedNames, tmdbNames) {
  if (!expectedNames.length || !tmdbNames.length) return null;
  const hay = tmdbNames.join(" | ");
  const hits = expectedNames.filter((n) => {
    const nn = normalizeTitle(n);
    if (!nn) return false;
    if (hay.includes(nn)) return true;
    // Nachname allein zählt auch -- Netzkino schreibt Namen gelegentlich
    // mit Tippfehlern im Vornamen ("BRIAN AUSTIN FREEN")
    const last = nn.split(" ").pop();
    return last && last.length > 3 && hay.includes(last);
  }).length;
  return hits / expectedNames.length;
}

const CONFIDENT_SCORE = 140; // ab hier ist der Treffer so klar, dass wir aufhören zu suchen
const MIN_ACCEPT_SCORE = 45; // darunter lieber gar kein Treffer als ein falscher

async function findBestMatch(video) {
  const info = extractSearchInfo(video);
  const queryCandidates = buildQueryCandidates(info, video);

  let best = null; // { r, score, exactTitle, query, yearApplied }

  for (const q of queryCandidates) {
    const yearAttempts = info.year ? [true, false] : [false];

    for (const useYear of yearAttempts) {
      const results = await tmdbSearch(q, useYear ? info.year : null);
      await sleep(DELAY_MS);
      if (results.length === 0) continue;

      // ALLE Treffer bewerten, nicht nur den ersten
      for (const r of results.slice(0, 10)) {
        const { score, exactTitle } = scoreResult(r, q, info.year);
        if (!best || score > best.score) {
          best = { r, score, exactTitle, query: q, yearApplied: useYear };
        }
      }
    }

    if (best && best.score >= CONFIDENT_SCORE) break; // eindeutig, nicht weitersuchen
  }

  if (!best) {
    return { match: null, info, reason: "kein TMDB-Treffer" };
  }

  // Bei unklarer Lage: Besetzung/Regie aus der Beschreibung gegen TMDB
  // abgleichen. Das ist das stärkste verfügbare Signal und kostet nur in
  // den wenigen Zweifelsfällen einen zusätzlichen Aufruf.
  let personNote = null;
  const hasPeople = info.cast.length > 0 || info.directors.length > 0;
  if (hasPeople && best.score < CONFIDENT_SCORE) {
    const tmdbPeople = await fetchTmdbPeople(best.r.id);
    await sleep(DELAY_MS);
    const castHit = personOverlap(info.cast, tmdbPeople.cast);
    const dirHit = personOverlap(info.directors, tmdbPeople.directors);

    if ((castHit !== null && castHit >= 0.34) || (dirHit !== null && dirHit >= 0.5)) {
      best.score += 60;
      best.personConfirmed = true;
      personNote = "Besetzung/Regie stimmen mit der Videobeschreibung überein";
    } else if (castHit === 0 && dirHit === 0) {
      best.score -= 40;
      personNote = "Weder Besetzung noch Regie stimmen mit der Videobeschreibung überein -- bitte prüfen";
    }
  }

  if (best.score < MIN_ACCEPT_SCORE) {
    return {
      match: null,
      info,
      reason: `Kein ausreichend plausibler Treffer (bester Wert ${Math.round(best.score)})`,
      topCandidate: { id: best.r.id, title: best.r.title, release_date: best.r.release_date },
    };
  }

  // Konfidenz ergibt sich jetzt aus der Bewertung, nicht mehr nur aus der
  // Herkunft des Suchbegriffs.
  let confidence;
  if (best.score >= CONFIDENT_SCORE || best.personConfirmed) confidence = "hoch";
  else if (best.score >= 95) confidence = "mittel";
  else confidence = "niedrig";

  const notes = [];
  if (personNote) notes.push(personNote);
  if (info.year) {
    const ry = (best.r.release_date || "").slice(0, 4);
    if (ry && Math.abs(parseInt(ry, 10) - parseInt(info.year, 10)) > 1) {
      notes.push(`Jahr weicht ab: erwartet ${info.year}, TMDB ${ry}`);
    }
  }
  if (confidence !== "hoch") {
    notes.push(`Zuordnungswert ${Math.round(best.score)} (Suchbegriff: "${best.query}")`);
  }

  return {
    match: best.r,
    info,
    confidence,
    yearNote: notes.length ? notes.join(" · ") : null,
  };
}

async function main() {
  const candidates = JSON.parse(await fs.readFile(CANDIDATES_PATH, "utf-8"));

  let manualMatches = {};
  try {
    manualMatches = JSON.parse(await fs.readFile(MANUAL_MATCHES_PATH, "utf-8"));
  } catch {
    // Datei existiert noch nicht -- kein Problem, einfach ohne manuelle Treffer weitermachen
  }

  // Bereits verarbeitete Videos laden (egal ob erfolgreich zugeordnet, nicht
  // zugeordnet, oder als Duplikat erkannt) -- die werden NICHT erneut gegen
  // TMDB gesucht. Das spart bei jedem Lauf fast alle Requests, sobald der
  // Kanal einmal durchgescannt wurde.
  let matched = [];
  let unmatched = [];
  let duplicates = [];
  try {
    matched = JSON.parse(await fs.readFile(OUT_MATCHED, "utf-8"));
  } catch {
    // erster Lauf, noch keine Datei
  }
  try {
    unmatched = JSON.parse(await fs.readFile(OUT_UNMATCHED, "utf-8"));
  } catch {
    // erster Lauf, noch keine Datei
  }
  try {
    duplicates = JSON.parse(await fs.readFile(OUT_DUPLICATES, "utf-8"));
  } catch {
    // erster Lauf, noch keine Datei
  }

  // Videos, die über die Review-Seite explizit als "nicht auffindbar"
  // markiert wurden -- werden nie wieder automatisch versucht.
  let ignored = [];
  try {
    ignored = JSON.parse(await fs.readFile(IGNORED_PATH, "utf-8"));
  } catch {
    // Datei existiert noch nicht -- kein Problem
  }

  const alreadyProcessed = new Set([
    ...matched.map((m) => m.videoId),
    ...unmatched.map((u) => u.videoId),
    ...duplicates.map((d) => d.videoId),
    ...ignored,
  ]);

  // Welche Filme (per tmdbId) sind schon in der Bibliothek? "Erster Kanal
  // gewinnt" -- kommt derselbe Film von einem zweiten Kanal, wird er nicht
  // nochmal aufgenommen, sondern in duplicates.json vermerkt.
  const tmdbIdToChannel = new Map(matched.map((m) => [m.tmdbId, m.channelName]));

  // Manuelle Overrides IMMER zuerst anwenden -- unabhängig davon, ob das
  // Video schon (ggf. falsch) zugeordnet wurde. Ohne diesen Schritt würde
  // die Inkrementell-Logik ein bereits verarbeitetes Video nie erneut
  // anfassen, selbst wenn data/manual-matches.json inzwischen eine Korrektur
  // dafür enthält -- der eigentliche Zweck der Datei.
  const candById = new Map(candidates.map((c) => [c.videoId, c]));
  let overridesApplied = 0;

  for (const [videoId, tmdbId] of Object.entries(manualMatches)) {
    const existingIdx = matched.findIndex((m) => m.videoId === videoId);
    if (existingIdx !== -1 && matched[existingIdx].tmdbId === tmdbId) {
      continue; // schon korrekt, nichts zu tun
    }

    const video = candById.get(videoId);
    if (!video) {
      console.log(`   Hinweis: manueller Override für ${videoId} -- Video nicht in candidates.json gefunden, übersprungen.`);
      continue;
    }

    const res = await fetch(`${TMDB_BASE}/movie/${tmdbId}?language=de-DE`, {
      headers: { Authorization: `Bearer ${BEARER_TOKEN}`, accept: "application/json" },
    });
    if (!res.ok) {
      console.log(`   Hinweis: manueller Override für ${videoId} -- TMDB-ID ${tmdbId} nicht abrufbar.`);
      continue;
    }
    const movie = await res.json();

    if (existingIdx !== -1) {
      tmdbIdToChannel.delete(matched[existingIdx].tmdbId);
      matched.splice(existingIdx, 1);
    }
    const umIdx = unmatched.findIndex((u) => u.videoId === videoId);
    if (umIdx !== -1) unmatched.splice(umIdx, 1);
    const dpIdx = duplicates.findIndex((d) => d.videoId === videoId);
    if (dpIdx !== -1) duplicates.splice(dpIdx, 1);

    addResult(video, movie, "manuell", "hoch");
    alreadyProcessed.add(videoId);
    overridesApplied++;
    console.log(`   Manueller Override angewendet: "${video.title}" -> "${movie.title}"`);

    await sleep(DELAY_MS);
  }

  const newCandidates = candidates.filter((c) => !alreadyProcessed.has(c.videoId));

  console.log(
    `${candidates.length} Kandidaten insgesamt, ${alreadyProcessed.size} bereits verarbeitet, ` +
      `${newCandidates.length} neu zu prüfen. (${overridesApplied} manuelle Overrides angewendet)`
  );

  if (newCandidates.length === 0 && overridesApplied === 0) {
    console.log("Nichts Neues zu tun.");
    return;
  }

  let processed = 0;

  for (const video of newCandidates) {
    processed++;
    if (processed % 200 === 0) {
      console.log(`... ${processed} / ${newCandidates.length} verarbeitet`);
    }

    // Manuelle Overrides wurden bereits oben zentral angewendet -- an dieser
    // Stelle sind nur noch Videos, die KEINEN manuellen Override haben.

    try {
      const { match, info, reason, topCandidate, confidence, yearNote } = await findBestMatch(video);
      if (match) {
        addResult(video, match, info.source, confidence, yearNote);
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

  // Entscheidet, ob ein gefundener Treffer neu in die Bibliothek kommt
  // oder als kanalübergreifendes Duplikat markiert wird.
  function addResult(video, tmdbMovie, matchSource, matchConfidence, hinweis) {
    const existingChannel = tmdbIdToChannel.get(tmdbMovie.id);
    if (existingChannel) {
      duplicates.push({
        videoId: video.videoId,
        youtubeTitle: video.title,
        channelName: video.channelName,
        tmdbId: tmdbMovie.id,
        title: tmdbMovie.title,
        bereitsVorhandenAufKanal: existingChannel,
      });
      return;
    }
    matched.push(buildEntry(video, tmdbMovie, matchSource, matchConfidence, hinweis));
    tmdbIdToChannel.set(tmdbMovie.id, video.channelName);
  }

  await fs.writeFile(OUT_MATCHED, JSON.stringify(matched, null, 2), "utf-8");
  await fs.writeFile(OUT_UNMATCHED, JSON.stringify(unmatched, null, 2), "utf-8");
  await fs.writeFile(OUT_DUPLICATES, JSON.stringify(duplicates, null, 2), "utf-8");

  console.log(`\nGesamtstand nach diesem Lauf (${newCandidates.length} neu geprüft):`);
  console.log(`Zugeordnet:      ${matched.length}  -> ${OUT_MATCHED}`);
  console.log(`Nicht zugeordnet: ${unmatched.length}  -> ${OUT_UNMATCHED}`);
  console.log(`Duplikate (Kanal-übergreifend): ${duplicates.length}  -> ${OUT_DUPLICATES}`);

  const confidenceCounts = {};
  for (const m of matched) {
    confidenceCounts[m.matchConfidence] = (confidenceCounts[m.matchConfidence] || 0) + 1;
  }
  console.log("Konfidenz-Verteilung:", confidenceCounts);
}

function buildEntry(video, tmdbMovie, matchSource, matchConfidence, hinweis) {
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
    ...(hinweis ? { hinweis } : {}),
  };
}

main();
