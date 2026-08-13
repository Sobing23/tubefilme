// Prüft unsichere Zuordnungen automatisch nach, statt sie in einer
// Warteschlange zur manuellen Sichtung liegen zu lassen.
//
// Der Trick: die Besetzung des zugeordneten TMDB-Films steht bereits in
// data/filme.json (von fetch-cast.js ergänzt), und die Besetzung laut
// YouTube steht in der Videobeschreibung bzw. im Videotitel. Beides lässt
// sich gegeneinander halten, ohne TMDB erneut zu befragen -- der Schritt
// kostet also keine API-Aufrufe und läuft in Sekunden.
//
// Ergebnis pro Film:
//   bestätigt    -> Konfidenz auf "hoch", Hinweis entfernt, raus aus der Liste
//   widerlegt    -> Zuordnung verworfen, Film zurück nach unmatched.json
//                   (wird beim nächsten Lauf neu gesucht oder aus den
//                    YouTube-Daten übernommen)
//   nicht prüfbar-> bleibt unverändert, wird aber als gesichtet vermerkt,
//                   damit die Review-Seite nicht dauerhaft dieselben
//                   nicht entscheidbaren Fälle anzeigt

import fs from "fs/promises";

const FILME_PATH = "data/filme.json";
const UNMATCHED_PATH = "data/unmatched.json";
const REVIEWED_PATH = "data/reviewed.json";
const CANDIDATES_PATH = "data/candidates.json";

function normalizeName(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Erwartete Personen aus Videobeschreibung UND Videotitel zusammentragen
// Entfernt Klammer-Zusätze aus einer Besetzungszeile, BEVOR an Kommata
// getrennt wird. Manche Kanäle nennen zu jedem Darsteller seine bekanntesten
// Filme: "Mit: Odessa Young (The Professor, Shirley), Abra (Abra: Fruit)".
// Ohne diese Bereinigung zerfiele das beim Trennen zu unbrauchbaren
// Bruchstücken wie "Odessa Young (The Professor" und "Shirley)".
function stripKlammerZusaetze(zeile) {
  return (zeile || "").replace(/\([^)]*\)/g, " ").replace(/\s{2,}/g, " ").trim();
}

