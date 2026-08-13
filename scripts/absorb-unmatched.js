// Übernimmt Filme, für die TMDB dauerhaft keinen brauchbaren Treffer liefert,
// mit den Metadaten aus dem YouTube-Video selbst in die Bibliothek -- statt
// sie unbegrenzt in data/unmatched.json liegen zu lassen.
//
// Hintergrund: Ein großer Teil dieser Filme ist bei TMDB schlicht nicht
// erfasst (obskure Direct-to-Video-Titel, deutsche Verleihfassungen kleiner
// Anbieter). Sie manuell nachzupflegen wäre bei mehreren hundert Filmen
// unrealistisch, und ohne Übernahme wären sie auf der Seite gar nicht
// vorhanden -- obwohl Titel, Beschreibung, Jahr, Besetzung und Regie in der
// Videobeschreibung meist sauber dastehen.
//
// Übernommene Einträge sind klar gekennzeichnet:
//   tmdbId: null, matchSource: "youtube", matchConfidence: "youtube"
// Damit sind sie im Frontend und in der Review-Seite jederzeit von echten
// TMDB-Treffern unterscheidbar und können später gezielt korrigiert werden.
//
// SCHONFRIST: Ein Film wird erst übernommen, wenn er MIN_VERSUCHE Läufe lang
// erfolglos war. So bekommen Verbesserungen an der Zuordnungslogik zuerst
// eine Chance, bevor auf die schwächeren YouTube-Daten ausgewichen wird.

import fs from "fs/promises";

const UNMATCHED_PATH = "data/unmatched.json";
const CANDIDATES_PATH = "data/candidates.json";
const FILME_PATH = "data/filme.json";
const ATTEMPTS_PATH = "data/unmatched-attempts.json";

const MIN_VERSUCHE = 2;

// Genre-Marker, die manche Kanäle in eckigen Klammern in den Titel setzen,
// auf die TMDB-Genre-IDs abbilden -- damit Genre-Filter und die Funktion
// "ähnliche Filme" auch für übernommene Einträge funktionieren.
const GENRE_MAP = {
  action: 28, abenteuer: 12, animation: 16, "komödie": 35, komoedie: 35,
  krimi: 80, dokumentation: 99, doku: 99, drama: 18, familie: 10751,
  fantasy: 14, historie: 36, horror: 27, musik: 10402, mystery: 9648,
  romantik: 10749, liebe: 10749, "sci-fi": 878, scifi: 878,
  "science fiction": 878, thriller: 53, kriegsfilm: 10752, krieg: 10752,
  western: 37, eastern: 28, tv: 10770,
};

function stripGenreBrackets(text) {
  return (text || "").replace(/\[[^\]]{1,30}\]/g, " ").replace(/\s{2,}/g, " ").trim();
}

const MARKETING_SEGMENT =
  /ganzer?\b|ganze\b|auf deutsch|kostenlos|\bin hd\b|voller länge|komplett|^mit\s|jetzt (an)?schauen/i;

function stripMarketingSuffix(title) {
  const parts = title.split(/\s*[–—|]\s+|\s+-\s+/);
  if (parts.length <= 1) return title.trim();
  const clean = [];
  for (const p of parts) {
    if (MARKETING_SEGMENT.test(p)) break;
    clean.push(p.trim());
  }
  return clean.length ? clean.join(" - ").trim() : title.trim();
}

// Baut aus dem rohen YouTube-Titel einen präsentablen Filmtitel.
function cleanTitle(rawTitle) {
  let t = stripGenreBrackets(rawTitle);
  // Qualitätsmarker wie "*HD*", "*4K*", "[HD]" entfernen
  t = t.replace(/\*\s*(HD|4K|FULL HD|UHD)\s*\*/gi, " ");
  // Klammerinhalte entfernen, die reines Beiwerk sind
  t = t.replace(/\((?:[^)]*(?:ganzer|ganze|deutsch|kostenlos|voller länge|hd|film)[^)]*)\)/gi, " ");
  // Jahresangabe in Klammern entfernen (wandert in releaseDate)
  t = t.replace(/\((19|20)\d{2}\)/g, " ");
  t = t.replace(/\s{2,}/g, " ").trim();
  t = stripMarketingSuffix(t);
  // führende Marker wie "(x) " abschneiden
  t = t.replace(/^\s*\([^)]{0,12}\)\s*/, "").trim();
  return t.replace(/\s*[-–—|*]\s*$/, "").trim();
}

