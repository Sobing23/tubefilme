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


// --- Wörtlich aus absorb-unmatched.js übernommen, damit bestehende und neu
// übernommene Filme nach exakt derselben Logik betitelt werden. ---

function stripGenreBrackets(text) {
  return (text || "").replace(/\[[^\]]{1,30}\]/g, " ").replace(/\s{2,}/g, " ").trim();
}

const MARKETING_SEGMENT =
  /ganzer?\b|ganze\b|auf deutsch|kostenlos|\bin hd\b|voller länge|komplett|^mit\s|jetzt (an)?schauen/i;

function stripMarketingSuffix(title, channelName) {
  const parts = title.split(/\s*[–—|]\s+|\s+-\s+/);
  if (parts.length <= 1) return title.trim();
  const kanal = (channelName || "").toLowerCase().replace(/[^a-z0-9äöüß]/g, "");
  const clean = [];
  for (const p of parts) {
    if (MARKETING_SEGMENT.test(p)) break;
    const seg = p.trim();
    // Reine Jahreszahl und Kanalname sind kein Titelbestandteil und werden
    // übersprungen. Sonst entstand aus "Hurra! Ich bin Papa! | 1939 |
    // HeimatfilmeTV" der Titel "Hurra! Ich bin Papa! - 1939 - HeimatfilmeTV".
    // Nur NACHGESTELLTE Jahreszahlen überspringen -- eine führende gehört zum
    // Titel ("2047 - Sights of Death", "1945 - Frozen Front").
    if (clean.length > 0 && /^(19|20)\d{2}$/.test(seg)) continue;
    if (kanal.length >= 4) {
      const s = seg.toLowerCase().replace(/[^a-z0-9äöüß]/g, "");
      if (s.startsWith(kanal)) continue;
    }
    clean.push(seg);
  }
  return clean.length ? clean.join(" - ").trim() : title.trim();
}

const ETIKETT_WORT =
  /^(film|filme|spielfilm|kinofilm|thriller|western|drama|komödie|komoedie|krimi|horror|action|abenteuer|klassiker|classic|kung|fu|martial|arts|sci|fi|scifi|fantasy|mystery|doku|dokumentation|animation|zeichentrick|deutsch|german|ganzer|ganze|kompletter|komplett|voller|volle|länge|laenge|hd|4k|uhd|kostenlos|gratis|auf|in|neu|restauriert|koloriert|farbe|und|full|movie|eastern|romanze|romantik|fantasie|spannung|aktion|satire|erotik|noir|biografie|historie|sport|klassik)$/;

function istEtikett(segment) {
  const woerter = (segment || "")
    .toLowerCase()
    .replace(/[^a-zäöüß0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
  if (woerter.length === 0) return true;
  return woerter.every(
    (w) => ETIKETT_WORT.test(w) || /(film|thriller|western|komödie|drama)$/.test(w) || /^(19|20)\d{2}$/.test(w)
  );
}

function cleanTitle(rawTitle, channelName) {
  // Erkennbarer echter Titel hat Vorrang vor jeder Bereinigung
  const ausWerbung = titelAusWerbung(rawTitle);
  if (ausWerbung) return ausWerbung;

  let t = stripGenreBrackets(rawTitle);

  // ZUERST die Klammern bereinigen, DANN an den senkrechten Strichen zerlegen.
  // Manche Kanäle setzen Striche innerhalb einer Werbeklammer: "World War II
  // Inferno (KRIEGSFILM | ganzer Film Deutsch | Action Film)". In umgekehrter
  // Reihenfolge wurde die Klammer mittendurch geschnitten, übrig blieb
  // "World War II Inferno (KRIEGSFILM" mit offener Klammer.
  // Qualitätsmarker wie "*HD*", "*4K*", "[HD]"
  t = t.replace(/\*\s*(HD|4K|FULL HD|UHD)\s*\*/gi, " ");
  // Klammern mit Werbeformeln
  t = t.replace(/\((?:[^)]*(?:ganzer|ganze|deutsch|kostenlos|voller länge|hd|film)[^)]*)\)/gi, " ");
  // Klammern, die nur Etiketten enthalten ("(KUNG-FU / ACTION)")
  t = t.replace(/\(([^)]*)\)/g, (ganz, innen) => (istEtikett(innen) ? " " : ganz));
  // Jahresangabe in Klammern (wandert in releaseDate)
  t = t.replace(/\((19|20)\d{2}\)/g, " ");
  t = t.replace(/\s{2,}/g, " ").trim();

  // Titel mit senkrechten Strichen: das erste Segment nehmen, das KEIN reines
  // Etikett ist. Der Titel steht mal vorne ("Die Stimme des Anderen |
  // KRIMIFILM"), mal hinter einem Genre ("KUNG FU CLASSIC | Die Silberfaust
  // der Shaolin"). Bisher wurden alle Segmente wieder angehängt, und der
  // Titel lautete etwa "Django - ... - Italowestern - 4K - Deutsch".
  if (t.includes("|")) {
    const segmente = t.split("|").map((x) => x.trim()).filter(Boolean);
    t = segmente.find((x) => !istEtikett(x)) || segmente[0] || t;
  }
  t = stripMarketingSuffix(t, channelName);
  // führende Marker wie "(x) " abschneiden
  t = t.replace(/^\s*\([^)]{0,12}\)\s*/, "").trim();

  // Erst ganz zum Schluss, damit Klammerbereinigung und Werbetext-Erkennung
  // vorher ihre Signale sehen: angehängte Werbeformel ohne Trennzeichen
  // ("Ein Colt für 100 Särge Ganzer Film auf Deutsch") und ein mit Komma
  // angehängtes Jahr ("Der letzte Schuß, 1955").
  t = t.replace(/\s+(ganzer?|ganze)\s+(film|filme|western|thriller|actionfilm|spielfilm)\b.*$/i, "");
  t = t.replace(/,\s*(19|20)\d{2}\s*$/, "");
  return t.replace(/\s*[-–—|*]\s*$/, "").trim();
}
// Kanäle, bei denen die erste Beschreibungszeile verlässlich der Filmtitel ist.
//
// Aus den Daten ermittelt statt als Liste gepflegt: Bei Kanälen, die ihre
// Videos reißerisch betiteln (CinemaLegenden, Kinohof, Lichtprojektor, ...)
// trifft die Kopfzeile in 87-97 % der Videos -- dort IST sie der Titel. Bei
// allen anderen trifft sie in 0-6 % und erwischt dann Werbung ("Stromkosten
// senken & Tarife vergleichen" bei Dzango), Firmennamen ("UCM.ONE") oder
// Werbezeilen ("Alles wie früher -- fast!" statt "Fast wie in alten Zeiten").
// Neue Kanäle werden so automatisch richtig eingeordnet.
const KOPFZEILE_MINDESTANTEIL = 0.5;
const KOPFZEILE_MINDESTVIDEOS = 10;
let KOPFZEILEN_KANAELE = new Set();

