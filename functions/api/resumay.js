// Cloudflare Pages Function — "Morning Resumay" : capsule foot drôle générée par l'IA.
//
// Convention Cloudflare Pages : ce fichier functions/api/resumay.js est servi à /api/resumay
//
//   GET  /api/resumay
//        → renvoie la DERNIÈRE capsule (pour l'affichage sur le site).
//        Effet de bord : si aucune capsule n'existe pour AUJOURD'HUI, déclenche une
//        génération EN ARRIÈRE-PLAN (le 1er visiteur du matin la lance, les suivants lisent).
//
//   POST /api/resumay   (ou GET /api/resumay?generate=1)
//        → génère MAINTENANT (synchrone) et renvoie la capsule. Respecte le verrou
//        "1 capsule / jour". Si RESUMAY_CRON_SECRET est défini, exige &secret=... .
//
//   GET  /api/resumay?generate=1&force=1&secret=...
//        → régénère même si la capsule du jour existe déjà (tests). Exige le secret.
//
// DÉCLENCHEMENT QUOTIDIEN — méthode retenue : "première visite du jour" (PAS de cron).
//   Les Cron Triggers Cloudflare ne sont pas fiables sur Pages Functions, donc on s'en
//   passe : chaque chargement du site appelle GET /api/resumay, qui régénère si la
//   dernière capsule date d'avant aujourd'hui. Protection robuste contre les coûts IA :
//   la table "resumay" a une contrainte UNIQUE sur "day" → au plus UN appel Claude
//   (payant) par jour, même si 100 visiteurs arrivent en même temps (verrou atomique).
//
// Clés lues côté SERVEUR uniquement (jamais renvoyées au navigateur) :
//   context.env.ANTHROPIC_API_KEY      → clé API Claude
//   context.env.SUPABASE_SERVICE_ROLE  → écriture Supabase (bypass RLS) — déjà configurée
//   context.env.RESUMAY_CRON_SECRET    → optionnel : protège la génération forcée

const SUPABASE_URL = "https://rmlzmsywimctqzypzget.supabase.co";
const MODEL = "claude-haiku-4-5-20251001";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store" // jamais mis en cache CDN : on veut déclencher la génération
};

// Persona + consignes de l'Aigle (humoriste foot décalé).
const SYSTEM =
  "Tu es l'Aigle 🦅, consultant foot survolté et pince-sans-rire de CM26, dans l'esprit " +
  "d'un humoriste sportif décalé à la française (absurde, irrévérencieux, la vanne qui fait " +
  "mouche, jamais méchant). En français. On te donne les résultats récents et les affiches " +
  "du jour de la Coupe du Monde 2026. Écris un mini-résumé fluide de 4 à 6 phrases " +
  "(max 110 mots) qui décrypte l'actu avec vraie expertise ET humour absurde : commente les " +
  "scores marquants, glisse une vanne ciblée, salue un exploit ou moque une déroute, tease " +
  "une affiche du jour. Termine par une punchline. Pas de liste, pas de titre, pas d'emoji. " +
  "IMPORTANT (temporalité) — on te donne DEUX listes avec les heures réelles de Paris. " +
  "(1) Les matchs DÉJÀ JOUÉS sont des RÉSULTATS : certains ont eu lieu cette nuit. Tu peux dire " +
  "\"cette nuit\" pour un match nocturne (vers 0h-6h), \"hier soir\" pour un match en soirée, " +
  "en cohérence avec l'heure fournie ; ne les présente JAMAIS comme \"à venir\". Si le score " +
  "n'est pas confirmé, n'en invente pas. " +
  "(2) Les matchs À VENIR se jouent plus tard aujourd'hui : cite l'heure exacte (\"ce soir à 21h\", " +
  "\"cet après-midi à 15h\") d'après l'heure fournie. N'écris JAMAIS \"ce matin\" pour un match " +
  "de l'après-midi ou du soir. La capsule est lue le matin (~8h) : ne confonds pas le moment de " +
  "lecture avec l'heure réelle des matchs.";

// Date du jour "AAAA-MM-JJ" au fuseau de Paris (clé d'unicité de la capsule).
function parisDay() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });
}
function teamName(t) { return (t && (t.shortName || t.name)) || "?"; }
// Heure de Paris "HHhMM" d'un match (depuis utcDate), pour situer correctement les affiches.
function parisHour(utc) {
  try {
    return new Date(utc).toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" }).replace(":", "h");
  } catch (e) { return ""; }
}

