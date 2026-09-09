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

  let geaendert = 0;
  const beispiele = [];

  for (const film of filme) {
    // Nur aus YouTube übernommene Einträge; TMDB-Titel und Handkorrekturen
    // bleiben unangetastet.
    if (film.matchSource !== "youtube") continue;

    const roh = rohTitel.get(film.videoId);
    const echterTitel = titelAusWerbung(roh);
    if (!echterTitel || echterTitel === film.title) continue;

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
