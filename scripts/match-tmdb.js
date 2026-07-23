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

function extractSearchInfo(video) {
  const desc = video.description || "";
  const fallbackQuery = primaryTitleSegment(video.title);

  let m = desc.match(/\(\s*(\d{4})\s*\)\s*[\r\n]+Originaltitel:\s*(.+?)\s*[\r\n]/);
  if (m) {
    return {
      year: m[1],
      query: stripTrailingYear(m[2].trim()),
      fallbackQuery,
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
      source: "originaltitel-ohne-jahr",
    };
  }

  return { year: null, query: fallbackQuery, fallbackQuery, source: "titel-fallback" };
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

// Kurze, generische Ein-Wort-Anfragen (z.B. "After", "Boar", "Whiteout")
// sind bei TMDB besonders anfällig für zufällige Fehltreffer, weil die
// Textsuche bei so wenig Kontext leicht danebengreift. Längere/mehrteilige
// Anfragen sind auch bei fremdsprachigen Originaltiteln ohne Wortüberlappung
// zur deutschen TMDB-Übersetzung meistens trotzdem korrekt -- die Prüfung
// gilt deshalb NUR für die riskante Kurzform.
function isRiskyShortQuery(q) {
  const words = q.trim().split(/\s+/).filter(Boolean);
  return words.length <= 1 && q.trim().length <= 8;
}

// Für riskante Kurz-Anfragen reicht eine lockere Wortüberlappung nicht --
// "After" steckt z.B. als eigenständiges Wort in "Tangled Ever After",
// obwohl das ein komplett anderer Film ist. Deshalb hier bewusst strenger:
// nur eine EXAKTE Übereinstimmung (Titel oder Originaltitel) zählt.
function isExactTitleMatch(query, resultTitle, resultOriginalTitle) {
  const nq = normalizeTitle(query);
  return nq === normalizeTitle(resultTitle) || nq === normalizeTitle(resultOriginalTitle || "");
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
  const queryCandidates = buildQueryCandidates(info, video);

  let top = null;
  let usedQuery = null;
  let yearWasApplied = false;

  // Falls bei riskanten Kurz-Anfragen kein exakter Treffer gefunden wird,
  // merken wir uns den ersten verfügbaren als Fallback -- besser mit
  // niedriger Konfidenz behalten als riskieren, einen eigentlich richtigen
  // (aber z.B. übersetzten) Treffer komplett zu verlieren.
  let fallbackTop = null;
  let fallbackQuery = null;
  let fallbackYearApplied = false;

  candidateLoop:
  for (const q of queryCandidates) {
    const yearAttempts = info.year ? [true, false] : [false];
    for (const useYear of yearAttempts) {
      const results = await tmdbSearch(q, useYear ? info.year : null);
      await sleep(DELAY_MS);
      if (results.length === 0) continue;

      const candidateTop = results[0];

      if (isRiskyShortQuery(q)) {
        if (isExactTitleMatch(q, candidateTop.title, candidateTop.original_title)) {
          top = candidateTop;
          usedQuery = q;
          yearWasApplied = useYear;
          break candidateLoop;
        }
        if (!fallbackTop) {
          fallbackTop = candidateTop;
          fallbackQuery = q;
          fallbackYearApplied = useYear;
        }
        continue; // riskant + nicht exakt -> nächste Variante probieren
      }

      top = candidateTop;
      usedQuery = q;
      yearWasApplied = useYear;
      break candidateLoop;
    }
  }

  let forcedLowConfidence = false;
  if (!top && fallbackTop) {
    top = fallbackTop;
    usedQuery = fallbackQuery;
    yearWasApplied = fallbackYearApplied;
    forcedLowConfidence = true;
  }

  if (!top) {
    return { match: null, info, reason: "kein TMDB-Treffer" };
  }

  const usedFallbackQuery = usedQuery.toLowerCase() !== info.query.toLowerCase();

  // Jahr-Abgleich: nur relevant, wenn wir ein erwartetes Jahr haben UND es
  // nicht schon als exakter API-Filter gegriffen hat
  let yearNote = null;
  if (info.year && !yearWasApplied) {
    const resultYear = (top.release_date || "").slice(0, 4);
    const diff = resultYear ? Math.abs(parseInt(resultYear, 10) - parseInt(info.year, 10)) : null;

    if (diff === null) {
      return {
        match: null,
        info,
        reason: "TMDB-Treffer ohne Erscheinungsdatum",
        topCandidate: { id: top.id, title: top.title, release_date: top.release_date },
      };
    }

    if (diff > 3) {
      // Große Jahres-Differenz ist normalerweise ein Zeichen für einen falschen
      // Treffer -- AUSSER der gefundene Titel stimmt exakt mit unserer Suche
      // überein. Dann ist es wahrscheinlicher, dass Netzkinos Jahresangabe
      // schlicht falsch ist, als dass zwei komplett unterschiedliche Filme
      // zufällig exakt denselben Titel tragen. Ab 20 Jahren Differenz ist
      // aber auch das zu riskant (z.B. Neuverfilmungen mit identischem Titel).
      const exactTitleMatch =
        normalizeTitle(top.title) === normalizeTitle(usedQuery) ||
        normalizeTitle(top.original_title || "") === normalizeTitle(usedQuery);

      if (exactTitleMatch && diff <= 20) {
        yearNote = `Jahr weicht deutlich ab (erwartet ${info.year}, TMDB ${resultYear}), aber Titel exakt getroffen`;
      } else {
        return {
          match: null,
          info,
          reason: `Jahr weicht stark ab (erwartet ${info.year}, TMDB-Top-Treffer ${resultYear})`,
          topCandidate: { id: top.id, title: top.title, release_date: top.release_date },
        };
      }
    } else if (diff > 1) {
      yearNote = `Jahr weicht ab: erwartet ${info.year}, TMDB ${resultYear}`;
    }
  }

  let confidence =
    info.source === "originaltitel+jahr"
      ? "hoch"
      : info.source === "originaltitel-ohne-jahr"
      ? "mittel"
      : "niedrig";

  if (usedFallbackQuery || yearNote || forcedLowConfidence) confidence = "niedrig";
  if (forcedLowConfidence && !yearNote) {
    yearNote = "Kurze/generische Suchanfrage ohne exakten Titel-Treffer bei TMDB -- bitte bei Gelegenheit prüfen";
  }

  return { match: top, info, confidence, yearNote };
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

  const alreadyProcessed = new Set([
    ...matched.map((m) => m.videoId),
    ...unmatched.map((u) => u.videoId),
    ...duplicates.map((d) => d.videoId),
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
