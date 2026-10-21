// Schritt 2 der Pipeline: aus den rohen YouTube-Daten (data/raw/*.json)
// nur echte Einzelfilme herausfiltern. Ausgeschlossen werden:
//   - Shorts/Clips/Teaser (per Mindestlaufzeit)
//   - Titel mit "Trailer"/"Teaser"/"Clip"
//   - Serieninhalte (Schlüsselwörter "Folge", "Staffel", "Serie",
//     "Episode", "Webserie" im Titel)
//   - kanalbezogene Regeln aus dem Profil in config/channels.json:
//       nurMitDeutschHinweis  nur Videos, deren Titel oder Beschreibung
//                             "deutsch"/"German version"/"synchron" enthält --
//                             für gemischtsprachige Kanäle (All Time Classic
//                             Movies: rund die Hälfte englisch)
//       ausschlussMuster      regulärer Ausdruck (Text), passende Titel fliegen
//                             raus -- z.B. Mehrteiler "Teil 3/4", "Himmler 1/6"
//   - sämtliche Videos von Kanälen mit "inPruefung": true im Profil
//     (config/channels.json). So sammelt der Scan bei neuen Kanälen erst
//     einmal die Rohdaten ein -- Laufzeiten, Titel, Beschreibungen --, ohne
//     dass etwas in die Bibliothek kommt. Erst nach Sichtung der echten Daten
//     wird das Profil passend gesetzt und der Schalter entfernt; beim
//     nächsten Lauf werden die Videos dann ganz normal verarbeitet.
//
// Ausgeschlossenes landet NICHT im Nirwana, sondern in data/excluded.json
// mit Begründung -- damit du das jederzeit nachvollziehen und Regeln
// nachschärfen kannst, falls mal was falsch aussortiert wird.

import fs from "fs/promises";
import path from "path";

const RAW_DIR = "data/raw";
const CHANNELS_PATH = "config/channels.json";
const OUT_CANDIDATES = "data/candidates.json";
const OUT_EXCLUDED = "data/excluded.json";

// -- Stellschrauben --
const MIN_DURATION_SECONDS = 15 * 60; // alles darunter fliegt raus (Shorts/Clips)
const PROMO_KEYWORDS = /trailer|teaser|\bclip\b/i;
// Dokumentationen: tubefilme.de führt nur Spielfilme (Entscheidung 10.10.2026).
// Muss mit DOKU_WORT in remove-documentaries.js übereinstimmen.
const DOKU_KEYWORDS = /\bdokus?\b|dokumentation|dokumentarfilm|documentary|\breportage|kriegsdoku|geschichtsdoku|musikdokument/i;
// Dokus, die es nur in der Beschreibung verraten -- und zwar, indem sie sich
// SELBST so nennen ("Diese Dokumentation zeigt ...", "In diesem
// Dokumentarfilm ...", "unserer Tierdokumentationsreihe"). Bewusst nicht jedes
// Doku-Wort: In Spielfilmen drehen Figuren oft "eine Dokumentation über ..."
// oder machen "eine Reportage", und Free Movies Deutschland schreibt in
// KI-Beschreibungen von Spielfilmen "Die Doku taucht ein ...". Gefunden am
// 13.10.2026 bei der Stichprobe der YouTube-Einträge: 47 Naturfilme, Lehrvideos
// und Geschichts-Dokus (fast alle CiNENET), dazu 4 TMDB-Einträge ("Frohes
// Schaffen", "Karl May", "Wölfe", "Vom Mammut zum Säbelzahntiger").
export const DOKU_SELBSTBESCHREIBUNG =
  /\b(?:diese[rsn]?|in\s+diese[rmn]|vorliegende[n]?|unsere[rn]?)\s+(?:[\wäöüß-]+\s+){0,2}?(?:[\wäöüß]*-)?(?:dokumentation|dokumentarfilm|naturdokumentation|tierdokumentation|videodokumentation|dokumentationsreihe)\w*/i;