// Petit wrapper REST Supabase avec la clé service_role (serveur uniquement).
function sb(service, path, init) {
  return fetch(SUPABASE_URL + "/rest/v1/" + path, {
    ...init,
    headers: {
      "apikey": service,
      "Authorization": "Bearer " + service,
      "Content-Type": "application/json",
      ...(init && init.headers)
    }
  });
}

// Dernière capsule enregistrée (la plus récente).
async function latestCapsule(service) {
  const r = await sb(service, "resumay?select=text,day&order=day.desc&limit=1");
  if (!r.ok) return null;
  const rows = await r.json().catch(() => []);
  return (rows && rows[0]) || null;
}

// Construit le contexte texte (noms + scores) à partir de l'API matchs déjà en place.
async function buildContext(origin) {
  let matches = [];
  try {
    const r = await fetch(origin + "/api/matches");
    const d = await r.json();
    matches = Array.isArray(d.matches) ? d.matches : [];
  } catch (e) { matches = []; }

  // On catégorise par l'HEURE RÉELLE : coup d'envoi (utcDate) AVANT / APRÈS maintenant.
  const now = Date.now();
  const since = now - 30 * 60 * 60 * 1000; // ~30 h en arrière (hier soir + nuit déjà joués)
  const until = now + 24 * 60 * 60 * 1000; // prochaines ~24 h (affiches à venir)
  const kickoff = m => { const t = new Date(m.utcDate).getTime(); return isFinite(t) ? t : NaN; };

  // PASSÉS = coup d'envoi déjà passé. Vrai score si dispo (FINISHED) ; sinon, prudence.
  const played = matches
    .filter(m => { const t = kickoff(m); return isFinite(t) && t < now && t >= since; })
    .sort((a, b) => kickoff(a) - kickoff(b))
    .map(m => {
      const h = parisHour(m.utcDate);
      const ft = m && m.score && m.score.fullTime;
      const hasScore = m.status === "FINISHED" && ft && ft.home != null && ft.away != null;
      if (hasScore) {
        return `${teamName(m.homeTeam)} ${ft.home}-${ft.away} ${teamName(m.awayTeam)}` + (h ? ` (joué à ${h}, heure de Paris)` : " (joué)");
      }
      // Coup d'envoi passé mais score pas encore confirmé : on le signale SANS inventer.
      return `${teamName(m.homeTeam)} - ${teamName(m.awayTeam)}` + (h ? ` (coup d'envoi à ${h}, score pas encore confirmé)` : " (score pas encore confirmé)");
    });

  // À VENIR = coup d'envoi après maintenant, dans les ~24 h. Heure réelle de Paris.
  const upcoming = matches
    .filter(m => { const t = kickoff(m); return isFinite(t) && t >= now && t <= until; })
    .sort((a, b) => kickoff(a) - kickoff(b))
    .map(m => {
      const h = parisHour(m.utcDate);
      return `${teamName(m.homeTeam)} - ${teamName(m.awayTeam)}` + (h ? ` (à ${h}, heure de Paris)` : "");
    });

  let ctx = "";
  if (played.length)   ctx += "Matchs DÉJÀ JOUÉS (résultats à raconter ; certains ont eu lieu cette nuit) — Coupe du Monde 2026 :\n" + played.join("\n") + "\n\n";
  if (upcoming.length) ctx += "Matchs À VENIR aujourd'hui (à teaser, heures réelles de Paris) :\n" + upcoming.join("\n") + "\n\n";
  if (!ctx) ctx = "Aucun match récemment joué et aucune affiche dans les prochaines 24 h en Coupe du Monde 2026. Fais une courte capsule de réveil pleine d'humour qui fait patienter les fans.\n\n";
  return ctx;
}

// Appel à l'API Anthropic (côté serveur, clé jamais exposée).
async function callClaude(apiKey, ctx) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      system: SYSTEM,
      messages: [{ role: "user", content: ctx + "Donne ta capsule du matin (4 à 6 phrases, max 110 mots)." }]
    })
  });
  if (!r.ok) throw new Error("Anthropic " + r.status + " : " + (await r.text()).slice(0, 300));
  const d = await r.json();
  const text = (d.content || []).filter(b => b.type === "text").map(b => b.text).join(" ").trim();
  if (!text) throw new Error("réponse Claude vide");
  return text;
}