function extractYear(title, desc) {
  let m = (desc || "").match(/aus dem Jahr\s+(\d{4})/i);
  if (m) return m[1];
  m = (title || "").match(/\((19|20)(\d{2})\)/);
  if (!m) return null;
  const jahr = parseInt(m[1] + m[2], 10);
  const aktuell = new Date().getFullYear();
  return jahr >= 1900 && jahr <= aktuell + 1 ? String(jahr) : null;
}

function extractGenreIds(rawTitle) {
  const ids = new Set();
  const marker = (rawTitle || "").match(/\[([^\]]{1,30})\]/g) || [];
  marker.forEach((mk) => {
    const wort = mk.slice(1, -1).trim().toLowerCase();
    if (GENRE_MAP[wort]) ids.add(GENRE_MAP[wort]);
  });
  return [...ids];
}

// Entfernt Klammer-Zusätze aus einer Besetzungszeile, BEVOR an Kommata
// getrennt wird. Manche Kanäle nennen zu jedem Darsteller seine bekanntesten
// Filme: "Mit: Odessa Young (The Professor, Shirley), Abra (Abra: Fruit)".
// Ohne diese Bereinigung zerfiele das beim Trennen zu unbrauchbaren
// Bruchstücken wie "Odessa Young (The Professor" und "Shirley)".
function stripKlammerZusaetze(zeile) {
  return (zeile || "").replace(/\([^)]*\)/g, " ").replace(/\s{2,}/g, " ").trim();
}

function extractPeople(desc) {
  const cast = [];
  const directors = [];

  // Netzkino schreibt beides in eine Zeile, getrennt durch einen Strich:
  //   "Mit: Kim Little, Clint Browning | Regie: Adam Silver"
  // Ohne Behandlung des Strichs landete "| Regie: ..." im Besetzungsfeld.
  const castLine = (desc || "").match(/^\s*(?:Mit|Darsteller):\s*(.+)$/m);
  if (castLine) {
    const [castTeil, ...rest] = stripKlammerZusaetze(castLine[1]).split(/\s*\|\s*/);
    castTeil
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 2 && s.length < 60)
      .forEach((s) => cast.push(s));

    const regieImRest = rest.join(" | ").match(/Regie:\s*(.+)$/i);
    if (regieImRest) {
      regieImRest[1]
        .split(/[;,]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 2 && s.length < 60)
        .forEach((s) => directors.push(s));
    }
  }

  // Eigenständige Regie-Zeile (andere Kanäle)
  const dirLine = (desc || "").match(/^\s*Regie:\s*(.+)$/m);
  if (dirLine && directors.length === 0) {
    dirLine[1]
      .split(/[;,|]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 2 && s.length < 60)
      .forEach((s) => directors.push(s));
  }

  return { cast: cast.slice(0, 5), directors: directors.slice(0, 3) };
}