function erwartetePersonen(youtubeTitle, desc) {
  const namen = [];

  // "Mit: A, B | Regie: C" bzw. "Darsteller: A, B"
  const castLine = (desc || "").match(/^\s*(?:Mit|Darsteller):\s*(.+)$/m);
  if (castLine) {
    stripKlammerZusaetze(castLine[1])
      .split(/\s*\|\s*/)[0]
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 2 && s.length < 60)
      .forEach((s) => namen.push(s));
  }

  const titleCast = (youtubeTitle || "").match(/\bmit\s+([^,–—(|]{4,70})/i);
  if (titleCast) {
    titleCast[1]
      .split(/\s*&\s*|\s+und\s+/i)
      .map((s) => s.replace(/^[A-ZÄÖÜ0-9]+-Star\s+/i, "").trim())
      .filter((s) => /^[A-ZÄÖÜ][\wäöüß.'-]*\s+[A-ZÄÖÜ]/.test(s))
      .forEach((s) => namen.push(s));
  }

  return namen.slice(0, 6);
}

function namenTreffer(erwartet, vorhanden) {
  if (!erwartet.length || !vorhanden.length) return null;
  const heuhaufen = vorhanden.map(normalizeName).join(" | ");
  const treffer = erwartet.filter((n) => {
    const nn = normalizeName(n);
    if (!nn) return false;
    if (heuhaufen.includes(nn)) return true;
    const nachname = nn.split(" ").pop();
    return nachname && nachname.length > 3 && heuhaufen.includes(nachname);
  }).length;
  return treffer / erwartet.length;
}

async function main() {
  const filme = JSON.parse(await fs.readFile(FILME_PATH, "utf-8"));

  // Die Videobeschreibungen liegen in candidates.json -- dort stehen die
  // Besetzungsangaben, gegen die wir prüfen.
  let candidates = [];
  try {
    candidates = JSON.parse(await fs.readFile(CANDIDATES_PATH, "utf-8"));
  } catch {
    // ohne Kandidaten kann nur der Titel geprüft werden
  }
  const candById = new Map(candidates.map((c) => [c.videoId, c]));

  let unmatched = [];
  try {
    unmatched = JSON.parse(await fs.readFile(UNMATCHED_PATH, "utf-8"));
  } catch {
    // noch keine Datei
  }

  let reviewed = [];
  try {
    reviewed = JSON.parse(await fs.readFile(REVIEWED_PATH, "utf-8"));
  } catch {
    // noch keine Datei
  }
  const reviewedSet = new Set(reviewed);

  const behalten = [];
  let bestaetigt = 0;
  let widerlegt = 0;
  let nichtPruefbar = 0;

  for (const m of filme) {
    // Nur unsichere, automatisch entstandene Zuordnungen anfassen.
    // Manuelle Korrekturen und aus YouTube übernommene Einträge bleiben tabu.
    const istUnsicher = m.matchConfidence === "niedrig" || m.matchConfidence === "mittel";
    if (!istUnsicher || m.matchSource === "manuell" || m.matchSource === "youtube") {
      behalten.push(m);
      continue;
    }

    const kandidat = candById.get(m.videoId);
    const erwartet = erwartetePersonen(m.youtubeTitle, kandidat ? kandidat.description : "");
    const quote = namenTreffer(erwartet, m.cast || []);

    if (quote !== null && quote >= 0.34) {
      m.matchConfidence = "hoch";
      delete m.hinweis;
      behalten.push(m);
      bestaetigt++;
      continue;
    }

    // Verwerfen nur bei belastbarer Datenlage: Wir speichern pro Film nur
    // fünf Hauptdarsteller. Nennt die Videobeschreibung Nebendarsteller,
    // sieht das fälschlich nach Widerspruch aus. Deshalb wird nur verworfen,
    // wenn MEHRERE erwartete Namen vorliegen UND die TMDB-Besetzung
    // ausreichend gefüllt ist -- und selbst dann keiner passt.
    const belastbar = erwartet.length >= 2 && (m.cast || []).length >= 3;
    if (quote === 0 && belastbar) {
      unmatched.push({
        videoId: m.videoId,
        youtubeTitle: m.youtubeTitle,
        suchbegriff: m.title,
        erwartetesJahr: (m.releaseDate || "").slice(0, 4) || null,
        grund: `Automatisch verworfen: keiner der genannten Darsteller (${erwartet.slice(0, 3).join(", ")}) kommt in "${m.title}" vor`,
        tmdbTopKandidat: { id: m.tmdbId, title: m.title, release_date: m.releaseDate },
      });
      widerlegt++;
      continue;
    }

    // Alles andere ist nicht sicher entscheidbar. Der Eintrag bleibt
    // unverändert in der Bibliothek (im Frontend weiterhin am "?" erkennbar),
    // wird aber als gesichtet vermerkt, damit die Review-Warteschlange nicht
    // dauerhaft mit nicht entscheidbaren Fällen verstopft ist.
    behalten.push(m);
    if (!reviewedSet.has(m.videoId)) {
      reviewedSet.add(m.videoId);
      nichtPruefbar++;
    }
  }

  await fs.writeFile(FILME_PATH, JSON.stringify(behalten, null, 2), "utf-8");
  await fs.writeFile(UNMATCHED_PATH, JSON.stringify(unmatched, null, 2), "utf-8");
  await fs.writeFile(REVIEWED_PATH, JSON.stringify([...reviewedSet], null, 2), "utf-8");

  console.log(`Durch Besetzungsabgleich bestätigt:   ${bestaetigt}`);
  console.log(`Als Fehlzuordnung verworfen:          ${widerlegt}`);
  console.log(`Nicht prüfbar, als gesichtet vermerkt:${nichtPruefbar}`);
  console.log(`Bibliothek jetzt:                     ${behalten.length}`);
}

main();