// Génère (au plus une fois) la capsule du jour. La contrainte UNIQUE sur "day" sert de
// verrou atomique : si deux requêtes arrivent ensemble, une seule réserve la journée et
// appelle Claude ; l'autre reçoit un 409 et s'arrête (zéro double facturation).
async function generateToday(context, opts) {
  const force = opts && opts.force;
  const env = context.env;
  const service = env.SUPABASE_SERVICE_ROLE;
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return { error: "ANTHROPIC_API_KEY absente côté serveur." };
  const day = parisDay();

  if (force) {
    await sb(service, "resumay?day=eq." + day, { method: "DELETE", headers: { "Prefer": "return=minimal" } });
  }

  // 1) Réserver la journée (ligne sans texte). 409 = déjà réservée -> on n'appelle PAS Claude.
  const claim = await sb(service, "resumay", {
    method: "POST",
    headers: { "Prefer": "return=minimal" },
    body: JSON.stringify({ day })
  });
  if (claim.status === 409) {
    const ex = await latestCapsule(service);
    return { text: (ex && ex.text) || null, day, already: true };
  }
  if (!claim.ok) {
    return { error: "Supabase (réservation) " + claim.status + " : " + (await claim.text()).slice(0, 200) };
  }

  // 2) On possède la journée : on génère le texte.
  const origin = new URL(context.request.url).origin;
  let text;
  try {
    const ctx = await buildContext(origin);
    text = await callClaude(apiKey, ctx);
  } catch (e) {
    // Échec : on libère le verrou pour réessayer à la prochaine visite.
    await sb(service, "resumay?day=eq." + day, { method: "DELETE", headers: { "Prefer": "return=minimal" } });
    return { error: "Génération échouée : " + (e.message || String(e)) };
  }

  // 3) On remplit la ligne réservée.
  const upd = await sb(service, "resumay?day=eq." + day, {
    method: "PATCH",
    headers: { "Prefer": "return=minimal" },
    body: JSON.stringify({ text })
  });
  if (!upd.ok) {
    return { error: "Supabase (écriture) " + upd.status + " : " + (await upd.text()).slice(0, 200) };
  }
  return { text, day };
}

export async function onRequest(context) {
  const req = context.request;
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });

  const env = context.env || {};
  const service = env.SUPABASE_SERVICE_ROLE;
  if (!service) {
    return new Response(JSON.stringify({ error: "SUPABASE_SERVICE_ROLE absente côté serveur." }), { status: 500, headers: CORS });
  }

  const url = new URL(req.url);
  const wantGenerate = req.method === "POST" || url.searchParams.get("generate") === "1";
  const force = url.searchParams.get("force") === "1";

  // --- Mode GÉNÉRATION (manuel / test / cron externe éventuel) : synchrone ---
  if (wantGenerate) {
    const secret = env.RESUMAY_CRON_SECRET;
    if (secret && url.searchParams.get("secret") !== secret) {
      return new Response(JSON.stringify({ error: "Secret invalide." }), { status: 401, headers: CORS });
    }
    if (force && !secret) {
      return new Response(JSON.stringify({ error: "force=1 nécessite RESUMAY_CRON_SECRET configuré, puis &secret=..." }), { status: 400, headers: CORS });
    }
    const out = await generateToday(context, { force });
    return new Response(JSON.stringify(out), { status: out.error ? 500 : 200, headers: CORS });
  }

  // --- Mode LECTURE (par défaut) : renvoie la dernière capsule ---
  const latest = await latestCapsule(service);
  const today = parisDay();
  // Première visite du jour : on lance la génération en arrière-plan (sans bloquer la réponse).
  if (env.ANTHROPIC_API_KEY && (!latest || latest.day < today)) {
    context.waitUntil(generateToday(context, { force: false }));
  }
  return new Response(
    JSON.stringify({ text: (latest && latest.text) || null, day: (latest && latest.day) || null }),
    { status: 200, headers: CORS }
  );
}