function ermittleKopfzeilenKanaele(candidates) {
  const gesamt = new Map();
  const treffer = new Map();
  for (const c of candidates) {
    gesamt.set(c.channelName, (gesamt.get(c.channelName) || 0) + 1);
    if (kopfzeileAusBeschreibung(c.description, c.title)) {
      treffer.set(c.channelName, (treffer.get(c.channelName) || 0) + 1);
    }
  }
  const ergebnis = new Set();
  for (const [kanal, n] of gesamt) {
    if (n >= KOPFZEILE_MINDESTVIDEOS && (treffer.get(kanal) || 0) / n >= KOPFZEILE_MINDESTANTEIL) {
      ergebnis.add(kanal);
    }
  }
  return ergebnis;
}


// Ist der bisher gespeicherte Titel erkennbar Müll? Nur dann darf er durch
// einen inhaltlich ANDEREN Titel ersetzt werden. Sonst würde ein bereits
// guter Titel überschrieben -- etwa bei DEFA, wo die Beschreibungs-Kopfzeile
// in den wenigen Fällen, in denen sie trifft, der echte Titel war.
function istErkennbarMuell(titel) {
  if (/\s\|\s/.test(titel)) return true; // Strich im Titel durchgerutscht
  if (/UCM\.ONE/i.test(titel)) return true; // Firmenname statt Titel
  const ersterTeil = titel.split(/\s+[-–—|]\s+/)[0];
  return ersterTeil !== titel && istEtikett(ersterTeil); // "ACTION-THRILLER - ..."
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
  KOPFZEILEN_KANAELE = ermittleKopfzeilenKanaele(candidates);

  let geaendert = 0;
  const beispiele = [];

  for (const film of filme) {
    // Nur aus YouTube übernommene Einträge; TMDB-Titel und Handkorrekturen
    // bleiben unangetastet.
    if (film.matchSource !== "youtube") continue;

    const roh = rohTitel.get(film.videoId);
    if (!roh) continue;
    const rohBeschreibung = beschreibungen.get(film.videoId);

    // Titel genau so bestimmen, wie absorb-unmatched.js es heute bei einer
    // Neuaufnahme täte.
    const echterTitel =
      titelAusWerbung(roh) ||
      (KOPFZEILEN_KANAELE.has(film.channelName)
        ? kopfzeileAusBeschreibung(rohBeschreibung, roh)
        : null) ||
      cleanTitle(roh, film.channelName);
    if (!echterTitel || echterTitel.length < 2 || echterTitel === film.title) continue;
    if (istEtikett(echterTitel)) continue; // nie auf ein reines Genre-Etikett kürzen

    // Ersetzen nur in zwei Fällen:
    //  1. Es fällt bloß Beiwerk hinten weg ("Die Stimme des Anderen - KRIMIFILM"
    //     -> "Die Stimme des Anderen"). An allen Fällen dieser Art geprüft:
    //     entfernt werden ausschließlich Genre, Qualität, Darsteller, Jahr,
    //     Kanalname -- nie ein echter Untertitel.
    //  2. Der bisherige Titel ist erkennbar Müll.
    const nurAnhaengsel = film.title.startsWith(echterTitel);
    if (!nurAnhaengsel && !istErkennbarMuell(film.title)) continue;

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
  console.log(
    "Hinweis: Bei geänderten Titeln vergibt build-site.js eine neue Adresse,\n" +
      "da die bisherige aus dem fehlerhaften Titel gebildet war."
  );
}

main();