// Sucht in der Beschreibung den eigentlichen Inhaltstext und wirft
// Abo-Aufrufe, Links, Hashtags und Marketing-Blöcke weg.
function extractOverview(desc) {
  if (!desc) return "";

  // Klar gekennzeichnete Inhaltsangabe hat Vorrang
  const markiert = desc.match(/(?:INHALTSANGABE|Inhaltsangabe|Handlung)\s*:?\s*\n+([\s\S]{60,900}?)(?:\n\s*\n|$)/);
  if (markiert) return saubereAbsatz(markiert[1]);

  const zeilen = desc
    .split(/\n+/)
    .map((z) => z.trim())
    .filter(Boolean)
    .filter((z) => !/https?:\/\//i.test(z))
    .filter((z) => !/^[#•▬►★☆–—-]/.test(z))
    .filter((z) => !/^(Cast & Crew|Highlights|Regie:|Darsteller:|Mit:|FSK:|Frage an die Community|Filmname:|Originalname Film:|Originaltitel:|Filmlänge:)/i.test(z))
    .filter((z) => !/abonnier|kanal abonnieren|like da|kommentare|jetzt anschauen|impressum/i.test(z));

  // Längste zusammenhängende Zeile ist praktisch immer die Inhaltsangabe
  const kandidat = zeilen.filter((z) => z.length >= 80).sort((a, b) => b.length - a.length)[0];
  return kandidat ? saubereAbsatz(kandidat) : "";
}

function saubereAbsatz(text) {
  return text
    .replace(/^[^A-Za-zÄÖÜäöüß0-9"„]+/, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 900);
}

async function main() {
  let unmatched = [];
  try {
    unmatched = JSON.parse(await fs.readFile(UNMATCHED_PATH, "utf-8"));
  } catch {
    console.log("Keine unmatched.json vorhanden, nichts zu tun.");
    return;
  }

  if (unmatched.length === 0) {
    console.log("unmatched.json ist leer, nichts zu tun.");
    return;
  }

  const candidates = JSON.parse(await fs.readFile(CANDIDATES_PATH, "utf-8"));
  const filme = JSON.parse(await fs.readFile(FILME_PATH, "utf-8"));
  const candById = new Map(candidates.map((c) => [c.videoId, c]));

  let attempts = {};
  try {
    attempts = JSON.parse(await fs.readFile(ATTEMPTS_PATH, "utf-8"));
  } catch {
    // erster Lauf
  }

  const bleibtUnmatched = [];
  let uebernommen = 0;
  let wartet = 0;
  let ohneDaten = 0;

  for (const eintrag of unmatched) {
    const videoId = eintrag.videoId;
    attempts[videoId] = (attempts[videoId] || 0) + 1;

    if (attempts[videoId] < MIN_VERSUCHE) {
      bleibtUnmatched.push(eintrag);
      wartet++;
      continue;
    }

    const video = candById.get(videoId);
    if (!video) {
      bleibtUnmatched.push(eintrag);
      continue;
    }

    const titel = cleanTitle(video.title);
    const overview = extractOverview(video.description);

    // Ohne verwertbaren Titel bringt eine Übernahme nichts
    if (!titel || titel.length < 2) {
      bleibtUnmatched.push(eintrag);
      ohneDaten++;
      continue;
    }

    const jahr = extractYear(video.title, video.description);
    const { cast, directors } = extractPeople(video.description);

    filme.push({
      videoId: video.videoId,
      youtubeTitle: video.title,
      youtubeThumbnail: video.thumbnail,
      duration: video.duration,
      publishedAt: video.publishedAt,
      channelName: video.channelName,
      channelId: video.channelId,
      tmdbId: null,
      title: titel,
      originalTitle: null,
      overview,
      releaseDate: jahr ? `${jahr}-01-01` : null,
      posterUrl: null, // kein TMDB-Poster -- Frontend nutzt das YouTube-Vorschaubild
      backdropUrl: null,
      voteAverage: null,
      genreIds: extractGenreIds(video.title),
      matchSource: "youtube",
      matchConfidence: "youtube",
      hinweis: "Aus den YouTube-Angaben übernommen -- bei TMDB nicht gefunden",
      // explizit setzen, damit fetch-cast.js und fetch-fsk.js diese Einträge
      // überspringen (sie haben keine tmdbId zum Nachschlagen)
      cast,
      director: directors,
      writer: [],
      fsk: null,
    });

    delete attempts[videoId];
    uebernommen++;
  }

  await fs.writeFile(FILME_PATH, JSON.stringify(filme, null, 2), "utf-8");
  await fs.writeFile(UNMATCHED_PATH, JSON.stringify(bleibtUnmatched, null, 2), "utf-8");
  await fs.writeFile(ATTEMPTS_PATH, JSON.stringify(attempts, null, 2), "utf-8");

  console.log(`Aus YouTube-Daten übernommen:        ${uebernommen}`);
  console.log(`Wartet noch (Schonfrist ${MIN_VERSUCHE} Läufe): ${wartet}`);
  console.log(`Kein verwertbarer Titel:             ${ohneDaten}`);
  console.log(`Verbleibend in ${UNMATCHED_PATH}:    ${bleibtUnmatched.length}`);
  console.log(`Bibliothek jetzt:                    ${filme.length}`);
}

main();
