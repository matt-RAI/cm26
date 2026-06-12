// ============================================================
// Cloudflare WORKER — e-mail quotidien "Morning Resumay" CM26.
//
// Déclenché par le Cron Trigger (voir wrangler.toml) à 8h Paris. Étapes :
//   1. S'assurer que la capsule du jour existe : appelle /api/resumay?generate=1
//      (réutilise TOUTE la logique existante des Pages : résultats + affiches,
//       prompt Claude, stockage Supabase, verrou 1/jour). Récupère le texte.
//   2. Anti-doublon ATOMIQUE : "réclame" l'envoi du jour via la colonne emailed_at
//      de la table resumay (passe NULL -> maintenant). Si déjà réclamé -> on s'arrête.
//   3. Liste des membres : e-mails (API admin Supabase) + pseudos (table profiles).
//   4. Construit un e-mail HTML aux couleurs CM26 et l'envoie via Resend à chacun
//      (en parallèle, un échec n'empêche pas les autres).
//
// Toutes les clés sont lues côté serveur (env), jamais exposées.
// ============================================================

export default {
  // Déclenchement automatique quotidien (cron).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runDailyEmail(env).then(r => console.log("Morning Resumay e-mail :", JSON.stringify(r)))
    );
  },
  // Déclenchement MANUEL pour tester : GET https://<worker>.workers.dev/?secret=XXX
  // (désactivé tant que RESUMAY_CRON_SECRET n'est pas défini, pour éviter un envoi ouvert).
  async fetch(request, env) {
    if (!env.RESUMAY_CRON_SECRET) {
      return new Response("Déclenchement manuel désactivé. Définis le secret RESUMAY_CRON_SECRET sur le Worker pour l'activer.", { status: 403 });
    }
    const url = new URL(request.url);
    if (url.searchParams.get("secret") !== env.RESUMAY_CRON_SECRET) {
      return new Response("secret invalide", { status: 401 });
    }
    const result = await runDailyEmail(env);
    return new Response(JSON.stringify(result, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }
};

// Date du jour "AAAA-MM-JJ" au fuseau de Paris (même clé que la table resumay).
function parisDay() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });
}
// Échappe le HTML (le texte de la capsule vient de l'IA -> on le neutralise).
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
// Petit wrapper REST Supabase (clé service_role, serveur uniquement).
function sb(base, service, path, init) {
  return fetch(base + "/rest/v1/" + path, {
    ...init,
    headers: {
      apikey: service,
      Authorization: "Bearer " + service,
      "Content-Type": "application/json",
      ...(init && init.headers)
    }
  });
}

async function runDailyEmail(env) {
  const SITE = env.SITE_URL || "https://cm26.workplay.fr";
  const SB = env.SUPABASE_URL;
  const SERVICE = env.SUPABASE_SERVICE_ROLE;
  const RESEND = env.RESEND_API_KEY;
  const FROM = env.MAIL_FROM || "CM26 <cm26@workplay.fr>";
  if (!SB || !SERVICE) return { error: "SUPABASE_URL / SUPABASE_SERVICE_ROLE manquantes." };
  if (!RESEND) return { error: "RESEND_API_KEY manquante." };

  const day = parisDay();

  // 1) S'assurer que la capsule du jour existe (réutilise la logique des Pages).
  let capsule = "";
  try {
    const secret = env.RESUMAY_CRON_SECRET ? "&secret=" + encodeURIComponent(env.RESUMAY_CRON_SECRET) : "";
    const r = await fetch(SITE + "/api/resumay?generate=1" + secret, { method: "POST" });
    const d = await r.json().catch(() => ({}));
    if (d && d.text) capsule = d.text;
  } catch (e) { /* on tente la lecture directe ci-dessous */ }

  // Repli : lire la capsule du jour directement en base si l'appel n'a rien donné.
  if (!capsule) {
    try {
      const r = await sb(SB, SERVICE, "resumay?day=eq." + day + "&select=text");
      const rows = await r.json().catch(() => []);
      if (rows && rows[0] && rows[0].text) capsule = rows[0].text;
    } catch (e) {}
  }
  if (!capsule) return { error: "Pas de capsule disponible pour " + day + " (génération échouée ?)." };

  // 2) Anti-doublon ATOMIQUE : on réclame l'envoi du jour (emailed_at NULL -> maintenant).
  //    Si aucune ligne renvoyée -> déjà envoyé aujourd'hui -> on s'arrête.
  let claimed = [];
  try {
    const claim = await sb(SB, SERVICE, "resumay?day=eq." + day + "&emailed_at=is.null", {
      method: "PATCH",
      headers: { "Prefer": "return=representation" },
      body: JSON.stringify({ emailed_at: new Date().toISOString() })
    });
    claimed = await claim.json().catch(() => []);
  } catch (e) {
    return { error: "Échec de la réservation anti-doublon : " + String(e) };
  }
  if (!Array.isArray(claimed) || claimed.length === 0) {
    return { skipped: true, reason: "e-mail déjà envoyé aujourd'hui (" + day + ")." };
  }

  // 3) Liste des membres (e-mails + pseudos).
  const members = await listMembers(SB, SERVICE);
  if (!members.length) return { error: "Aucun membre avec e-mail trouvé." };

  // 4) Envoi via Resend, en parallèle, échecs isolés.
  const subject = "☀️ Morning Resumay — CM26";
  const sends = await Promise.allSettled(members.map(m =>
    sendEmail(RESEND, FROM, m.email, subject, emailHTML(m.pseudo, capsule, SITE))
  ));
  let ok = 0;
  sends.forEach((s, i) => {
    if (s.status === "fulfilled" && s.value.ok) ok++;
    else if (s.status === "rejected") console.log("Échec envoi", members[i].email, String(s.reason));
    else console.log("Resend a refusé", members[i].email, s.value.detail);
  });

  return { day, destinataires: members.length, envoyes: ok, echecs: members.length - ok };
}

