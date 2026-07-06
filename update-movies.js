const fs = require('fs');
const path = require('path');

// Kanäle, die wir überwachen wollen (Start mit Netzkino)
const CHANNELS = [
  { name: 'Netzkino', id: 'UC5twjMskb4YVl9U_S-4wYkw' }
];

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const MOVIES_FILE = path.join(__dirname, 'filme.json');
const IMG_DIR = path.join(__dirname, 'img');

// Hilfsfunktion für fetch im alten Node.js Stil
async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP Fehler: ${response.status}`);
  return response.json();
}

// 1. YouTube RSS Feed auslesen (Ersatz für die YouTube API)
async function getLatestYoutubeVideos(channelId) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  try {
    const response = await fetch(url);
    const xmlText = await response.text();
    
    // Einfaches Regex-Parsing für Video-IDs und Titel aus dem XML
    const videoIds = [...xmlText.matchAll(/<yt:videoId>([^<]+)<\/yt:videoId>/g)].map(m => m[1]);
    const titles = [...xmlText.matchAll(/<title>([^<]+)<\/title>/g)].map(m => m[1]);
    
    // Das erste Element im RSS-Feed ist meist der Kanalname, daher überspringen wir das erste Title-Match
    const videos = [];
    for (let i = 0; i < videoIds.length; i++) {
      videos.push({
        id: videoIds[i],
        title: titles[i + 1] || 'Unbekannter Titel'
      });
    }
    return videos;
  } catch (error) {
    console.error(`Fehler beim Laden des RSS-Feeds für ${channelId}:`, error);
    return [];
  }
}

// 2. TMDB nach dem Film durchsuchen und Metadaten + Querformat-Cover holen
async function getTmdbData(title) {
  // Bereinige den YouTube-Titel (entferne Zusätze wie "Ganzer Film", "HD", etc.)
  let cleanTitle = title
    .replace(/\[.*?\]|\(.*?\)/g, '') // Entfernt Klammern
    .replace(/ganzer film|kostenlos|auf deutsch|full movie|hd|in voller länge/gi, '')
    .trim();

  const searchUrl = `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(cleanTitle)}&language=de-DE`;
  
  try {
    const data = await fetchJson(searchUrl);
    if (data.results && data.results.length > 0) {
      const match = data.results[0]; // Wir nehmen den besten Treffer
      
      // Falls kein Querformat-Bild (backdrop_path) existiert, überspringen wir es
      if (!match.backdrop_path) return null;

      return {
        title: match.title,
        genres: match.genre_ids, // Liefert IDs, die wir später im Frontend mappen können
        year: match.release_date ? match.release_date.split('-')[0] : 'Unbekannt',
        description: match.overview,
        backdropPath: match.backdrop_path
      };
    }
  } catch (error) {
    console.error(`TMDB Suche fehlgeschlagen für: ${cleanTitle}`, error);
  }
  return null;
}

// 3. Cover herunterladen und im Repository speichern
async function downloadCover(backdropPath, youtubeId) {
  const imgUrl = `https://image.tmdb.org/t/p/w780${backdropPath}`;
  const filename = `${youtubeId}.jpg`;
  const destPath = path.join(IMG_DIR, filename);

  try {
    const response = await fetch(imgUrl);
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFileSync(destPath, buffer);
    return `img/${filename}`; // Relativer Pfad für unser JSON
  } catch (error) {
    console.error(`Fehler beim Download des Covers für ${youtubeId}:`, error);
    return null;
  }
}

// Hauptfunktion
async function main() {
  console.log('Starte automatischen Film-Import über RSS...');
  
  // Bestehende Filme laden
  let existingMovies = [];
  if (fs.existsSync(MOVIES_FILE)) {
    try {
      existingMovies = JSON.parse(fs.readFileSync(MOVIES_FILE, 'utf8'));
    } catch (e) {
      existingMovies = [];
    }
  }

  // Wir filtern den Dummy-Eintrag heraus, sobald echte Filme da sind
  existingMovies = existingMovies.filter(m => m.id !== 'yt-dummy123');

  const existingIds = new Set(existingMovies.map(m => m.youtubeId));
  let newMoviesCount = 0;

  for (const channel of CHANNELS) {
    console.log(`Scanne Kanal: ${channel.name}...`);
    const videos = await getLatestYoutubeVideos(channel.id);
    
    for (const video of videos) {
      if (existingIds.has(video.id)) continue; // Film existiert schon, überspringen

      console.log(`Neuer Film gefunden: ${video.title}. Suche auf TMDB...`);
      const tmdbData = await getTmdbData(video.title);

      if (tmdbData) {
        console.log(`TMDB Treffer! Lade Querformat-Cover für "${tmdbData.title}" herunter...`);
        const coverUrl = await downloadCover(tmdbData.backdropPath, video.id);

        if (coverUrl) {
          existingMovies.push({
            id: `yt-${video.id}`,
            title: tmdbData.title,
            youtubeId: video.id,
            genres: tmdbData.genres,
            year: tmdbData.year,
            description: tmdbData.description,
            coverUrl: coverUrl,
            language: 'de'
          });
          newMoviesCount++;
          existingIds.add(video.id);
        }
      } else {
        console.log(`Kein passender TMDB-Eintrag mit Querformat-Bild gefunden für: ${video.title}`);
      }
    }
  }

  if (newMoviesCount > 0) {
    fs.writeFileSync(MOVIES_FILE, JSON.stringify(existingMovies, null, 2), 'utf8');
    console.log(`Erfolg! ${newMoviesCount} neue Filme zur filme.json hinzugefügt.`);
  } else {
    console.log('Keine neuen Filme gefunden.');
  }
}

main();
