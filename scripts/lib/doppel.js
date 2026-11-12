// Wann sind zwei Einträge der Bibliothek derselbe Film?
//
// Bis 11.11.2026 wurden Doppelte nur über die tmdbId erkannt. Filme ohne
// TMDB-Treffer rutschten immer durch: "Vincent will das Geld" stand elfmal
// in der Bibliothek (Netzkino, 3x Bulldox, 3x CiNENET, 2x COMEDYPIE,
// TitanumX, daredo), "World War II Inferno" siebenmal -- insgesamt 317
// Titel mit 768 Einträgen.
//
// Gleicher Film, wenn
//   - der Titel nach normTitel() gleich ist (Groß/klein, Akzente, ß/ss,
//     Satzzeichen egal) UND
//   - die Laufzeit höchstens 3 Minuten abweicht, oder bei gleichem Jahr
//     höchstens 15 % ("US Sniper" 93 und 96 min, "Körperfresser 2" 79 und
//     84 min, beide 2007 -- andere Schnittfassung oder PAL-Beschleunigung).
// Nie derselbe Film:
//   - widersprüchliches Jahr (beide bekannt, mehr als 1 Jahr Abstand):
//     "Der Glöckner von Notre Dame" 1923 und 1996
//   - zwei verschiedene tmdbIds
//   - derselbe Kanal mit mehr als 1 Minute Abstand: "THE LITTLE CARS" von
//     daredo sind vier verschiedene Folgen (42-50 min). Ein echter
//     Doppel-Upload desselben Kanals ist sekundengenau gleich lang.

export function normTitel(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function minuten(dauer) {
  const m = (dauer || "").match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  return m ? (+m[1] || 0) * 60 + (+m[2] || 0) + (+m[3] || 0) / 60 : 0;
}

function jahr(e) {
  const j = parseInt((e.releaseDate || "").slice(0, 4), 10);
  return Number.isFinite(j) && j > 1880 ? j : null;
}

export function gleicherFilm(a, b) {
  if (!a || !b || a.videoId === b.videoId) return false;
  const ta = normTitel(a.title);
  if (!ta || ta !== normTitel(b.title)) return false;
  if (a.tmdbId && b.tmdbId && a.tmdbId !== b.tmdbId) return false;

  const ja = jahr(a);
  const jb = jahr(b);
  if (ja && jb && Math.abs(ja - jb) > 1) return false;

  const ma = minuten(a.duration);
  const mb = minuten(b.duration);
  if (!ma || !mb) return false;
  const abstand = Math.abs(ma - mb);

  if (a.channelId && a.channelId === b.channelId) return abstand <= 1;
  if (abstand <= 3) return true;
  return ja !== null && ja === jb && abstand <= 0.15 * Math.max(ma, mb);
}

// Welcher Eintrag einer Gruppe bleibt? Kleinerer Rang gewinnt:
//   1. mit TMDB-Treffer (Poster, Besetzung, Beschreibung)
//   2. abspielbar vor gesperrt/gelöscht
//   3. mehr Angaben (Jahr, Besetzung, Regie, Beschreibung)
//   4. mit bereits vergebener Adresse -- und davon die älteste, also die mit
//      dem kürzesten Slug ("titel" vor "titel-2"), sonst früher veröffentlicht
export function rangfolge(a, b) {
  const t = (e) => (e.tmdbId ? 0 : 1);
  if (t(a) !== t(b)) return t(a) - t(b);
  const v = (e) => (e.verfuegbar === false ? 1 : 0);
  if (v(a) !== v(b)) return v(a) - v(b);
  const info = (e) =>
    (jahr(e) ? 1 : 0) + ((e.cast || []).length ? 1 : 0) + ((e.director || []).length ? 1 : 0) + (e.overview ? 1 : 0);
  if (info(a) !== info(b)) return info(b) - info(a);
  const s = (e) => (e.slug ? 0 : 1);
  if (s(a) !== s(b)) return s(a) - s(b);
  if (a.slug && b.slug && a.slug.length !== b.slug.length) return a.slug.length - b.slug.length;
  return (a.publishedAt || "").localeCompare(b.publishedAt || "");
}
