// Cloudflare Pages Function — proxy vers l'API football-data.org.
//
// Convention Cloudflare Pages : un fichier dans functions/api/matches.js
// est automatiquement servi à l'URL  /api/matches
//
// La clé secrète est lue côté SERVEUR via context.env.FOOTBALL_DATA_TOKEN
// (variable d'environnement à configurer dans Cloudflare Pages → Settings →
// Environment variables). Elle n'est JAMAIS renvoyée au navigateur.

export async function onRequest(context) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=300" // petit cache CDN de 5 min
  };

  // Requête "pré-vol" CORS
  if (context.request.method === "OPTIONS") {
    return new Response("", { status: 204, headers });
  }

  // Clé lue côté serveur uniquement (Cloudflare : context.env, PAS process.env)
  const token = context.env && context.env.FOOTBALL_DATA_TOKEN;
  if (!token) {
    return new Response(
      JSON.stringify({ error: "Clé API absente côté serveur (FOOTBALL_DATA_TOKEN non configurée)." }),
      { status: 500, headers }
    );
  }

  try {
    // WC = code de la Coupe du Monde chez football-data.org
    const apiRes = await fetch("https://api.football-data.org/v4/competitions/WC/matches", {
      headers: { "X-Auth-Token": token }
    });

    // On lit le corps en texte puis on tente le JSON (robuste si réponse non-JSON)
    const text = await apiRes.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!apiRes.ok) {
      return new Response(
        JSON.stringify({
          error: "L'API Football-Data a renvoyé une erreur.",
          status: apiRes.status,
          message: (data && (data.message || data.error)) || apiRes.statusText
        }),
        { status: apiRes.status, headers }
      );
    }

    // Succès : on renvoie le JSON des matchs tel quel
    return new Response(JSON.stringify(data), { status: 200, headers });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Impossible de contacter l'API Football-Data.", detail: String(err) }),
      { status: 502, headers }
    );
  }
}
