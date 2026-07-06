const fs = require('fs');
const path = require('path');

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const TMDB_API_KEY = process.env.TMDB_API_KEY;

const MOVIES_FILE = path.join(__dirname, 'filme.json');
const IMG_DIR = path.join(__dirname, 'img');

// Falls der img-Ordner noch nicht existiert, erstellen
if (!fs.existsSync(IMG_DIR)) {
  fs.mkdirSync(IMG_DIR, { recursive: true });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP Fehler: ${response.status}`);
  return response.json();
}

// 1. YouTube-Videos über RapidAPI holen (mit Paginierung für das gesamte Archiv)
async function getChannelVideos(channelId, maxPages = 5) {
  let allVideos = [];
  let currentCursor = "";
  let page = 1;

  console.log(`Starte Archiv-Scan für Kanal ${channelId}...`);

  while (page <= maxPages) {
    console.log(`Lade Seite ${page}...`);
    const url = 'https://youtube138.p.rapidapi.com/channel/videos/';
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-rapidapi-host': 'youtube138.p.rapidapi.com',
        'x-rapidapi-key': RAPIDAPI_KEY
      },
      body: JSON.stringify({
        id: channelId,
        filter: 'videos_latest',
        cursor: currentCursor,
        hl: 'de',
        gl: 'DE'
      })
    };

    try {
      const data = await fetchJson(url, options);
      
      if (!data.contents || data.contents.length === 0) {
        console.log('Keine weiteren Videos gefunden.');
        break;
      }

      // Videos extrahieren
      const items = data.contents
        .filter(item => item.video)
        .map(item => ({
          id: item.video.videoId,
          title: item.video.title
        }));

      allVideos = allVideos.concat(items);
      console.log(`${items.length} Videos auf dieser Seite gefunden.`);

      // Nächsten Cursor holen für die Folgeseite
      if (data.cursorNext) {
        currentCursor = data.cursorNext;
        page++;
        // Kurze Pause, um die API zu schonen
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        console.log('Ende des Archivs erreicht.');
        break;
      }
    } catch (error) {
      console.error(`Fehler beim Laden von Seite ${page}:`, error);
      break;
    }
  }

  return allVideos;
}

// 2. TMDB nach dem Film durchsuchen
async function getTmdbData(title) {
  let cleanTitle = title
    .replace(/\[.*?\]|\(.*?\)/g, '')
    .replace(/ganzer film|kostenlos|auf deutsch|full movie|hd|in voller länge/gi, '')
    .trim();

  const searchUrl = `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(cleanTitle)}&language=de-DE`;
  
  try {
    const data = await fetchJson(searchUrl);
    if (data.results && data.results.length > 0) {
      const match = data.results[0];
      if (!match.backdrop_path) return null; // Wichtig für edle Querformat-Bilder

      return {
        title: match.title,
        genres: match.genre_ids,
        year: match.release_date ? match.release_date.split('-')[0] : 'Unbekannt',
        description: match.overview,
        backdropPath: match.backdrop_path
      };
    }
  } catch (error) {
    console.error(`TMDB Fehler für: ${cleanTitle}`, error);
  }
  return null;
}

// 3. Cover sichern
async function downloadCover(backdropPath, youtubeId) {
  const imgUrl = `https://image.tmdb.org/t/p/w780${backdropPath}`;
  const filename = `${youtubeId}.jpg`;
  const destPath = path.join(IMG_DIR, filename);

  try {
    const response = await fetch(imgUrl);
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(destPath, Buffer.from(arrayBuffer));
    return `img/${filename}`;
  } catch (error) {
    return null;
  }
}

// Hauptfunktion
async function main() {
  let existingMovies = [];
  if (fs.existsSync(MOVIES_FILE)) {
    try {
      existingMovies = JSON.parse(fs.readFileSync(MOVIES_FILE, 'utf8'));
    } catch (e) { existingMovies = []; }
  }

  // Dummy filtern
  existingMovies = existingMovies.filter(m => m.id !== 'yt-dummy123');
  const existingIds = new Set(existingMovies.map(m => m.youtubeId));

  // Wir scannen Netzkino (maxPages = 5 holt ca. 150 Videos auf einmal. Kannst du später erhöhen!)
  const videos = await getChannelVideos('UCJ5v_MCY6GNUBTO8-D3XoAg', 5);
  let newCount = 0;

  for (const video of videos) {
    if (existingIds.has(video.id)) continue;

    const tmdb = await getTmdbData(video.title);
    if (tmdb) {
      console.log(`Match gefunden: ${tmdb.title}`);
      const coverUrl = await downloadCover(tmdb.backdropPath, video.id);

      if (coverUrl) {
        existingMovies.push({
          id: `yt-${video.id}`,
          title: tmdb.title,
          youtubeId: video.id,
          genres: tmdb.genres,
          year: tmdb.year,
          description: tmdb.description,
          coverUrl: coverUrl,
          language: 'de'
        });
        newCount++;
        existingIds.add(video.id);
      }
    }
  }

  if (newCount > 0) {
    fs.writeFileSync(MOVIES_FILE, JSON.stringify(existingMovies, null, 2), 'utf8');
    console.log(`Fertig! ${newCount} neue Filme ins Archiv aufgenommen.`);
  } else {
    console.log('Keine neuen passenden Filme gefunden.');
  }
}

main();
