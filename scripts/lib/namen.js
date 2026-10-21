// Gemeinsamer Personenabgleich für match-tmdb.js, verify-plausibility.js und
// auto-verify.js: Steht eine in der Videobeschreibung genannte Person in der
// TMDB-Besetzung?
//
// Bis 21.10.2026 reichte der Nachname allein. Damit galt "Rob Freeman" als
// Martin Freeman, und "The Dead -- Das Fressen hat begonnen" wurde als
// "Shaun of the Dead" bestätigt. Jetzt gilt eine Person als genannt, wenn
//
//   1. alle Namensteile in EINEM TMDB-Namen stehen, Reihenfolge egal --
//      chinesische und ungarische Namen stehen mal mit Familienname vorn,
//      mal hinten ("Lung Ti" = "Ti Lung", "Bence Szalay" = "Szalay Bence"),
//   2. der Name ohne Leerzeichen gleich ist ("Cliff De Young" = "Cliff DeYoung"),
//   3. bei einem einzelnen Wort (Kanäle mit "Nachname, Vorname": "Lyonne,
//      Natasha" zerfällt in zwei Einträge) dieses Wort ein Namensteil ist, oder
//   4. der Nachname ein Namensteil ist UND der Vorname nicht widerspricht:
//      gleicher Anfangsbuchstabe wie ein anderer Teil desselben TMDB-Namens.
//      Das hält Tippfehler, Mittelinitialen und Kurzformen ("Adfrian
//      Bouchet", "Scott A. Martin", "Charles"/"Charlie Chaplin"), schließt
//      aber "Rob Freeman" gegen "Martin Freeman" aus.
//
// Geprüft am 21.10.2026 an allen 4.095 Besetzungsbestätigungen: Regel 4
// statt "Nachname reicht" ändert nur die Fälle, in denen ein Vorname
// ausdrücklich widerspricht.

function normName(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function teile(s) {
  return normName(s).split(" ").filter(Boolean);
}

export function personGenannt(name, tmdbNamen) {
  const t = teile(name);
  if (t.length === 0) return false;
  const ohneLeer = t.join("");
  const nachname = t[t.length - 1];
  return tmdbNamen.some((kandidat) => {
    const k = teile(kandidat);
    if (k.length === 0) return false;
    if (k.join("") === ohneLeer) return true; // Regel 2
    if (t.length === 1) return t[0].length > 3 && k.includes(t[0]); // Regel 3
    if (t.every((w) => k.includes(w))) return true; // Regel 1
    // Regel 4
    if (nachname.length <= 3) return false;
    const i = k.indexOf(nachname);
    if (i === -1) return false;
    const vorname = t[0];
    return k.some((w, j) => j !== i && w[0] === vorname[0]);
  });
}

// Anteil der erwarteten Personen, die in der TMDB-Besetzung stehen, oder
// null, wenn eine Seite leer ist.
export function personenAnteil(erwartet, tmdbNamen) {
  if (!erwartet.length || !tmdbNamen.length) return null;
  const treffer = erwartet.filter((n) => personGenannt(n, tmdbNamen)).length;
  return treffer / erwartet.length;
}

// Entfernt Klammer-Zusätze aus einer Besetzungszeile, BEVOR an Kommata
// getrennt wird. Manche Kanäle nennen zu jedem Darsteller seine bekanntesten
// Filme: "Mit: Odessa Young (The Professor, Shirley), Abra (Abra: Fruit)".
// Ohne diese Bereinigung zerfiele das beim Trennen zu unbrauchbaren
// Bruchstücken wie "Odessa Young (The Professor" und "Shirley)".
function stripKlammerZusaetze(zeile) {
  return (zeile || "").replace(/\([^)]*\)/g, " ").replace(/\s{2,}/g, " ").trim();
}

// Zieht die Schauspieler aus der "Mit: A; B; C"-Zeile der Beschreibung
// (72% der Videos haben eine), aus "mit A & B" im Videotitel und die Regie
// aus "Regie: X" (88%). Bis 21.10.2026 in match-tmdb.js; seitdem hier,
// damit die Plausibilitätsprüfung dieselben Namen sieht wie die Suche.
export function extractPeople(desc, title) {
  desc = desc || "";
  const cast = [];
  // "Mit:" (Netzkino & Co.) oder "Darsteller:" (Free Films Action) --
  // unterschiedliche Kanäle, gleiches Feld.
  const castLine = desc.match(/^\s*(?:Mit|Darsteller):\s*(.+)$/m);
  if (castLine) {
    stripKlammerZusaetze(castLine[1])
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 2 && s.length < 60)
      .forEach((s) => cast.push(s));
  }

  // Manche Kanäle nennen die Besetzung ausschließlich im Videotitel:
  //   "Destroyer – mit Nicole Kidman & Sebastian Stan, ganzer Film ..."
  //   "Hijacking – ganzer Thriller mit GOT-Star Pilou Asbæk, ..."
  // Ohne diese Quelle blieben solche Filme ungeprüft -- und genau dort sind
  // Fehltreffer bei gleichnamigen Filmen entstanden (z.B. "Night Moves"
  // 1975 statt 2013).
  const titleCast = (title || "").match(/\bmit\s+([^,–—(|]{4,70})/i);
  if (titleCast) {
    titleCast[1]
      .split(/\s*&\s*|\s+und\s+/i)
      .map((s) => s.replace(/^[A-ZÄÖÜ0-9]+-Star\s+/i, "").trim())
      // nur echte Personennamen (Vor- UND Nachname groß geschrieben) --
      // verhindert, dass Titelbestandteile wie "mit dem goldenen Colt"
      // fälschlich als Schauspieler gelesen werden
      .filter((s) => /^[A-ZÄÖÜ][\wäöüß.'-]*\s+[A-ZÄÖÜ]/.test(s))
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