// Récupère les membres : e-mails via l'API admin Auth, pseudos via la table profiles.
async function listMembers(base, service) {
  let users = [];
  try {
    const r = await fetch(base + "/auth/v1/admin/users?page=1&per_page=200", {
      headers: { apikey: service, Authorization: "Bearer " + service }
    });
    const d = await r.json().catch(() => ({}));
    users = Array.isArray(d.users) ? d.users : (Array.isArray(d) ? d : []);
  } catch (e) { users = []; }

  const pseudoById = {};
  try {
    const r = await sb(base, service, "profiles?select=id,pseudo");
    const rows = await r.json().catch(() => []);
    (rows || []).forEach(p => { if (p && p.id) pseudoById[p.id] = p.pseudo; });
  } catch (e) {}

  const seen = new Set();
  const out = [];
  for (const u of users) {
    if (!u || !u.email || seen.has(u.email)) continue;
    seen.add(u.email);
    out.push({ email: u.email, pseudo: pseudoById[u.id] || "" });
  }
  return out;
}

// Envoie un e-mail via Resend. Renvoie {ok:true} ou {ok:false, detail}.
async function sendEmail(apiKey, from, to, subject, html) {
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], reply_to: "cm26@workplay.fr", subject, html })
    });
    if (!r.ok) return { ok: false, detail: (await r.text()).slice(0, 200) };
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}

// Gabarit HTML de l'e-mail (tables + styles inline = compatible clients mail).
function emailHTML(pseudo, capsule, site) {
  const hi = pseudo ? "Bonjour " + esc(pseudo) + " 👋" : "Bonjour 👋";
  const body = esc(capsule).replace(/\n/g, "<br>");
  return '<!doctype html><html lang="fr"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
    '<body style="margin:0;background:#071124;font-family:Arial,Helvetica,sans-serif;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#071124;padding:24px 12px;"><tr><td align="center">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#f5f2e8;border-radius:16px;overflow:hidden;border:2px solid #0a1733;">' +
    '<tr><td style="background:#0a1733;padding:18px 24px;">' +
    '<span style="color:#ffce3a;font-size:22px;font-weight:bold;">☀️ Morning Resumay</span>' +
    '<span style="color:#f5f2e8;font-size:13px;"> — CM26</span></td></tr>' +
    '<tr><td style="padding:22px 24px 6px;color:#0a1733;font-size:16px;font-weight:bold;">' + hi + '</td></tr>' +
    '<tr><td style="padding:4px 24px 18px;color:#26344f;font-size:15px;line-height:1.55;">' + body + '</td></tr>' +
    '<tr><td style="padding:0 24px 24px;" align="center">' +
    '<a href="' + esc(site) + '" style="display:inline-block;background:#ef2b3d;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:12px 22px;border-radius:11px;">Voir les matchs du jour &rarr;</a>' +
    '</td></tr>' +
    '<tr><td style="background:#efe9d8;padding:16px 24px;color:#6f6657;font-size:12px;line-height:1.5;">' +
    'Tu reçois cet e-mail parce que tu es membre de CM26 (le concours de pronos entre amis 🦅).<br>' +
    'Pour ne plus recevoir le Morning Resumay, réponds simplement <b>STOP</b> à cet e-mail.' +
    '</td></tr></table>' +
    '<div style="color:#6f87b6;font-size:11px;margin-top:14px;">CM26 · cm26.workplay.fr</div>' +
    '</td></tr></table></body></html>';
}
