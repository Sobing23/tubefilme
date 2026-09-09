// Bereinigt Filmtitel, die als Werbeüberschrift in die Bibliothek geraten
// sind.
//
// Mehrere Kanäle betiteln ihre Videos reißerisch und nennen den eigentlichen
// Film nur nebenbei:
//
//   "Wow! Einer der besten Rache-Thriller! (Ganzer Film: Galveston)"
//   "UWE OCHSENKNECHT im Justizdrama • Ganzer Film Deutsch: Vera Brühne"
//
// Wurde ein solcher Film aus den YouTube-Angaben übernommen (weil TMDB ihn
// nicht kennt), stand bis zuletzt die Überschrift als Filmtitel in der
// Bibliothek. Dieses Skript setzt stattdessen den erkennbaren echten Titel.
//
// Angefasst werden NUR aus YouTube übernommene Einträge. Filme mit einem
// TMDB-Treffer haben ihren Titel von dort und bleiben unberührt; ebenso
// alles, was von Hand bearbeitet wurde.
//
// Die Adresse (slug) bleibt unverändert -- sie ist einmal vergeben und darf
// sich nicht ändern, sonst liefen bestehende Verweise ins Leere.
//
// Der Schritt ist idempotent: Bereits bereinigte Titel enthalten die
// Werbemuster nicht mehr und werden nicht erneut angefasst.

import fs from "fs/promises";

const FILME_PATH = "data/filme.json";
const CANDIDATES_PATH = "data/candidates.json";

function titelAusWerbung(titel) {
  if (!titel) return null;

  let m = titel.match(/\((?:ganzer\s+)?film:\s*([^)]{2,70})\)/i);
  if (m) return m[1].trim();

  m = titel.match(/^(?:.*(?:ganzer film|film deutsch|voller länge|kostenlos|auf deutsch)[^:]{0,25}):\s*(.{2,70})$/i);
  if (m) return m[1].trim();

  return null;
}


// Manche Kanäle betiteln ihre Videos rein reißerisch ("KOMÖDIENFILM, den man
// mindestens einmal im Leben gesehen haben sollte") und nennen den echten
// Film nur als kurze Zeile am Anfang der Beschreibung ("St. Daisy").
//
// Bewusst streng: Betrachtet wird ausschließlich die ERSTE echte Inhaltszeile
// (Wiederholungen des Videotitels und Verweiszeilen werden übersprungen).
// Passt diese nicht ins Titelmuster, wird abgebrochen statt weiterzusuchen.
// Ein lockereres Vorgehen zog Strukturangaben aus tieferen Zeilen mit herein --
// Zeitmarken ("00:00 Die Falle"), Angaben wie "Regie: ..." oder "Genre: ..."
// und Hashtag-Zeilen landeten dann als Filmtitel in der Bibliothek.
const KEIN_TITEL =
  /^(cast\s*&\s*crew|besetzung|darsteller|regie|inhalt|die handlung|handlung|imdb|fsk|filmname|originaltitel|originalname|trailer|highlights|kapitel|timestamps|danke|abonn|viel spa|folge uns|mehr filme|jetzt ansehen|hinweis|genre|lizenz|quelle|warum)/i;

const NUR_GATTUNG = new Set([
  "action", "thriller", "horror", "drama", "western", "komödie", "komoedie",
  "krimi", "film", "deutsch", "abenteuer", "fantasy", "mystery", "romantik",
  "klassiker", "spielfilm", "dokumentation",
]);

function kopfzeileAusBeschreibung(desc, videoTitel) {
  const zeilen = (desc || "").split(/\n+/).map((z) => z.trim()).filter(Boolean);
  const vt = String(videoTitel || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 25);

  for (const zeile of zeilen.slice(0, 3)) {
    const vergleich = zeile.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (vt && vergleich.startsWith(vt)) continue; // wiederholter Videotitel
    if (/https?:\/\//.test(zeile)) continue; // Verweiszeile

    // Ab hier gilt: Das ist die erste echte Inhaltszeile. Passt sie nicht,
    // gibt es in dieser Beschreibung keinen brauchbaren Titel.
    if (/#/.test(zeile)) return null;
    if (/^\d{1,2}:\d{2}/.test(zeile)) return null; // Zeitmarke
    if (zeile.length < 2 || zeile.length > 60) return null;
    if (/[.:]$/.test(zeile)) return null;
    if (/:\s/.test(zeile)) return null; // Strukturzeile wie "Regie: X"
    if (/^[A-ZÄÖÜ]{4,}$/.test(zeile)) return null; // Einzelwort in Großbuchstaben
    if (zeile.split(/\s+/).length > 8) return null;
    if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]$/u.test(zeile)) return null;

    // Erst Symbole und Anführungszeichen entfernen, DANN gegen die
    // Ausschlussliste prüfen. Sonst rutschen Zeilen wie "🎬 Regie & Cast"
    // durch, weil das führende Zeichen den Wortanfang verdeckt.
    const sauber = zeile
      .replace(/^[^\p{L}\p{N}(]+/u, "")
      .replace(/[„“"»«]+/g, "")
      .trim();
    if (sauber.length < 2) return null;
    if (KEIN_TITEL.test(sauber)) return null;
    if (NUR_GATTUNG.has(sauber.toLowerCase())) return null;
    return sauber;
  }
  return null;
}

async function main() {
  const filme = JSON.parse(await fs.readFile(FILME_PATH, "utf-8"));

  let candidates = [];
  try {
    candidates = JSON.parse(await fs.readFile(CANDIDATES_PATH, "utf-8"));
  } catch {
    console.log("candidates.json fehlt -- ohne die Rohtitel ist nichts zu tun.");
    return;
  }
  const rohTitel = new Map(candidates.map((c) => [c.videoId, c.title]));
  const beschreibungen = new Map(candidates.map((c) => [c.videoId, c.description]));

  let geaendert = 0;
  const beispiele = [];

  for (const film of filme) {
    // Nur aus YouTube übernommene Einträge; TMDB-Titel und Handkorrekturen
    // bleiben unangetastet.
    if (film.matchSource !== "youtube") continue;

    const roh = rohTitel.get(film.videoId);
    const rohBeschreibung = beschreibungen.get(film.videoId);
    const echterTitel =
      titelAusWerbung(roh) || kopfzeileAusBeschreibung(rohBeschreibung, roh);
    if (!echterTitel || echterTitel === film.title) continue;

    // Nur ersetzen, wenn der neue Titel nicht bloß ein Anfangsstück des
    // bisherigen ist -- sonst würde ein korrekter Titel gekürzt.
    if (film.title.startsWith(echterTitel)) continue;

    if (beispiele.length < 12) {
      beispiele.push({ alt: film.title, neu: echterTitel });
    }
    film.title = echterTitel;
    geaendert++;
  }

  await fs.writeFile(FILME_PATH, JSON.stringify(filme, null, 2), "utf-8");

  console.log(`Titel bereinigt: ${geaendert}`);
  if (beispiele.length) {
    console.log("\nBeispiele:");
    beispiele.forEach((b) => {
      console.log(`  vorher: ${b.alt.slice(0, 62)}`);
      console.log(`  nachher: ${b.neu}`);
      console.log("");
    });
  }
  console.log("Hinweis: Die Adressen der Filmseiten bleiben unverändert.");
}

main();
