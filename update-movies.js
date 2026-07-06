const fs = require('fs');
const path = require('path');

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const MOVIES_FILE = path.join(__dirname, 'filme.json');
const IMG_DIR = path.join(__dirname, 'img');

if (!fs.existsSync(IMG_DIR)) {
  fs.mkdirSync(IMG_DIR, { recursive: true });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP Fehler: ${response.status}`);
  return response.json();
}

// Holt die Videos direkt über das öffentliche YouTube-Frontend (Kein API-Key nötig!)
async function getChannelVideosPublic(channelId) {
  // Wir nutzen die "videos"-Ansicht des Kanals, wo die neuesten Uploads gelistet sind
  const url = `https://www.youtube.com/channel/${channelId}/videos`;
  console.log(`Rufe öffentliche Video-Seite auf für Kanal: ${channelId}...`);
  
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
    });
    const html = await response.text();
    
    // Wir extrahieren das versteckte JSON-Objekt, das YouTube zur Darstellung nutzt
    const match = html.match(/var ytInitialData = ({.*?});<\/script>/);
    if (!match) {
      console.log('Konnte ytInitialData nicht im HTML finden.');
      return [];
    }
    
    const data = JSON.parse(match[1]);
    
    // Tiefer Klick in die YouTube-Datenstruktur, um die Video-Liste zu finden
    const tabs = data.contents.twoColumnBrowseResultsRenderer.tabs;
    const videosTab = tabs.find(tab => tab.tabRenderer && tab.tabRenderer.title === "Videos" || tab.tabRenderer && tab.tabRenderer.selected);
    
    if (!videosTab) {
      console.log('Videos-Tab in den Daten nicht gefunden.');
      return [];
    }
    
    const contents = videosTab.tabRenderer.content.richGridRenderer.contents;
    const videos = [];
    
    for (const item of contents) {
      if (item.richItemRenderer && item.richItemRenderer.content.videoRenderer) {
        const videoRenderer = item.richItemRenderer.content.videoRenderer;
        videos.push({
          id: videoRenderer.videoId,
          title: videoRenderer.title.runs[0].text
        });
      }
    }
    
    console.log(`${videos.length} Videos erfolgreich aus dem Web-Frontend extrahiert.`);
    return videos;
  } catch (error) {
    console.error('Fehler beim Public Scraping:', error);
    return [];
  }
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
  let existingMovies = [];
  if (fs.existsSync(MOVIES_FILE)) {
    try {
      existingMovies = JSON.parse(fs.readFileSync(MOVIES_FILE, 'utf8'));
    } catch (e) { existingMovies = []; }
  }

  existingMovies = existingMovies.filter(m => m.id !== 'yt-dummy123');
  const existingIds = new Set(existingMovies.map(m => m.youtubeId));

  // Wir nutzen die Netzkino Kanal-ID
  const videos = await getChannelVideosPublic('UCJ5v_MCY6GNUBTO8-D3XoAg');
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
