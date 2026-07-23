// Bereinigt data/filme.json von zwei Arten historischer Altlasten, die vor
// Einführung der jeweiligen Schutzmechanismen entstanden sind:
//
//   1. Duplikate nach tmdbId, die NICHT über data/duplicates.json gelaufen
//      sind, weil sie aus der Zeit vor der Dedup-Logik in match-tmdb.js
//      stammen (z.B. "Gingerclown" 4x vom selben Kanal).
//   2. Treffer aus riskanten, kurzen Ein-Wort-Anfragen (z.B. "After"), die
//      ohne exakte Titel-Übereinstimmung zustande kamen -- vor Einführung
//      der Exakt-Prüfung in match-tmdb.js entstanden (z.B. "Rapunzel..."
//      statt des echten Films "After").
//
// Kategorie 1 wird nach data/duplicates.json verschoben (bleibt dokumentiert).
// Kategorie 2 wird NICHT entfernt (das würde auch echte, nur unüblich
// übersetzte Treffer wie "Domovoy" -> "Mein Freund, der Kobold" killen) --
// stattdessen wird die Konfidenz auf "niedrig" herabgestuft und ein Hinweis
// ergänzt, damit es im Frontend als "?"-Badge sichtbar und später gezielt
// prüfbar ist, ohne den Inhalt einfach verschwinden zu lassen.
//
// Der Schritt ist idempotent: nach der ersten Bereinigung findet er im
// Normalfall nichts mehr und ist dann ein günstiger Sicherheitsnetz-Check.

import fs from "fs/promises";

const FILME_PATH = "data/filme.json";
const CANDIDATES_PATH = "data/candidates.json";
const DUPLICATES_PATH = "data/duplicates.json";

function stripTrailingYear(text) {
  return text.replace(/\s*\(\d{4}\)\s*$/, "").trim();
}

function primaryTitleSegment(title) {
  const idxs = ["(", "|"].map((ch) => title.indexOf(ch)).filter((i) => i !== -1);
  if (idxs.length === 0) return title.trim();
  return title.slice(0, Math.min(...idxs)).trim();
}

function extractQuery(video) {
  const desc = video.description || "";
  const fallbackQuery = primaryTitleSegment(video.title);

  let m = desc.match(/\(\s*(\d{4})\s*\)\s*[\r\n]+Originaltitel:\s*(.+?)\s*[\r\n]/);
  if (m) return stripTrailingYear(m[2].trim());

  m = desc.match(/Originaltitel:\s*(.+?)\s*[\r\n]/);
  if (m) return stripTrailingYear(m[1].trim());

  return fallbackQuery;
}

function normalizeTitle(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isRiskyShortQuery(q) {
  const words = q.trim().split(/\s+/).filter(Boolean);
  return words.length <= 1 && q.trim().length <= 8;
}

function isExactTitleMatch(query, resultTitle, resultOriginalTitle) {
  const nq = normalizeTitle(query);
  return nq === normalizeTitle(resultTitle) || nq === normalizeTitle(resultOriginalTitle || "");
}

async function main() {
  const filme = JSON.parse(await fs.readFile(FILME_PATH, "utf-8"));

  let candidates = [];
  try {
    candidates = JSON.parse(await fs.readFile(CANDIDATES_PATH, "utf-8"));
  } catch {
    // ohne candidates.json kann Kategorie 2 nicht geprüft werden, Kategorie 1 läuft trotzdem
  }
  const candById = new Map(candidates.map((c) => [c.videoId, c]));

  let duplicates = [];
  try {
    duplicates = JSON.parse(await fs.readFile(DUPLICATES_PATH, "utf-8"));
  } catch {
    // erster Lauf, noch keine Datei
  }

  const keep = [];
  const seenTmdbIds = new Map(); // tmdbId -> Kanalname des behaltenen Eintrags
  let removedDuplicates = 0;
  let downgraded = 0;

  for (const m of filme) {
    // Kategorie 1: Altlast-Duplikat
    if (seenTmdbIds.has(m.tmdbId)) {
      duplicates.push({
        videoId: m.videoId,
        youtubeTitle: m.youtubeTitle,
        channelName: m.channelName,
        tmdbId: m.tmdbId,
        title: m.title,
        bereitsVorhandenAufKanal: seenTmdbIds.get(m.tmdbId),
        hinweis: "nachträglich bereinigt (Altlast vor Dedup-Einführung)",
      });
      removedDuplicates++;
      continue;
    }

    // Kategorie 2: riskante Kurz-Anfrage ohne exakte Übereinstimmung
    // -> nicht entfernen, nur auf "niedrig" herabstufen und markieren
    const cand = candById.get(m.videoId);
    if (cand && m.matchConfidence !== "niedrig") {
      const query = extractQuery(cand);
      if (isRiskyShortQuery(query) && !isExactTitleMatch(query, m.title, m.originalTitle)) {
        m.matchConfidence = "niedrig";
        m.hinweis = "Kurze/generische Suchanfrage ohne exakten Titel-Treffer bei TMDB -- bitte bei Gelegenheit prüfen";
        downgraded++;
      }
    }

    seenTmdbIds.set(m.tmdbId, m.channelName);
    keep.push(m);
  }

  await fs.writeFile(FILME_PATH, JSON.stringify(keep, null, 2), "utf-8");
  await fs.writeFile(DUPLICATES_PATH, JSON.stringify(duplicates, null, 2), "utf-8");

  console.log(`Altlast-Duplikate entfernt:                ${removedDuplicates}`);
  console.log(`Riskante Kurz-Treffer auf "niedrig" gesetzt: ${downgraded}`);
  console.log(`Verbleibend in ${FILME_PATH}: ${keep.length}`);
}

main();
