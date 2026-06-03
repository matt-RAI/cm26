// Fonction Netlify (format v2 "moderne") — proxy vers l'API Football-Data.org.
//
// Rôle : appeler l'API depuis le SERVEUR pour ne JAMAIS exposer la clé secrète
// dans le navigateur. La clé est lue uniquement via process.env.FOOTBALL_DATA_TOKEN
// (variable d'environnement configurée dans Netlify).
//
// URL une fois déployée : https://cm26-app.netlify.app/.netlify/functions/matches

export default async (request) => {
  // En-têtes communs : autorise l'appel depuis le navigateur (CORS) + réponse JSON.
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=300" // petit cache de 5 min côté CDN
  };

  // Requête "pré-vol" CORS envoyée automatiquement par certains navigateurs.
  if (request.method === "OPTIONS") {
    return new Response("", { status: 204, headers });
  }

  // La clé secrète est lue côté serveur uniquement.
  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) {
    return new Response(
      JSON.stringify({ error: "Clé API absente côté serveur (FOOTBALL_DATA_TOKEN non configurée)." }),
      { status: 500, headers }
    );
  }

  try {
    // WC = code de la Coupe du Monde chez football-data.org.
    const apiRes = await fetch("https://api.football-data.org/v4/competitions/WC/matches", {
      headers: { "X-Auth-Token": token }
    });

    // On lit d'abord le corps en texte, puis on tente de le parser en JSON
    // (robuste même si l'API renvoie une page d'erreur non-JSON).
    const text = await apiRes.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    // L'API a répondu par une erreur (quota dépassé, clé invalide, compétition indispo…).
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

    // Succès : on renvoie tel quel le JSON des matchs au client.
    return new Response(JSON.stringify(data), { status: 200, headers });
  } catch (err) {
    // Erreur réseau / fonction : on renvoie un message clair sans crasher.
    return new Response(
      JSON.stringify({ error: "Impossible de contacter l'API Football-Data.", detail: String(err) }),
      { status: 502, headers }
    );
  }
};
