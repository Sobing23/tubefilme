const fs = require('fs');
const path = require('path');

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const MOVIES_FILE = path.join(__dirname, 'filme.json');
const IMG_DIR = path.join(__dirname, 'img');
const YT_DATA_FILE = path.join(__dirname, 'youtube-daten.jsonl');

if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP Fehler: ${response.status}`);
  return response.json();
}

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
      if (!match.backdrop_path) return null;
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

async function main() {
  console.log("Lese extrahiertes YouTube-Archiv von yt-dlp...");
  
  if (!fs.existsSync(YT_DATA_FILE)) {
    console.error("Fehler: youtube-daten.jsonl wurde nicht gefunden.");
    return;
  }

  // Die von yt-dlp erstellte Datei auslesen
  const fileContent = fs.readFileSync(YT_DATA_FILE, 'utf-8');
  const lines = fileContent.split('\n').filter(line => line.trim() !== '');
  
  const videos = [];
  for (const line of lines) {
    try {
      const videoData = JSON.parse(line);
      if (videoData.id && videoData.title) {
        videos.push({ id: videoData.id, title: videoData.title });
      }
    } catch (e) {}
  }

  console.log(`${videos.length} Videos erfolgreich aus dem YouTube-Archiv geladen.`);

  let existingMovies = [];
  if (fs.existsSync(MOVIES_FILE)) {
    try { existingMovies = JSON.parse(fs.readFileSync(MOVIES_FILE, 'utf8')); } 
    catch (e) { existingMovies = []; }
  }
  
  // Dummy entfernen und existierende IDs merken
  existingMovies = existingMovies.filter(m => m.id !== 'yt-dummy123');
  const existingIds = new Set(existingMovies.map(m => m.youtubeId));

  let newCount = 0;
  let tmdbRequests = 0;

  for (const video of videos) {
    if (existingIds.has(video.id)) continue;

    // Schutz vor TMDB-Überlastung (max 200 neue Filme pro Durchlauf)
    if (tmdbRequests >= 200) {
        console.log("Limit von 200 TMDB-Abfragen erreicht. Der Rest folgt im nächsten Durchlauf!");
        break;
    }

    tmdbRequests++;
    console.log(`Prüfe neuen Film: ${video.title}`);
    
    const tmdb = await getTmdbData(video.title);
    if (tmdb) {
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
    
    // Ganz kurze Pause, um die TMDB-API nicht zu blockieren
    await new Promise(r => setTimeout(r, 200)); 
  }

  if (newCount > 0) {
    fs.writeFileSync(MOVIES_FILE, JSON.stringify(existingMovies, null, 2), 'utf8');
    console.log(`Fertig! ${newCount} neue Filme ins Archiv aufgenommen.`);
  } else {
    console.log('Keine neuen passenden Filme gefunden.');
  }
}

main();
