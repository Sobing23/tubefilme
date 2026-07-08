// Schritt 2 der Pipeline: aus den rohen YouTube-Daten (data/raw/*.json)
// nur echte Einzelfilme herausfiltern. Ausgeschlossen werden:
//   - Shorts/Clips/Teaser (per Mindestlaufzeit)
//   - Titel mit "Trailer"/"Teaser"/"Clip"
//   - mehrteilige Serien (per Schlüsselwort "Folge"/"Serie" im Titel)
//
// Ausgeschlossenes landet NICHT im Nirwana, sondern in data/excluded.json
// mit Begründung -- damit du das jederzeit nachvollziehen und Regeln
// nachschärfen kannst, falls mal was falsch aussortiert wird.

import fs from "fs/promises";
import path from "path";

const RAW_DIR = "data/raw";
const OUT_CANDIDATES = "data/candidates.json";
const OUT_EXCLUDED = "data/excluded.json";

// -- Stellschrauben --
const MIN_DURATION_SECONDS = 15 * 60; // alles darunter fliegt raus (Shorts/Clips)
const PROMO_KEYWORDS = /trailer|teaser|\bclip\b/i;
const SERIES_KEYWORDS = /\bfolgen?\b|\bstaffel\b|miniserie|\bserie\b/i;

function parseDuration(iso) {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  const h = parseInt(m[1] || 0, 10);
  const min = parseInt(m[2] || 0, 10);
  const s = parseInt(m[3] || 0, 10);
  return h * 3600 + min * 60 + s;
}

function classify(video) {
  const seconds = parseDuration(video.duration);

  if (seconds < MIN_DURATION_SECONDS) {
    return { include: false, reason: `zu kurz (${Math.round(seconds / 60)} Min)` };
  }
  if (PROMO_KEYWORDS.test(video.title)) {
    return { include: false, reason: "Trailer/Teaser/Clip im Titel" };
  }
  if (SERIES_KEYWORDS.test(video.title)) {
    return { include: false, reason: "Serienfolge (Schlüsselwort im Titel)" };
  }
  return { include: true, reason: null };
}

async function main() {
  const files = (await fs.readdir(RAW_DIR)).filter((f) => f.endsWith(".json"));

  if (files.length === 0) {
    console.log(`Keine Dateien in ${RAW_DIR} gefunden. Erst 'npm run fetch' ausführen.`);
    return;
  }

  const candidates = [];
  const excluded = [];

  for (const file of files) {
    const videos = JSON.parse(await fs.readFile(path.join(RAW_DIR, file), "utf-8"));
    for (const video of videos) {
      const { include, reason } = classify(video);
      if (include) {
        candidates.push(video);
      } else {
        excluded.push({ ...video, ausschlussgrund: reason });
      }
    }
  }

  await fs.writeFile(OUT_CANDIDATES, JSON.stringify(candidates, null, 2), "utf-8");
  await fs.writeFile(OUT_EXCLUDED, JSON.stringify(excluded, null, 2), "utf-8");

  console.log(`Gesamt geprüft:     ${candidates.length + excluded.length}`);
  console.log(`Filme (Kandidaten): ${candidates.length}  -> ${OUT_CANDIDATES}`);
  console.log(`Ausgeschlossen:     ${excluded.length}  -> ${OUT_EXCLUDED}`);

  const reasonCounts = {};
  for (const v of excluded) {
    const key = v.ausschlussgrund.replace(/\(\d+ Min\)/, "(...)");
    reasonCounts[key] = (reasonCounts[key] || 0) + 1;
  }
  console.log("Aufschlüsselung Ausschlüsse:", reasonCounts);
}

main();
