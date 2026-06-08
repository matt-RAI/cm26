// Cloudflare Pages Function — stats ADMIN (métier Supabase + trafic Cloudflare).
// URL : /api/stats
//
// SÉCURITÉ : la fonction vérifie le JWT de l'appelant (token de session Supabase
// envoyé en Authorization: Bearer ...) et n'autorise QUE le compte admin.
// -> L'URL seule ne suffit pas : sans token admin valide, on renvoie 403.
// Les clés (SUPABASE_SERVICE_ROLE, CLOUDFLARE_API_TOKEN) restent côté serveur.

const SUPABASE_URL = "https://rmlzmsywimctqzypzget.supabase.co";
const ADMIN_ID = "a0f61faf-746c-48c8-b70d-dea2f2fd3304";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json; charset=utf-8"
};
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: CORS });

export async function onRequest(context) {
  if (context.request.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });

  const service = context.env && context.env.SUPABASE_SERVICE_ROLE;
  if (!service) return json({ error: "Config serveur incomplète (SUPABASE_SERVICE_ROLE)." }, 500);

  // --- 1) Vérifier que l'appelant est bien l'ADMIN (via son JWT) ---
  const authHeader = context.request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "Non authentifié." }, 401);
  let user = null;
  try {
    const r = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { apikey: service, Authorization: "Bearer " + token }
    });
    if (r.ok) user = await r.json();
  } catch (e) { /* ignore */ }
  if (!user || user.id !== ADMIN_ID) return json({ error: "Accès réservé." }, 403);

  // --- 2) Métriques métier (Supabase REST, clé service_role) ---
  const sb = async (path) => {
    try {
      const r = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
        headers: { apikey: service, Authorization: "Bearer " + service }
      });
      if (!r.ok) return [];
      return await r.json();
    } catch (e) { return []; }
  };

  let metier = {};
  try {
    const [profiles, orgas, members, mpreds, tpreds] = await Promise.all([
      sb("profiles?select=id,created_at&limit=100000"),
      sb("orgas?select=id&limit=100000"),
      sb("orga_members?select=orga_id,user_id&limit=200000"),
      sb("match_predictions?select=user_id&limit=500000"),
      sb("tournament_predictions?select=user_id&limit=100000")
    ]);

    const totalJoueurs = profiles.length;
    const totalOrgas = orgas.length;

    const sizeByOrga = {};
    members.forEach(m => { sizeByOrga[m.orga_id] = (sizeByOrga[m.orga_id] || 0) + 1; });
    const sizes = Object.values(sizeByOrga);
    const tailleMoyenne = sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 0;

    const totalPronosMatch = mpreds.length;
    const totalPronosTournoi = tpreds.length;

    // taux de complétion : profils ayant au moins 1 prono (match OU tournoi)
    const withProno = new Set();
    mpreds.forEach(p => withProno.add(p.user_id));
    tpreds.forEach(p => withProno.add(p.user_id));
    const actifs = profiles.filter(p => withProno.has(p.id)).length;
    const tauxCompletion = totalJoueurs ? Math.round((actifs / totalJoueurs) * 100) : 0;

    // inscriptions par jour (14 derniers jours)
    const days = [];
    const now = Date.now();
    for (let i = 13; i >= 0; i--) days.push(new Date(now - i * 86400000).toISOString().slice(0, 10));
    const inscByDay = {}; days.forEach(d => inscByDay[d] = 0);
    profiles.forEach(p => { const d = p.created_at ? String(p.created_at).slice(0, 10) : null; if (d && d in inscByDay) inscByDay[d]++; });
    const inscriptions = days.map(d => ({ date: d, count: inscByDay[d] }));

    metier = { totalJoueurs, totalOrgas, tailleMoyenne: Math.round(tailleMoyenne * 10) / 10, totalPronosMatch, totalPronosTournoi, tauxCompletion, actifs, inscriptions };
  } catch (e) {
    metier = { error: "Erreur métriques Supabase." };
  }

  // --- 3) Trafic (Cloudflare GraphQL Analytics) — échec sans casser le reste ---
  let trafic = {};
  const cfToken = context.env && context.env.CLOUDFLARE_API_TOKEN;
  const zone = context.env && context.env.CLOUDFLARE_ZONE_ID;
  if (!cfToken || !zone) {
    trafic = { error: "Trafic non configuré (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID)." };
  } else {
    try {
      const until = new Date().toISOString().slice(0, 10);
      const since = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
      const query = `query($zone:String!,$since:Date!,$until:Date!){viewer{zones(filter:{zoneTag:$zone}){httpRequests1dGroups(limit:7,filter:{date_geq:$since,date_leq:$until},orderBy:[date_ASC]){dimensions{date} sum{requests pageViews countryMap{clientCountryName requests}} uniq{uniques}}}}}`;
      const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: { Authorization: "Bearer " + cfToken, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { zone, since, until } })
      });
      const d = await r.json();
      const groups = (((d || {}).data || {}).viewer || {}).zones && d.data.viewer.zones[0]
        ? (d.data.viewer.zones[0].httpRequests1dGroups || []) : [];
      const daily = groups.map(g => ({
        date: g.dimensions.date,
        requests: (g.sum && g.sum.requests) || 0,
        pageViews: (g.sum && g.sum.pageViews) || 0,
        uniques: g.uniq ? g.uniq.uniques : null
      }));
      const totalVisites = daily.reduce((a, g) => a + (g.requests || 0), 0);
      const totalUniques = daily.reduce((a, g) => a + (g.uniques || 0), 0);
      const byCountry = {};
      groups.forEach(g => ((g.sum && g.sum.countryMap) || []).forEach(c => { byCountry[c.clientCountryName] = (byCountry[c.clientCountryName] || 0) + c.requests; }));
      const topPays = Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([pays, requests]) => ({ pays, requests }));
      trafic = { daily, totalVisites, totalUniques, topPays };
      if (d && d.errors && d.errors.length) trafic.warn = d.errors[0].message;
    } catch (e) {
      trafic = { error: "Trafic Cloudflare indisponible." };
    }
  }

  return json({ metier, trafic, generatedAt: new Date().toISOString() });
}
