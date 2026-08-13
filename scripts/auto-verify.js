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
const REJECTED_PATH = "data/rejected-matches.json";
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


// Stimmen Titel und Jahr des zugeordneten Films mit den Angaben im
// Videotitel überein? Dann ist die Zuordnung sehr wahrscheinlich korrekt,
// unabhängig von der Besetzung.
function titelUndJahrPassen(m) {
  // Der Videotitel wird auf sein erstes, werbefreies Segment reduziert und
  // dann EXAKT verglichen. Ein reiner Teilstring-Vergleich wäre zu locker:
  // "Duell am Wind River" enthält "Wind River", ist aber ein anderer Film.
  const bereinigt = normalizeName(
    (m.youtubeTitle || "")
      // Bewusst NICHT am einfachen Bindestrich getrennt: Untertitel sind
      // Teil des echten Titels ("El Dorado - Stadt aus Gold" ist ein anderer
      // Film als "El Dorado").
      .split(/\s*[–—|]\s+|\(/)[0]
      .replace(/\[[^\]]{1,30}\]/g, " ")
  );
  const filmTitel = normalizeName(m.title || "");
  if (!filmTitel || filmTitel.length < 4) return false;
  if (bereinigt !== filmTitel) return false;

  const jahrImVideo = (m.youtubeTitle || "").match(/\((19|20)(\d{2})\)/);
  if (!jahrImVideo) return true; // Titel exakt gleich, kein Jahr zum Vergleich
  const jahrFilm = (m.releaseDate || "").slice(0, 4);
  return jahrFilm === jahrImVideo[1] + jahrImVideo[2];
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
  let geschuetzt = 0;

  // Bereits als falsch erkannte Zuordnungen -- werden bei der nächsten Suche
  // ausgeschlossen, damit nicht erneut derselbe Fehltreffer entsteht.
  let gesperrt = {};
  try {
    gesperrt = JSON.parse(await fs.readFile(REJECTED_PATH, "utf-8"));
  } catch {
    // erster Lauf
  }

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

    // Schutz vor Fehlverwerfung: Stimmen Titel UND Jahr exakt mit dem
    // überein, was im Videotitel steht, ist die Zuordnung mit hoher
    // Wahrscheinlichkeit richtig -- auch wenn die Besetzung nicht passt.
    // Wir speichern nur fünf Hauptdarsteller; nennt die Beschreibung
    // Nebendarsteller, sähe das sonst fälschlich nach Widerspruch aus
    // (Beispiel: "Birth of the Dragon" mit chinesischen Nebenrollen).
    if (quote === 0 && titelUndJahrPassen(m)) {
      behalten.push(m);
      if (!reviewedSet.has(m.videoId)) reviewedSet.add(m.videoId);
      geschuetzt++;
      continue;
    }

    // Verwerfen nur bei belastbarer Datenlage: MEHRERE erwartete Namen UND
    // eine ausreichend gefüllte TMDB-Besetzung -- und trotzdem kein Treffer.
    const belastbar = erwartet.length >= 2 && (m.cast || []).length >= 3;
    if (quote === 0 && belastbar) {
      // Die verworfene TMDB-ID kommt auf eine Sperrliste, und der Film wird
      // NICHT nach unmatched geschrieben. Dadurch gilt er beim nächsten Lauf
      // wieder als unbearbeitet und wird neu gesucht -- diesmal ohne den
      // bereits als falsch erkannten Kandidaten. So arbeitet sich das System
      // Runde für Runde zum richtigen Film vor, statt in einer Schleife
      // immer wieder denselben Fehltreffer zu liefern.
      if (m.tmdbId) {
        gesperrt[m.videoId] = gesperrt[m.videoId] || [];
        if (!gesperrt[m.videoId].includes(m.tmdbId)) gesperrt[m.videoId].push(m.tmdbId);
      }
      console.log(`   verworfen: "${m.youtubeTitle.slice(0, 55)}" war "${m.title}" -- erwartet: ${erwartet.slice(0, 3).join(", ")}`);
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
  await fs.writeFile(REJECTED_PATH, JSON.stringify(gesperrt, null, 2), "utf-8");

  console.log(`Durch Besetzungsabgleich bestätigt:   ${bestaetigt}`);
  console.log(`Als Fehlzuordnung verworfen:          ${widerlegt}`);
  console.log(`Trotz Besetzungsabweichung behalten:  ${geschuetzt} (Titel und Jahr passen exakt)`);
  console.log(`Nicht prüfbar, als gesichtet vermerkt:${nichtPruefbar}`);
  console.log(`Bibliothek jetzt:                     ${behalten.length}`);
}

main();
