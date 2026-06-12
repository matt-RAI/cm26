// Fonction Netlify PLANIFIÉE — génère chaque matin la capsule « Morning Resumay ».
//
// Tout se passe CÔTÉ SERVEUR : la clé API Anthropic n'est JAMAIS exposée au navigateur.
// Déroulé :
//   1. récupère les matchs (via la fonction "matches" déjà en place) ;
//   2. isole ceux terminés "cette nuit" (status FINISHED, < ~20 h) ;
//   3. demande à Claude (Haiku 4.5) un petit texte drôle qui décrypte la nuit ;
//   4. enregistre le texte dans Supabase (table "resumay").
//
// Le site (index.html) se contente ensuite de LIRE la dernière ligne de cette table.
//
// Variables d'environnement Netlify requises :
//   ANTHROPIC_API_KEY      → ta clé Anthropic (console.anthropic.com)
//   SUPABASE_URL           → https://rmlzmsywimctqzypzget.supabase.co
//   SUPABASE_SERVICE_ROLE  → clé "service_role" Supabase (secrète, serveur uniquement)

const SITE = "https://cm26-app.netlify.app";

// Persona + consignes : Claude joue l'Aigle, humoriste foot décalé.
const SYSTEM =
  "Tu es l'Aigle 🦅, consultant foot survolté et pince-sans-rire de CM26, dans l'esprit " +
  "d'un humoriste sportif décalé à la française (absurde, irrévérencieux, la vanne qui fait " +
  "mouche, jamais méchant). En français. On te donne les résultats des matchs de la nuit de " +
  "la Coupe du Monde 2026. Écris un mini-résumé fluide de 4 à 6 phrases (max 110 mots) qui " +
  "décrypte la nuit avec vraie expertise ET humour absurde : commente les scores marquants, " +
  "glisse une vanne ciblée, salue un exploit ou moque une déroute. Termine par une punchline. " +
  "Pas de liste, pas de titre, pas d'emoji.";

function teamName(t){ return (t && (t.shortName || t.name)) || "?"; }

export default async () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const sbUrl  = process.env.SUPABASE_URL;
  const sbKey  = process.env.SUPABASE_SERVICE_ROLE;
  if (!apiKey || !sbUrl || !sbKey) {
    return new Response(
      JSON.stringify({ error: "Variables d'environnement manquantes (ANTHROPIC_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_ROLE)." }),
      { status: 500 }
    );
  }

  // 1 + 2. Matchs terminés dans les ~20 dernières heures = "la nuit".
  let nightLines = [];
  try {
    const res = await fetch(SITE + "/.netlify/functions/matches");
    const data = await res.json();
    const matches = data.matches || [];
    const since = Date.now() - 20 * 60 * 60 * 1000;
    nightLines = matches
      .filter(m => m.status === "FINISHED")
      .filter(m => { const t = new Date(m.utcDate).getTime(); return isFinite(t) && t >= since; })
      .map(m => {
        const sc = (m.score && m.score.fullTime) || {};
        return `${teamName(m.homeTeam)} ${sc.home}-${sc.away} ${teamName(m.awayTeam)}`;
      });
  } catch (e) {
    // Pas grave : sans résultats, on demandera une capsule "réveil".
  }

  const ctx = nightLines.length
    ? "Résultats de la nuit (Coupe du Monde 2026) :\n" + nightLines.join("\n")
    : "Aucun match terminé cette nuit en Coupe du Monde 2026. Fais une courte capsule de réveil, pleine d'humour, qui fait patienter les fans jusqu'aux prochaines affiches.";

  // 3. Appel Claude (Haiku 4.5), côté serveur.
  let text;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 400,
        system: SYSTEM,
        messages: [{ role: "user", content: ctx + "\n\nDonne ta capsule du matin." }]
      })
    });
    if (!r.ok) throw new Error("Anthropic " + r.status + " : " + (await r.text()));
    const d = await r.json();
    text = (d.content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
    if (!text) throw new Error("réponse vide");
  } catch (e) {
    return new Response(JSON.stringify({ error: "Génération échouée : " + e.message }), { status: 500 });
  }

  // 4. Enregistre dans Supabase (REST + clé service_role : serveur uniquement, contourne RLS).
  try {
    const r = await fetch(sbUrl + "/rest/v1/resumay", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "apikey": sbKey,
        "authorization": "Bearer " + sbKey,
        "prefer": "return=minimal"
      },
      body: JSON.stringify({ text })
    });
    if (!r.ok) throw new Error("Supabase " + r.status + " : " + (await r.text()));
  } catch (e) {
    return new Response(JSON.stringify({ error: "Sauvegarde Supabase échouée : " + e.message }), { status: 500 });
  }

  return new Response(JSON.stringify({ ok: true, matchs: nightLines.length, text }), { status: 200 });
};

// PLANIFICATION : 06:00 UTC chaque jour = 08:00 à Paris en heure d'été (CEST, le Mondial
// se joue en juin/juillet). En heure d'hiver (CET) ce serait 07:00 Paris ; à ajuster si besoin.
export const config = { schedule: "0 6 * * *" };
