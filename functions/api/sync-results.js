// Cloudflare Pages Function — synchronise les résultats des matchs terminés
// depuis football-data.org vers la table Supabase "match_results".
//
// URL : /api/sync-results
// Lit les clés côté SERVEUR (jamais renvoyées) :
//   - context.env.FOOTBALL_DATA_TOKEN  (API football-data)
//   - context.env.SUPABASE_SERVICE_ROLE (clé secrète Supabase, bypass RLS)
//
// La clé service_role contourne les RLS : l'écriture serveur passe.
// Le client, lui, ne fait que LIRE match_results.

const SUPABASE_URL = "https://rmlzmsywimctqzypzget.supabase.co";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8"
};

export async function onRequest(context) {
  if (context.request.method === "OPTIONS") {
    return new Response("", { status: 204, headers: CORS });
  }

  const token = context.env && context.env.FOOTBALL_DATA_TOKEN;
  const service = context.env && context.env.SUPABASE_SERVICE_ROLE;
  if (!token)   return new Response(JSON.stringify({ error: "FOOTBALL_DATA_TOKEN absente côté serveur." }), { status: 500, headers: CORS });
  if (!service) return new Response(JSON.stringify({ error: "SUPABASE_SERVICE_ROLE absente côté serveur." }), { status: 500, headers: CORS });

  // --- A) Récupérer les matchs depuis football-data.org ---
  let matches = [];
  try {
    const r = await fetch("https://api.football-data.org/v4/competitions/WC/matches", {
      headers: { "X-Auth-Token": token }
    });
    const t = await r.text();
    let data; try { data = JSON.parse(t); } catch { data = {}; }
    if (!r.ok) {
      return new Response(JSON.stringify({ error: "API football-data a refusé.", status: r.status, message: (data && data.message) || "" }), { status: r.status, headers: CORS });
    }
    matches = Array.isArray(data.matches) ? data.matches : [];
  } catch (e) {
    return new Response(JSON.stringify({ error: "Impossible de contacter football-data.", detail: String(e) }), { status: 502, headers: CORS });
  }

  // --- B) Garder uniquement les matchs réellement terminés avec un score ---
  const rows = matches.filter(m => {
    const ft = m && m.score && m.score.fullTime;
    return m.status === "FINISHED" && ft && ft.home != null && ft.away != null;
  }).map(m => ({
    match_id: String(m.id),
    real_home: m.score.fullTime.home,
    real_away: m.score.fullTime.away,
    status: "FINISHED",
    updated_at: new Date().toISOString()
  }));

  const finished = rows.length;
  if (!finished) {
    return new Response(JSON.stringify({ updated: 0, finished: 0 }), { status: 200, headers: CORS });
  }

  // --- C) UPSERT en masse dans Supabase (sur la PK match_id) ---
  try {
    const sr = await fetch(SUPABASE_URL + "/rest/v1/match_results?on_conflict=match_id", {
      method: "POST",
      headers: {
        "apikey": service,
        "Authorization": "Bearer " + service,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify(rows)
    });
    if (!sr.ok) {
      const et = await sr.text();
      return new Response(JSON.stringify({ error: "Supabase a refusé l'upsert.", status: sr.status, detail: et.slice(0, 300) }), { status: sr.status, headers: CORS });
    }
    // --- D) Résumé ---
    return new Response(JSON.stringify({ updated: finished, finished }), { status: 200, headers: CORS });
  } catch (e) {
    return new Response(JSON.stringify({ error: "Impossible d'écrire dans Supabase.", detail: String(e) }), { status: 502, headers: CORS });
  }
}
