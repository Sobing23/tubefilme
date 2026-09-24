# tubefilme.de — Dokumentation

Serverless betriebenes Archiv deutschsprachiger Filme, die auf YouTube legal in voller Länge verfügbar sind. Kein Server, keine Datenbank, kein Build-Schritt bei Vercel: Eine nächtliche GitHub Action sammelt die Daten ein, erzeugt daraus fertige HTML-Seiten und legt alles ins Repository. Vercel liefert die Dateien nur noch aus.

- **Repository:** `Sobing23/tubefilme`
- **Hosting:** Vercel, verbunden mit `main` — jeder Commit löst eine Auslieferung aus
- **Domain:** `tubefilme.de` (bei Strato, per A-Record und CNAME auf Vercel gezeigt)
- **Bestand:** rund 5.900 Filme aus 38 Kanälen

---

## Inhalt

1. [Aufbau](#aufbau)
2. [Die Pipeline Schritt für Schritt](#die-pipeline-schritt-für-schritt)
3. [Datendateien](#datendateien)
4. [Die Zuordnungslogik im Detail](#die-zuordnungslogik-im-detail)
5. [Titel aus reißerischen Videos gewinnen](#titel-aus-reißerischen-videos-gewinnen)
6. [Verfügbarkeit und Reparatur](#verfügbarkeit-und-reparatur)
7. [Seiten und Adressen](#seiten-und-adressen)
8. [Anbieter und Profile](#anbieter-und-profile)
9. [Frontend](#frontend)
10. [Review-Werkzeug](#review-werkzeug)
11. [Hosting bei Vercel](#hosting-bei-vercel)
12. [Wiederkehrende Aufgaben](#wiederkehrende-aufgaben)
13. [Fallstricke](#fallstricke)
14. [Offene Punkte](#offene-punkte)

---

## Aufbau

```
.github/workflows/
  scan.yml              nächtlich 02:00 UTC + manuell   -> normaler Durchlauf
  rematch.yml           nur manuell                     -> Neubewertung bestehender Zuordnungen
  availability.yml      nur manuell                     -> Verfügbarkeitsprüfung bei YouTube
  cleanup-posters.yml   nur manuell, einmalig           -> hat den ungenutzten Poster-Ordner entfernt

config/
  channels.json         Kanalliste + Anbieter-Profile

scripts/
  fetch-youtube.js       Videos je Kanal einsammeln (inkrementell)
  filter-movies.js       Shorts, Trailer, Serienfolgen aussortieren
  match-tmdb.js          TMDB-Zuordnung -- das Herzstück
  cleanup-matches.js     Sicherheitsnetz gegen doppelte tmdbIds
  auto-verify.js         unsichere Zuordnungen gegen die Besetzung prüfen
  absorb-unmatched.js    nicht auffindbare Filme aus YouTube-Daten übernehmen
  fix-titles.js          Werbeüberschriften in Titeln durch echte Filmtitel ersetzen
  fetch-cast.js          Besetzung, Regie, Drehbuch von TMDB
  fetch-fsk.js           deutsche Alterseinstufung von TMDB
  repair-unavailable.js  tote Videos ersetzen oder kennzeichnen
  build-site.js          Index, Startseite, Filmseiten, Sitemap erzeugen
  check-availability.js  Verfügbarkeit bei YouTube prüfen
  reset-for-rematch.js   fragwürdige Zuordnungen zur Neubewertung freigeben
  resolve-channel.js     @handle -> Kanal-ID
  cache-images.js        STILLGELEGT, siehe Fallstricke

data/                    sämtliche Daten als JSON (siehe unten)
film/                    eine erzeugte HTML-Seite je Film + style.css
index.html               Startseite -- ERZEUGT, nicht von Hand bearbeiten
alle.html                Trefferliste mit Suche, Filtern und Sortierung
review.html              privates Pflegewerkzeug (nicht verlinkt)
sitemap.xml, robots.txt  ERZEUGT
vercel.json              saubere Adressen und Zwischenspeicher-Regeln
```

**Benötigte Secrets** (Repository → Settings → Secrets → Actions):
`YOUTUBE_API_KEY`, `TMDB_BEARER_TOKEN`

**Nicht von Hand bearbeiten:** `index.html`, `sitemap.xml`, `robots.txt` und alles unter `film/` werden bei jedem Lauf von `build-site.js` neu geschrieben. Änderungen daran gehören in den Generator.

---

## Die Pipeline Schritt für Schritt

Reihenfolge in `scan.yml` — sie ist nicht beliebig:

| # | Schritt | Was passiert | API-Kosten |
|---|---|---|---|
| 1 | `fetch-youtube` | Neue Videos je Kanal. Über `data/state.json` inkrementell: bekannte Videos beenden die Suche vorzeitig. Neue Kanäle laufen automatisch einmal vollständig durch. | YouTube |
| 2 | `filter-movies` | Aussortiert: kürzer als 15 Minuten, Trailer/Teaser/Clip im Titel, Serienschlüsselwörter (Folge, Staffel, Serie, Miniserie, Episode, Webserie). | — |
| 3 | `match-tmdb` | Zuordnung zu TMDB. Details unten. | TMDB |
| 4 | `cleanup-matches` | Entfernt doppelte tmdbIds. Einträge **ohne** tmdbId sind ausgenommen. | — |
| 5 | `auto-verify` | Prüft unsichere Zuordnungen gegen die bereits gespeicherte Besetzung. | keine |
| 6 | `absorb-unmatched` | Übernimmt endgültig nicht auffindbare Filme mit YouTube-Metadaten. | keine |
| 7 | `fix-titles` | Ersetzt Werbeüberschriften bei übernommenen Filmen durch den echten Titel. | keine |
| 8 | `fetch-cast` | Besetzung/Regie/Drehbuch nachladen. Überspringt Filme, die diese Felder schon haben. | TMDB |
| 9 | `fetch-fsk` | FSK nachladen (eigener TMDB-Endpunkt für Freigaben je Land). | TMDB |
| 10 | `repair-unavailable` | Tote Videos durch geprüfte Ersatz-Uploads ersetzen oder kennzeichnen. | YouTube |
| 11 | `build-site` | Index, Startseite, Filmseiten, Sitemap erzeugen. | — |
| 12 | Commit | `git add data/ film/ index.html sitemap.xml robots.txt` | — |

**Warum diese Reihenfolge:**
- `auto-verify` braucht die Besetzung aus einem *früheren* Lauf, deshalb steht es vor `fetch-cast`.
- `absorb-unmatched` muss nach `auto-verify` laufen, damit verworfene Zuordnungen nicht sofort mit schwächeren Daten übernommen werden.
- `fix-titles` direkt nach `absorb-unmatched`, damit neu übernommene Filme gleich richtig heißen.
- `repair-unavailable` vor `build-site`, damit die Seiten bereits die reparierten Videos und Kennzeichnungen enthalten.

**Abbrechen ist ungefährlich:** Committet wird erst im letzten Schritt. Ein mittendrin gestoppter Lauf hinterlässt keinen halben Zustand.

---

## Datendateien

| Datei | Inhalt |
|---|---|
| `raw/<channelId>.json` | Rohdaten aller Videos eines Kanals |
| `state.json` | letzte gesehene videoId je Kanal (Grundlage des inkrementellen Scans) |
| `candidates.json` | gefilterte Filmkandidaten inkl. voller Beschreibung — **über 20 MB** |
| `excluded.json` | aussortierte Videos mit Begründung |
| **`filme.json`** | **die Bibliothek** — alle Filme mit sämtlichen Angaben |
| `index.json` | schlanker Auszug für die Trefferliste, **erzeugt** |
| `unmatched.json` | (noch) nicht zuordenbar, mit Grund und verwendetem Suchbegriff |
| `unmatched-attempts.json` | Fehlversuche je Video (Schonfrist vor der Übernahme) |
| `duplicates.json` | derselbe Film über mehrere Kanäle; auch Quelle für Ersatz-Uploads |
| `manual-matches.json` | `{videoId: tmdbId}` — eigene Korrekturen, haben immer Vorrang |
| `rejected-matches.json` | `{videoId: [tmdbId, …]}` — als falsch erkannte Zuordnungen, bei der Suche gesperrt |
| `ignored.json` | videoIds, die nie wieder verarbeitet werden (gelöscht, nicht auffindbar, fremdsprachig) |
| `reviewed.json` | im Review-Werkzeug als gesichtet markierte Filme |
| `cover-dismissed.json` | Filme, bei denen der Platzhalter akzeptiert wurde |
| `unavailable.json` | bei YouTube nicht abspielbare Filme mit Grund |
| `repaired.json` | Protokoll aller Video-Austausche |

### Felder eines Films in `filme.json`

```
videoId, youtubeTitle, youtubeThumbnail, duration (ISO 8601), publishedAt,
channelName, channelId,
tmdbId              null bei aus YouTube übernommenen Filmen
title, originalTitle, overview, releaseDate
posterUrl, backdropUrl, voteAverage, genreIds[]
cast[], director[], writer[]
fsk                 "0"|"6"|"12"|"16"|"18" oder null
slug                Adressbestandteil -- einmal vergeben, NIE wieder geändert
matchSource         originaltitel+jahr | originaltitel-ohne-jahr | titel-fallback
                    | manuell | youtube
matchConfidence     hoch | mittel | niedrig | youtube
hinweis             Klartext-Erklärung bei Unsicherheit (optional)
verfuegbar          false, wenn bei YouTube nicht abspielbar (sonst fehlend)
nichtVerfuegbarGrund geloescht | gesperrt_de | nicht_einbettbar | nicht_oeffentlich
```

---

## Die Zuordnungslogik im Detail

Das ist der Teil, der am meisten Arbeit gekostet hat, und der Teil, an dem beim Ändern am meisten kaputtgehen kann.

### 1. Manuelle Korrekturen zuerst

`manual-matches.json` wird **vor allem anderen** angewendet — auch auf bereits (falsch) zugeordnete Filme. Ohne diesen Schritt würde die Inkrementell-Logik ein schon verarbeitetes Video nie wieder anfassen, und Korrekturen liefen ins Leere.

### 2. Suchbegriffe gewinnen

Aus Videotitel und Beschreibung wird eine **priorisierte Liste** von Suchbegriffen gebaut. In dieser Reihenfolge:

1. Echter Titel aus einem Werbetitel (`… (Ganzer Film: Galveston)`) — siehe nächstes Kapitel
2. `Originaltitel:` bzw. `Originalname Film:` aus der Beschreibung
3. Videotitel bis zur ersten Klammer oder zum ersten Strich, bereinigt um Genre-Klammern und führende Emoji
4. Varianten ohne Schauspieler-Vorspann, an Schrägstrichen geteilt, hinter Strichen (nur wenn das Anbieter-Profil es erlaubt)
5. Werbetext-bereinigte Fassungen
6. Kopfzeile aus der Beschreibung
7. Als letzter Notnagel: erstes Segment vor dem ersten Strich

**Neue Varianten werden hinten angehängt, nie vorne.** Filme, die mit ihrem bisherigen Begriff sicher gefunden werden, brechen die Suche vorher ab und bleiben dadurch unverändert.

Das **Jahr** kommt aus drei Quellen: Klammer nach dem Titel in der Beschreibung, Fließtext `aus dem Jahr JJJJ` (über 500 Beschreibungen nutzen das), oder `(JJJJ)` im Videotitel.

### 3. Gesperrte Begriffe

Rund 60 reine Genre- und Gattungswörter (`Kriegsfilm`, `Thriller`, `Western`, `Klassiker` …) sind als Suchbegriff **komplett gesperrt**. Ohne diese Sperre entstand z. B.: Videotitel `Julius Cäsar, der Tyrann von Rom | Sandalenfilm auf Deutsch | Kriegsfilm` → der echte Titel war bei TMDB nicht auffindbar → die Suche fiel durch bis `"Kriegsfilm"` → gefunden wurde „Sturmzeichen – Ein **Kriegsfilm**".

### 4. Bewertung statt Reihenfolge

**Nie** einfach `results[0]` nehmen — TMDB sortiert nach Popularität, nicht nach Passgenauigkeit. Jeder Treffer wird bewertet:

| Kriterium | Punkte |
|---|---|
| Titel exakt (normalisiert) | +100 |
| Titel teilweise | bis +55 anteilig |
| Jahr exakt / ±1 / ±3 | +45 / +35 / +18 |
| Jahr weit daneben | −12 bis −35 |
| ≥50 / ≥10 / ≥1 / 0 Bewertungen | +18 / +12 / +5 / **−25** |
| Genres vorhanden / fehlen | +8 / −15 |
| Beschreibung vorhanden / fehlt | +8 / −15 |
| Popularität | bis +7,5 |

Der Abzug für leere Datensätze ist wichtig: Ein kommerziell ausgewerteter Film hat bei TMDB praktisch immer Bewertungen, Genres und eine Beschreibung. Leere Einträge (Festivalmitschnitte, Namensdubletten) waren die Hauptquelle grotesker Fehltreffer.

### 5. Besetzungsabgleich bei Unklarheit

Liegt der beste Wert unter 140, werden die **drei besten Kandidaten** gegen die Personen aus Beschreibung *und* Videotitel geprüft und **neu sortiert**. Nur den Favoriten abzuwerten genügt nicht — sonst wird der falsche Film zwar erkannt, der richtige aber nie ausgewählt.

Beispiel: „Night Moves – mit Jesse Eisenberg" gewann zunächst die bekanntere Fassung von 1975 (128 zu 120). Nach dem Abgleich: 180 zu 88 zugunsten der richtigen von 2013.

### 6. Belegpflicht bei schwachen Treffern

Unter Wert 90 wird ein **zweiter, unabhängiger Beleg** verlangt: exakter Titel, exakt passendes Jahr oder bestätigte Besetzung. Fehlt jeder, gibt es keine Zuordnung.

Die Schwelle einfach anzuheben wäre falsch — auch richtige Treffer landen tief, wenn deutscher und Originaltitel auseinandergehen (`Winter in Wartime` → `Mein Kriegswinter`, Wert 62). Entscheidend ist nicht die Höhe, sondern ob es einen zweiten Hinweis gibt.

### 7. Sperrliste als Selbstkorrektur

Erkennt `auto-verify` eine Zuordnung als falsch, wandert die tmdbId nach `rejected-matches.json` und der Film gilt wieder als unbearbeitet. Beim nächsten Lauf wird er neu gesucht — ohne den als falsch erkannten Kandidaten.

**Schutzregel:** Stimmt der bereinigte Videotitel **exakt** mit dem Filmtitel überein (und das Jahr, falls angegeben), wird nicht verworfen, auch wenn die Besetzung abweicht. Wir speichern nur fünf Hauptdarsteller; nennt die Beschreibung Nebenrollen, sähe das fälschlich nach Widerspruch aus.

### 8. Kanalübergreifende Duplikate

Derselbe Film über mehrere Kanäle: erster Fund gewinnt, jeder weitere wandert dokumentiert nach `duplicates.json`. Dort bleibt er als Ersatz-Upload verfügbar, falls der Hauptupload später verschwindet.

---

## Titel aus reißerischen Videos gewinnen

Viele Kanäle nennen den Filmtitel nicht im Videotitel, sondern verpacken ihn in Werbung. Drei Muster, in dieser Reihenfolge ausgewertet:

| Muster | Beispiel | Kanäle |
|---|---|---|
| Titel in Klammern nach „Film:" | `Wow! Bester Rache-Thriller! (Ganzer Film: Galveston)` | Moviedome |
| Titel nach dem letzten Doppelpunkt | `… • HORROR FILM DEUTSCH: Das Ouija House` | Starkino |
| Titel als Kopfzeile der Beschreibung | Videotitel `KOMÖDIENFILM, den man gesehen haben sollte`, Beschreibung beginnt mit `St. Daisy` | CinemaLegenden, Unfassbare Filme |

Genutzt an drei Stellen: in der TMDB-Suche (`match-tmdb.js`, Werbetitel mit höchster Priorität), bei der Übernahme (`absorb-unmatched.js`) und nachträglich für den Bestand (`fix-titles.js`).

**Die Kopfzeilen-Erkennung ist bewusst streng.** Betrachtet wird ausschließlich die **erste echte Inhaltszeile** — Wiederholungen des Videotitels und Verweiszeilen werden übersprungen, danach wird abgebrochen. Ein lockereres Vorgehen (erste passende von vier Zeilen) hätte 646 Titel geändert, darunter Zeitmarken (`00:00 Die Falle`), Strukturangaben (`Regie: …`, `Genre: …`) und Hashtag-Zeilen. Die strenge Fassung ändert 110 — dafür ausnahmslos richtige.

Ausgeschlossen werden außerdem Überschriften wie `Cast & Crew` (CiNENET) oder `IMDb: *6,8* von 10` (Moviedome). **Die Prüfung läuft auf der von Symbolen bereinigten Zeile**, sonst rutscht `🎬 Regie & Cast` durch.

**Grenze:** Bei manchen Kanälen — vor allem Volle Power Filme — nennen weder Titel noch Beschreibung je einen Filmnamen, nur Handlung. Diese Fälle lassen sich nicht automatisieren und bleiben Handarbeit im Review-Werkzeug.

---

## Verfügbarkeit und Reparatur

Filme verschwinden bei YouTube laufend — Lizenzen laufen aus, Kanäle räumen auf. Über den gesamten Bestand lag die Ausfallquote bei rund 2,8 %, je Kanal aber zwischen 0,7 % und 26 %.

### Prüfen: `check-availability.js`

Prüft **vier** Gründe, nicht nur ob das Video existiert:

| Grund | Bedeutung |
|---|---|
| `geloescht` | Video existiert nicht mehr oder ist privat |
| `nicht_oeffentlich` | existiert, ist aber nicht freigegeben |
| `nicht_einbettbar` | läuft bei YouTube, darf aber nicht eingebettet werden — erzeugt bei uns den schwarzen Kasten |
| `gesperrt_de` | in Deutschland nicht abrufbar |

Der dritte Fall wird leicht übersehen: Jede reine Existenzprüfung hält das Video für in Ordnung.

Bedienung über den Workflow „Verfügbarkeit prüfen" mit drei Eingabefeldern (Kanal, einzelnes Video, Obergrenze). Alle leer = kompletter Bestand, rund 120 Abfragen. **Teilprüfungen erhalten die Befunde der übrigen Filme.**

### Reparieren: `repair-unavailable.js`

- **Ersatz vorhanden** → Die Video-ID im bestehenden Eintrag wird gegen die eines funktionierenden Uploads aus `duplicates.json` getauscht. Adresse, Seite, Titel bleiben gleich — nur das Video läuft wieder. Besser als jede Weiterleitung.
- **Kein Ersatz** → Kennzeichnung `verfuegbar: false`. Der Film verschwindet aus Trefferliste und Sitemap, seine Seite bleibt mit Hinweis, ähnlichen Filmen und `noindex` bestehen.
- **Video kommt zurück** → Kennzeichnung verschwindet beim nächsten Lauf von selbst.

**Ersatzkandidaten werden vor dem Austausch bei YouTube geprüft.** Beim ersten Lauf waren nur 15 von 108 Kandidaten tatsächlich abspielbar — ohne Prüfung wird ein totes Video schlicht durch ein ebenso totes ersetzt.

In Deutschland gesperrte Filme werden wie tote behandelt: Das Video ist intakt, für das Publikum aber nicht abspielbar.

---

## Seiten und Adressen

### Filmseiten

Jeder Film hat eine eigene Seite unter `/film/<slug>`, erzeugt von `build-site.js`. Enthalten: Titel, Beschreibung, Besetzung, Regie, strukturierte Daten nach schema.org, Open-Graph-Angaben für soziale Netze und sechs ähnliche Filme als interne Verlinkung. Das Video lädt erst auf Klick.

### Adressen

Lesbar und ohne technische Zusätze: `/film/das-china-syndrom`. Nur bei echten Titeldopplungen (rund 90 von 5.900) gibt es eine laufende Nummer: `/film/die-welle-2`.

**Der Slug wird einmal vergeben und in `filme.json` gespeichert — danach nie wieder neu berechnet.** Sonst würde ein Video-Austausch die Adresse ändern, bestehende Verweise liefen ins Leere, und die bei Suchmaschinen aufgebaute Sichtbarkeit wäre verloren. Die Erkennung alter Adressformate vergleicht deshalb gegen den Titel, nicht gegen die (möglicherweise getauschte) Video-ID.

### Startseite

`index.html` wird vom Generator als **fertiges HTML** erzeugt und lädt keine Daten nach. Dreizehn waagerecht blätterbare Reihen im Stil großer Streamingdienste: Neu dazugekommen, Beste Bewertungen, zehn Genres, Klassiker vor 1980. Jede Reihe verlinkt auf die gefilterte Trefferliste.

### Sitemap

`sitemap.xml` enthält Startseite, Trefferliste und alle **verfügbaren** Filme. `robots.txt` schließt `/review` aus.

---

## Anbieter und Profile

Die Kanäle unterscheiden sich systematisch im Aufbau von Titel und Beschreibung. Dieses Wissen steht als optionales `profil` beim jeweiligen Kanal in `config/channels.json`:

```json
{ "name": "Artflix", "channelId": "UC…", "profil": { "pipeAlsTitelvariante": false } }
```

| Schalter | Bedeutung |
|---|---|
| `pipeAlsTitelvariante` | Stehen hinter `\|` alternative Filmtitel (`true`, Standard) oder nur Genre- und Werbeangaben (`false`)? |

Fehlt ein Profil, gelten die Standardwerte — neue Kanäle funktionieren also ohne Eintrag.

### Die 38 Kanäle

| Kanal | Rechteinhaber | Profil |
|---|---|---|
| Absolute Action | keine Angabe | |
| Alle Filme Auf Deutsch | keine Angabe | |
| Amelia | keine Angabe | |
| Artflix | Amogo Networx | ✓ |
| Bigtime | Amogo Networx | ✓ |
| Boxoffice | keine Angabe | |
| Bulldox | PLAION PICTURES | |
| CineCult Reloaded | keine Angabe | |
| CinemaLegenden | keine Angabe | |
| CiNENET Deutschland | UCM.ONE GmbH | ✓ |
| Comfy Movies | keine Angabe | |
| DEFA Filmwelt | DEFA-Stiftung | |
| Deutsch Film Hub | keine Angabe | |
| Deutsch Knallhart | keine Angabe | ✓ |
| Draco Actionfilme | PLAION PICTURES | |
| Dzango | PLAION PICTURES | |
| FABELLA | PLAION PICTURES | |
| FFF Kino | Greater Fool Network | ✓ |
| Filmalarm | WDR Mediagroup | |
| Filmhof Welt | keine Angabe | |
| Free Films Action | LEONINE / Mediawan | |
| Free Films Emotion | LEONINE | |
| Free Movies Deutschland | keine Angabe | |
| Grjngo Westernfilme | Grjngo GmbH | |
| Heimatfilme | Beta Film GmbH | |
| Heimatkino | PLAION PICTURES | |
| Kino Deutsch | keine Angabe | |
| Kinohof | keine Angabe | |
| KinoWucht | keine Angabe | |
| Lichtprojektor | keine Angabe | |
| Moviedome | PLAION PICTURES | |
| Movies Select | PLAION PICTURES | |
| Netzkino | PLAION PICTURES | |
| Planet Movies | Tiberius Film | |
| Sony Pics at Home DE | Sony Pictures HE | |
| Starkino | PLAION PICTURES | |
| Unfassbare Filme | keine Angabe | |
| Volle Power Filme | keine Angabe | |

**Beobachtung:** Kanäle ohne erkennbaren Rechteinhaber machen überdurchschnittlich viel Mühe — Clickbait-Titel ohne Filmnamen und hohe Ausfallquoten (Filmhof Welt verlor jeden vierten Film). Die PLAION-Kanäle überschneiden sich stark und erzeugen viele Duplikate, liefern dafür aber die meisten Ersatz-Uploads.

**Bewusst nicht aufgenommen:**
- **Babel Movies** — englischsprachiger „World Cinema"-Kanal, passt nicht zum deutschsprachigen Profil
- **Braventa Films** — erwies sich nach dem ersten Scan als spanischsprachig (Kanal hatte keine Beschreibung); die 107 Videos stehen in `ignored.json`

### Neuen Kanal hinzufügen

1. `@handle` aufrufen und Kanal-ID aus der Seite ziehen (bei Weiterleitungsproblemen über den Seitenquelltext, Suche nach `channelId`)
2. In `config/channels.json` alphabetisch eintragen
3. `scan.yml` starten — der neue Kanal läuft automatisch einmal vollständig durch
4. Danach die Zuordnungsquote je Kanal prüfen und bei Bedarf ein Profil setzen oder die Extraktion nachschärfen

**Tipp:** Bei Kanälen **ohne Kanalbeschreibung** vorher kurz in die Videotitel schauen. Braventa sah von außen unauffällig aus und war komplett spanischsprachig.

---

## Frontend

Bewusst funktional gehalten, das visuelle Design steht noch aus. Vanilla HTML/CSS/JS, als einzige Bibliothek **Fuse.js** für die unscharfe Suche.

### Kopfbereich

Auf allen Seiten gleich aufgebaut: Logo, Suchfeld, „Alle Filme", „♥ Merkliste".

- Auf Startseite und Filmseiten ist das Suchfeld ein gewöhnliches Formular, das per GET an `/alle?q=…` schickt — funktioniert ohne JavaScript
- Auf `/alle` filtert dasselbe Feld sofort, ohne Seitenwechsel
- Die vier Filterfelder gibt es nur auf `/alle` — auf den anderen Seiten gibt es nichts, worauf sie wirken könnten

### Trefferliste `/alle`

- Lädt `data/index.json` (rund 2 MB, komprimiert etwa 650 KB) von der eigenen Domain
- Durchsucht Titel, Originaltitel, Genres, Besetzung, Regie
- Filter: Genre, FSK, Jahrzehnt — kombinierbar mit der Suche
- Sortierung: Standard, beste Bewertung, A–Z, Z–A, neueste, älteste
- **Nachladen beim Scrollen:** zuerst 120 Kacheln, weitere Portionen sobald das Ende in Sicht kommt
- **Adressparameter** setzen Filter direkt: `?q=`, `?genre=`, `?fsk=`, `?jahrzehnt=`, `?sort=`, `?merkliste=1`
- **Rückfall ohne Fuse.js:** Ist der fremde Anbieter nicht erreichbar, greift eine einfache Textsuche, statt dass die Seite leer bleibt

### Poster

Drei Stufen: TMDB-Poster → YouTube-Vorschaubild (auf 145 % vergrößert eingepasst, freier Rand mit unscharfer Fassung desselben Bildes gefüllt; zuerst `maxresdefault`, sonst die gespeicherte Variante) → Textplatzhalter.

Badges (FSK, „?" bei niedriger Konfidenz) hängen an einem eigenen Rahmen um das Bild, nicht an der Karte — sonst überlappen sie bei zweizeiligen Titeln.

### Merkliste

Über `localStorage`, ohne Anmeldung. Schlüssel ist die **videoId** (die tmdbId fehlt bei übernommenen Filmen).

---

## Review-Werkzeug

`review.html` — privat, **nicht verlinkt**, aber technisch öffentlich erreichbar. Ohne Token kann dort niemand etwas ändern.

**Zugang:** fein granulierter GitHub-Token, beschränkt auf dieses eine Repository, Berechtigung „Contents: Read and write". Er liegt ausschließlich im `localStorage` des Browsers. **Nie in Chats, E-Mails oder Dokumente einfügen** — ein Token ohne Ablaufdatum gilt dann dauerhaft als kompromittiert und muss widerrufen werden.

| Reiter | Zweck |
|---|---|
| Unmatched | zuordnen, als nicht auffindbar markieren, löschen |
| Niedrig-Konfidenz | korrigieren, bestätigen, löschen |
| Fehlende FSK | Einstufung nachtragen |
| Kein Cover | Bild-URL eintragen oder Platzhalter akzeptieren (aus YouTube übernommene Filme sind ausgenommen) |
| Alle Filme | suchen, **alle Felder bearbeiten**, löschen |
| Kanäle | Übersicht alphabetisch mit Filmanzahl |

In jedem Reiter gibt es einen Direktlink zum Video.

- „Löschen" entfernt den Film aus `filme.json` **und** trägt ihn in `ignored.json` ein
- Von Hand bearbeitete Filme gelten als geprüft (`matchSource: manuell`) und werden von der Automatik nicht mehr angefasst
- **Nach jeder Änderung „Daten neu laden"** — die Seite aktualisiert sich nicht selbst

---

## Hosting bei Vercel

`vercel.json` schaltet saubere Adressen ein (`/film/xyz` statt `/film/xyz.html`) und setzt Zwischenspeicher-Regeln: HTML und JSON werden immer frisch geprüft, das gemeinsame Stylesheet einen Tag vorgehalten.

**Kein Bau-Schritt bei Vercel.** Die Seiten entstehen in der GitHub Action. Vercel liefert nur Dateien aus.

**Aufbewahrung alter Auslieferungen: eine Woche.** Das ist der Kompromiss zwischen Speicher und der Möglichkeit, bei einem Fehler auf eine funktionierende Fassung zurückzugreifen. Bei rund 50 MB je Auslieferung und ein bis drei Auslieferungen am Tag bleibt das weit unter den 10 GB des kostenlosen Tarifs.

---

## Wiederkehrende Aufgaben

**Neuen Kanal aufnehmen** → siehe [Anbieter und Profile](#neuen-kanal-hinzufügen).

**Zuordnungslogik verbessert, Bestand soll profitieren** → `rematch.yml` starten. Freigegeben wird, was Konfidenz „niedrig"/„mittel" hat oder ohne Bewertung/Genres dasteht. **Manuelle Korrekturen und aus YouTube übernommene Filme bleiben unangetastet.**

**Tote Filme finden** → „Verfügbarkeit prüfen" mit leeren Feldern. Die Reparatur läuft im selben Durchgang mit.

**Einzelnen Film korrigieren** → Review-Werkzeug, Reiter „Alle Filme", Bearbeiten.

**Fehlerursache verstehen** → `data/unmatched.json` enthält zu jedem Fall Suchbegriff, erwartetes Jahr, Grund und besten TMDB-Kandidaten.

**Seite lokal neu erzeugen** → `npm run site`.

---

## Fallstricke

Alles hier ist mindestens einmal schiefgegangen.

### Bei Vercel

- **Kein Eintrag namens `build` in `package.json`.** Vercel führt einen solchen Eintrag bei jeder Auslieferung automatisch aus. Das hat fünf Auslieferungen in Folge scheitern lassen. Der Generator heißt deshalb `site`. Bei einer fehlgeschlagenen Auslieferung bleibt die letzte funktionierende online — die Seite läuft weiter, bekommt aber keine Änderungen mehr.
- **Keine großen, ungenutzten Dateien im Repository.** Vercel legt bei *jeder* Auslieferung eine vollständige Kopie ab. `cache-images.js` hatte rund 4.500 Poster heruntergeladen, die von keiner Seite genutzt wurden (alle Seiten laden direkt von `image.tmdb.org`). Bei 600 MB je Auslieferung liefen so 53 GB Speicher auf, bei einem Limit von 10 GB. Das Skript ist stillgelegt, der Ordner entfernt.
- **Nach dem Einspielen neuer Frontend-Dateien** kann der Browser eine alte Fassung aus dem Zwischenspeicher zeigen. Einmalig `?v=2` an die Adresse hängen erzwingt frisches Laden.

### Bei den Workflows

- **Erzeugt `build-site.js` eine neue Datei, muss sie in die `git add`-Zeile aller Workflows.** Sonst wird sie bei jedem Lauf geschrieben und gleich wieder verworfen. Ist zweimal passiert (bei `index.html` und `img/`).
- **Bestätigungsfelder in Workflows prüfen auf exakte Schreibweise.** `Loeschen` statt `loeschen` bricht ab.

### Beim Lesen aus GitHub im Browser (Review-Werkzeug)

- **Niemals `raw.githubusercontent.com` zum Lesen verwenden** — dieser Zwischenspeicher liefert nach eigenen Änderungen teils stundenlang veraltete Daten.
- **`cache: "no-store"` bei jedem lesenden `fetch`** — sonst lesen aufeinanderfolgende Aktionen denselben veralteten Versionsstand und erzeugen `409`-Konflikte, die auch automatisches Wiederholen nicht auflöst.
- **Dateien über 1 MB** liefert die Contents-API nicht direkt; `ghGetFile()` weicht automatisch auf die Blob-API aus.
- **Keine riesigen Dateien laden, wenn nur Kleinigkeiten gebraucht werden.** Die Review-Seite lud einst `candidates.json` (über 20 MB) nur für Vorschaubild und Kanalname von zwei Einträgen — und blieb dadurch leer.
- **Schreibvorgänge müssen nacheinander laufen** (`withLock`).
- **Laufvariablen in Vorlagen prüfen.** Ein `m.videoId` in einer Schleife über `u` riss alle Listen der Seite mit — die Zähler standen, weil sie vorher gesetzt werden, aber jede Liste war leer. Fiel erst mit echten Daten auf, weil der Test mit einer leeren Liste lief.

### Beim Ändern der Skripte

- **`cleanup-matches.js` muss Filme ohne tmdbId überspringen.** Sonst gelten alle übernommenen Filme als Duplikate derselben `null`-ID.
- **`reset-for-rematch.js` muss übernommene Filme ausnehmen.** Sie haben nie eine TMDB-Bewertung und würden bei jeder Neuzuordnung aus der Bibliothek fallen — einmal waren es 805 Filme auf einen Schlag.
- **Nicht an Kommata trennen**, wenn Titel zerlegt werden — „Der Spion, der niemals stirbt" wird sonst zu „Der Spion".
- **Nicht am einfachen Bindestrich trennen**, wenn Titel verglichen werden — „El Dorado – Stadt aus Gold" ist ein anderer Film als „El Dorado".
- **Beim Gedankenstrich kein Leerzeichen davor verlangen** — `Killer– ganzer Film` wurde sonst nicht zerlegt. Beim einfachen Bindestrich dagegen schon, sonst zerfällt „Salyut-7".
- **Klammerzusätze vor dem Trennen entfernen** (`Mit: Odessa Young (The Professor, Shirley)`).
- **`ß` zu `ss` auflösen, bevor Sonderzeichen entfernt werden.** Sonst wird „muß" zu „mu".
- **Emoji am Titelanfang entfernen**, bevor gesucht wird.
- **Symbole entfernen, bevor gegen Ausschlusslisten geprüft wird.**
- **Teilstring-Vergleiche sind zu locker.** „Duell am Wind River" enthält „Wind River".
- **Ersatz-Uploads vor dem Einsetzen prüfen.** `duplicates.json` wird nie auf Verfügbarkeit geprüft.
- **Slugs nie aus veränderlichen Werten ableiten.** Einmal vergeben, dauerhaft gespeichert.

### Beim Beurteilen von Ergebnissen

- **Zahlen allein reichen nicht.** Mehrfach sahen Läufe statistisch gut aus, und erst eine Stichprobe förderte echte Fehler zutage.
- **Eine Heuristik, die viele Änderungen macht, ist verdächtig.** Die erste Fassung der Titelbereinigung hätte 646 Titel geändert, darunter Müll; die richtige ändert 110.
- **Tests mit echten Daten, nicht nur mit Musterdaten.** Mehrere Fehler traten erst mit realen Datensätzen auf.
- **Fehlende Titelüberschneidung ist kein Fehlerindiz.** Fremdsprachige Originaltitel gehen naturgemäß nicht mit deutschen Verleihtiteln zusammen — das ist korrekt.
- **Nur fünf Hauptdarsteller sind gespeichert.** Deshalb nie verwerfen, wenn Titel und Jahr exakt stimmen.

### Zur FSK

Für einen Teil des Bestands liefert TMDB keine deutsche Einstufung. Eine Ableitung aus Freigaben anderer Länder wäre falsch: Die FSK ist eine rechtliche Kennzeichnung, eine geschätzte Angabe wäre schlechter als gar keine.

---

## Offene Punkte

- **Visuelles Design** der öffentlichen Seite
- **Rückmeldefunktion für Besucher** (falscher Film, Video nicht abspielbar, weitere Gründe noch zu definieren) — bräuchte den ersten serverseitigen Code im Projekt, etwa eine Vercel-Function
- **Restfälle mit Werbeüberschrift** (rund 40, überwiegend Volle Power Filme) — nur von Hand lösbar
- **Hakunan** — Kanal gewünscht, ID noch nicht ermittelt
- **Aufteilung von `filme.json`** — mit über 8 MB wird das Speichern im Review-Werkzeug zunehmend träge
- **Kanäle mit hoher Fluktuation** über mehrere Prüfläufe beobachten und entscheiden, ob sie sich lohnen