// Interviews mit Darstellern (21.10.2026: "Fünf Freunde | Interview mit
// Marcus Harris | Schauspieler", 42 Minuten, stand als Spielfilm "Fünf
// Freunde" in der Bibliothek -- die Besetzung passte ja). Gesucht wird nur in
// den Titelteilen NACH dem ersten, damit "Interview mit einem Vampir", "The
// Interview" und "An Interview with God" nie getroffen werden. In einem
// späteren Teil zählt:
//   - "Interview" am Anfang oder Ende ("Interview 03", "Cast Interview")
//     -- ausgenommen "Interview mit ...", das nur zählt, wenn ein Personen-
//     name folgt ("Interview mit Marcus Harris", nicht "... mit dem Tod")
//   - "im Interview"
// Geprüft an allen 29.500 Videotiteln: kein Spielfilm getroffen.
export function istInterview(titel) {
  return (titel || "")
    .split(/\s*[|–—:]\s*|\s+-\s+/)
    .slice(1)
    .map((s) => s.trim())
    .some((s) => {
      if (/^interview mit\s/i.test(s)) return /^[Ii]nterview mit\s+[A-ZÄÖÜ][\p{Ll}.'-]+\s+[A-ZÄÖÜ]/u.test(s);
      return /^interviews?\b|\binterviews?$|\bim interview\b/i.test(s);
    });
}

const SERIES_KEYWORDS = /\bfolgen?\b|\bstaffel\b|miniserie|\bserie\b|\bepisoden?\b|\bwebserie\b/i;

function parseDuration(iso) {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  const h = parseInt(m[1] || 0, 10);
  const min = parseInt(m[2] || 0, 10);
  const s = parseInt(m[3] || 0, 10);
  return h * 3600 + min * 60 + s;
}

const DEUTSCH_HINWEIS = /deutsch|german version|synchron/i;

function classify(video, profil) {
  // Rohdaten eines Kanals, der aus config/channels.json entfernt wurde,
  // bleiben in data/raw liegen. Ohne diese Regel galten seine Videos als
  // freigegeben -- am 21.10.2026 kamen so 83 Filme des gerade entfernten
  // Kanals Bombay Nights in die Bibliothek. prune-excluded.js entfernt sie
  // rückwirkend.
  if (profil === null) {
    return { include: false, reason: "Kanal nicht (mehr) in der Kanalliste" };
  }
  const inPruefung = profil.inPruefung === true;
  if (inPruefung) {
    return { include: false, reason: "Kanal in Prüfung (noch nicht freigegeben)" };
  }
  const seconds = parseDuration(video.duration);

  if (seconds < MIN_DURATION_SECONDS) {
    return { include: false, reason: `zu kurz (${Math.round(seconds / 60)} Min)` };
  }
  if (PROMO_KEYWORDS.test(video.title)) {
    return { include: false, reason: "Trailer/Teaser/Clip im Titel" };
  }
  if (istInterview(video.title)) {
    return { include: false, reason: "Interview (kein Spielfilm)" };
  }
  if (SERIES_KEYWORDS.test(video.title)) {
    return { include: false, reason: "Serienfolge (Schlüsselwort im Titel)" };
  }
  if (DOKU_KEYWORDS.test(video.title)) {
    return { include: false, reason: "Dokumentation (Schlüsselwort im Titel)" };
  }
  if (DOKU_SELBSTBESCHREIBUNG.test((video.description || "").slice(0, 600))) {
    return { include: false, reason: "Dokumentation (beschreibt sich selbst so)" };
  }
  if (profil.ausschlussMuster && new RegExp(profil.ausschlussMuster, "i").test(video.title)) {
    return { include: false, reason: "Kanalregel: Ausschlussmuster im Titel" };
  }
  if (profil.nurMitDeutschHinweis === true && !DEUTSCH_HINWEIS.test(`${video.title} ${video.description || ""}`)) {
    return { include: false, reason: "Kanalregel: kein Hinweis auf deutsche Fassung" };
  }
  return { include: true, reason: null };
}

async function main() {
  const files = (await fs.readdir(RAW_DIR)).filter((f) => f.endsWith(".json"));

  if (files.length === 0) {
    console.log(`Keine Dateien in ${RAW_DIR} gefunden. Erst 'npm run fetch' ausführen.`);
    return;
  }

  // Kanalprofile (siehe Kopfkommentar)
  const config = JSON.parse(await fs.readFile(CHANNELS_PATH, "utf-8"));
  const profile = new Map(config.channels.map((c) => [c.channelId, c.profil || {}]));

  const candidates = [];
  const excluded = [];
  const seenVideoIds = new Set();

  for (const file of files) {
    const videos = JSON.parse(await fs.readFile(path.join(RAW_DIR, file), "utf-8"));
    for (const video of videos) {
      if (seenVideoIds.has(video.videoId)) continue; // Sicherheitsnetz gegen Duplikate
      seenVideoIds.add(video.videoId);

      const kanalId = video.channelId || path.basename(file, ".json");
      const { include, reason } = classify(video, profile.has(kanalId) ? profile.get(kanalId) : null);
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
