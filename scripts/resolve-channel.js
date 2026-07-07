// Hilfsskript: aus @handle oder Kanal-URL die channelId (UC...) ermitteln
// Aufruf:  node scripts/resolve-channel.js @kanalname
//    oder: node scripts/resolve-channel.js https://www.youtube.com/@kanalname

const API_KEY = process.env.YOUTUBE_API_KEY;

if (!API_KEY) {
  console.error("Fehler: YOUTUBE_API_KEY ist nicht gesetzt (siehe .env / GitHub Secret).");
  process.exit(1);
}

const input = process.argv[2];
if (!input) {
  console.error("Bitte ein @handle oder eine Kanal-URL angeben.");
  process.exit(1);
}

// @handle aus einer URL oder direkter Eingabe extrahieren
let handle = input.trim();
const match = handle.match(/@([\w.-]+)/);
if (match) handle = "@" + match[1];

async function main() {
  const url = `https://www.googleapis.com/youtube/v3/channels?part=id,snippet&forHandle=${encodeURIComponent(
    handle
  )}&key=${API_KEY}`;

  const res = await fetch(url);
  const json = await res.json();

  if (json.error) {
    console.error("API-Fehler:", JSON.stringify(json.error, null, 2));
    process.exit(1);
  }

  if (!json.items || json.items.length === 0) {
    console.error(`Kein Kanal für "${handle}" gefunden.`);
    process.exit(1);
  }

  const channel = json.items[0];
  console.log(`Name:      ${channel.snippet.title}`);
  console.log(`channelId: ${channel.id}`);
  console.log("");
  console.log("Zum Eintragen in config/channels.json:");
  console.log(
    JSON.stringify({ name: channel.snippet.title, channelId: channel.id }, null, 2)
  );
}

main();
