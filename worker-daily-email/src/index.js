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
    // Route : ?send=announce -> annonce PONCTUELLE (lancement des 16es de finale).
    //          sinon          -> Morning Resumay du jour (comportement par défaut).
    const result = url.searchParams.get("send") === "announce"
      ? await runAnnounce(env)
      : await runDailyEmail(env);
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
// Pause (en ms) : on attend une promesse plutôt qu'un setTimeout "nu" (fiable dans un Worker).
function delay(ms) { return new Promise(res => setTimeout(res, ms)); }
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

  // 2) VERROU atomique (anti-doublon) AVEC réessai possible en cas d'échec :
  //    - emailed_at   = SUCCÈS confirmé (posé seulement à la fin si l'envoi a réussi).
  //    - email_lock_at = verrou "en cours" (TTL ~10 min) : empêche deux exécutions
  //      simultanées d'envoyer en même temps, sans bloquer un réessai si ça échoue.
  //    On prend le verrou si la journée n'est PAS déjà confirmée envoyée ET qu'aucun
  //    verrou frais n'existe (vide, ou périmé -> exécution précédente plantée).
  const LOCK_TTL_MS = 10 * 60 * 1000;
  const lockCutoff = new Date(Date.now() - LOCK_TTL_MS).toISOString();
  let locked;
  try {
    const lock = await sb(
      SB, SERVICE,
      "resumay?day=eq." + day + "&emailed_at=is.null&or=(email_lock_at.is.null,email_lock_at.lt." + lockCutoff + ")",
      {
        method: "PATCH",
        headers: { "Prefer": "return=representation" },
        body: JSON.stringify({ email_lock_at: new Date().toISOString() })
      }
    );
    if (!lock.ok) {
      return { error: "Prise de verrou refusée (HTTP " + lock.status + "). La colonne email_lock_at existe-t-elle ? Lance le SQL." };
    }
    locked = await lock.json().catch(() => null);
  } catch (e) {
    return { error: "Échec de la prise de verrou : " + String(e) };
  }
  if (!Array.isArray(locked)) {
    return { error: "Verrou : réponse inattendue (colonne email_lock_at manquante ? Lance le SQL)." };
  }
  if (locked.length === 0) {
    return { skipped: true, reason: "déjà envoyé aujourd'hui, ou un envoi est déjà en cours (" + day + ")." };
  }

  // 3) Liste des membres (e-mails + pseudos).
  const members = await listMembers(SB, SERVICE);
  if (!members.length) return { error: "Aucun membre avec e-mail trouvé." };

  // 4) Envoi via Resend en respectant la limite Resend de 5 requêtes/seconde :
  //    on envoie par LOTS de 5 (en parallèle dans le lot), avec une pause ~1,1 s
  //    entre chaque lot. Ainsi on ne dépasse jamais 5 envois par seconde.
  const subject = "☀️ Morning Resumay — CM26";
  const BATCH = 5, PAUSE_MS = 1100;
  let ok = 0;
  const echecs = [];
  for (let i = 0; i < members.length; i += BATCH) {
    const lot = members.slice(i, i + BATCH);
    const res = await Promise.allSettled(lot.map(m =>
      sendEmail(RESEND, FROM, m.email, subject, emailHTML(m.pseudo, capsule, SITE))
    ));
    res.forEach((s, j) => {
      const email = lot[j].email;
      if (s.status === "fulfilled" && s.value.ok) { ok++; return; }
      const raison = s.status === "rejected" ? String(s.reason) : s.value.detail;
      echecs.push({ email, raison });
      console.log("Échec envoi", email, raison); // visible via `wrangler tail`
    });
    // Pause entre les lots (pas après le dernier) pour rester sous 5/s.
    if (i + BATCH < members.length) await delay(PAUSE_MS);
  }

  // 5) BILAN : on ne CONFIRME la journée (emailed_at) que si l'essentiel est passé.
  //    Seuil = au moins la MOITIÉ des destinataires (sinon un réessai re-spammerait
  //    ceux qui ont déjà reçu). Sous ce seuil -> on libère le verrou pour réessayer.
  const total = members.length;
  const success = ok > 0 && ok * 2 >= total; // >= 50 % reçus
  try {
    if (success) {
      // Confirmé envoyé -> emailed_at posé -> plus jamais de réessai (donc pas de doublon).
      await sb(SB, SERVICE, "resumay?day=eq." + day, {
        method: "PATCH", headers: { "Prefer": "return=minimal" },
        body: JSON.stringify({ emailed_at: new Date().toISOString() })
      });
    } else {
      // Échec majoritaire -> on LIBÈRE le verrou (emailed_at reste NULL) -> un prochain
      // déclenchement (cron de demain, ou manuel) réessaiera.
      await sb(SB, SERVICE, "resumay?day=eq." + day, {
        method: "PATCH", headers: { "Prefer": "return=minimal" },
        body: JSON.stringify({ email_lock_at: null })
      });
    }
  } catch (e) {
    console.log("Bilan : écriture du statut échouée", String(e));
  }

  // 6) ALERTE admin si au moins un envoi a échoué (pour ne plus découvrir la panne en retard).
  if (echecs.length > 0) {
    await sendAlert(RESEND, FROM, day, total, ok, echecs);
  }

  return { day, destinataires: total, envoyes: ok, echecs: echecs.length, confirme: success, details_echecs: echecs };
}

// ============================================================
// Envoi PONCTUEL d'une annonce (lancement des 16es de finale).
// Réutilise la liste des membres + l'envoi throttlé Resend EXACTEMENT comme
// le Morning Resumay (lots de 5, pause 1,1 s entre les lots, retry 429 dans
// sendEmail) -> on ne dépasse jamais la limite Resend de 5 requêtes/seconde.
// One-shot déclenché à la main : PAS de verrou quotidien (à déclencher une fois).
// ============================================================
async function runAnnounce(env) {
  const SITE = env.SITE_URL || "https://cm26.workplay.fr";
  const SB = env.SUPABASE_URL;
  const SERVICE = env.SUPABASE_SERVICE_ROLE;
  const RESEND = env.RESEND_API_KEY;
  const FROM = env.MAIL_FROM || "CM26 <cm26@workplay.fr>";
  if (!SB || !SERVICE) return { error: "SUPABASE_URL / SUPABASE_SERVICE_ROLE manquantes." };
  if (!RESEND) return { error: "RESEND_API_KEY manquante." };

  const members = await listMembers(SB, SERVICE);
  if (!members.length) return { error: "Aucun membre avec e-mail trouvé." };

  const subject = "⚔️ Les 16es de finale arrivent — à tes pronos !";
  const BATCH = 5, PAUSE_MS = 1100; // 5 envois/s max (limite Resend), comme le Resumay
  let ok = 0;
  const echecs = [];
  for (let i = 0; i < members.length; i += BATCH) {
    const lot = members.slice(i, i + BATCH);
    const res = await Promise.allSettled(lot.map(m =>
      sendEmail(RESEND, FROM, m.email, subject, announceHTML(m.pseudo, SITE))
    ));
    res.forEach((s, j) => {
      const email = lot[j].email;
      if (s.status === "fulfilled" && s.value.ok) { ok++; return; }
      const raison = s.status === "rejected" ? String(s.reason) : s.value.detail;
      echecs.push({ email, raison });
      console.log("Échec envoi annonce", email, raison);
    });
    if (i + BATCH < members.length) await delay(PAUSE_MS); // pas de pause après le dernier lot
  }

  // Alerte admin si au moins un échec (même réflexe que l'e-mail du matin).
  if (echecs.length > 0) {
    await sendAlert(RESEND, FROM, "annonce-16es", members.length, ok, echecs);
  }
  return { type: "announce", destinataires: members.length, envoyes: ok, echecs: echecs.length, details_echecs: echecs };
}

// Gabarit HTML de l'annonce des 16es de finale (mêmes styles inline que le Resumay).
function announceHTML(pseudo, site) {
  const hi = pseudo ? "Salut " + esc(pseudo) + " 👋" : "Salut 👋";
  const para = [
    "La phase de groupes, c'est plié. 🏁 Les valises sont faites pour certains, les choses sérieuses commencent pour les autres : <b>les 16es de finale arrivent !</b>",
    "À partir d'ici, plus de filet : un match nul et hop — prolongations, puis tirs au but, et toi les nerfs en compote. 😬",
    "👉 File poser tes pronos <b>avant le coup d'envoi</b>. Une fois le match lancé, c'est verrouillé — et les regrets, ça ne rapporte aucun point.",
    "Que le meilleur gagne. Et entre nous, le meilleur, c'est sûrement toi. (Ou pas. On verra au classement. 🦅)"
  ].join("<br><br>");
  return '<!doctype html><html lang="fr"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
    '<body style="margin:0;background:#071124;font-family:Arial,Helvetica,sans-serif;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#071124;padding:24px 12px;"><tr><td align="center">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#f5f2e8;border-radius:16px;overflow:hidden;border:2px solid #0a1733;">' +
    '<tr><td style="background:#0a1733;padding:18px 24px;">' +
    '<span style="color:#ffce3a;font-size:22px;font-weight:bold;">⚔️ Phase finale</span>' +
    '<span style="color:#f5f2e8;font-size:13px;"> — CM26</span></td></tr>' +
    '<tr><td style="padding:22px 24px 6px;color:#0a1733;font-size:16px;font-weight:bold;">' + hi + '</td></tr>' +
    '<tr><td style="padding:4px 24px 18px;color:#26344f;font-size:15px;line-height:1.55;">' + para + '</td></tr>' +
    '<tr><td style="padding:0 24px 24px;" align="center">' +
    '<a href="' + esc(site) + '" style="display:inline-block;background:#ef2b3d;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:12px 22px;border-radius:11px;">Faire mes pronos &rarr;</a>' +
    '</td></tr>' +
    '<tr><td style="background:#efe9d8;padding:16px 24px;color:#6f6657;font-size:12px;line-height:1.5;">' +
    'Tu reçois cet e-mail parce que tu es membre de CM26 (le concours de pronos entre amis 🦅).<br>' +
    'Pour ne plus recevoir nos e-mails, réponds simplement <b>STOP</b> à cet e-mail.' +
    '</td></tr></table>' +
    '<div style="color:#6f87b6;font-size:11px;margin-top:14px;">CM26 · cm26.workplay.fr</div>' +
    '</td></tr></table></body></html>';
}

// Alerte admin (Resend) en cas d'échec d'envoi. Si Resend est lui-même injoignable,
// on logue clairement (visible avec `wrangler tail`).
async function sendAlert(apiKey, from, day, total, ok, echecs) {
  const ADMIN = "matthias@workplay.fr";
  const ko = echecs.length;
  const first = echecs[0] ? echecs[0].raison : "(inconnue)";
  const resume = day + " · " + ok + "/" + total + " envoyés · " + ko + " échec(s) · 1re raison : " + first;
  const subject = "⚠️ CM26 — e-mail du matin : " + ko + " échec(s) le " + day;
  const html =
    "<p>L'envoi du Morning Resumay du <b>" + esc(day) + "</b> a rencontré des échecs.</p>" +
    "<ul><li>Destinataires : " + total + "</li><li>Envoyés : " + ok + "</li>" +
    "<li>Échecs : " + ko + "</li><li>1re raison : " + esc(first) + "</li></ul>" +
    "<p>" + (ok * 2 >= total
      ? "Majorité envoyée : journée confirmée (pas de réessai)."
      : "Échec majoritaire : la journée sera réessayée au prochain déclenchement.") + "</p>";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [ADMIN], reply_to: ADMIN, subject, html })
    });
    if (!r.ok) console.log("ALERTE non envoyée (Resend " + r.status + ") :", (await r.text()).slice(0, 160), "|", resume);
  } catch (e) {
    console.log("ALERTE non envoyée (Resend injoignable) :", String(e), "|", resume);
  }
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
// Filet de sécurité : si on prend quand même un 429 (rate limit), on attend ~1,1 s
// et on réessaie UNE fois.
async function sendEmail(apiKey, from, to, subject, html) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], reply_to: "cm26@workplay.fr", subject, html })
      });
      if (r.ok) return { ok: true };
      if (r.status === 429 && attempt === 1) { await delay(1100); continue; } // rate limit -> on réessaie
      return { ok: false, detail: "HTTP " + r.status + " " + (await r.text()).slice(0, 160) };
    } catch (e) {
      if (attempt === 1) { await delay(1100); continue; }
      return { ok: false, detail: String(e) };
    }
  }
  return { ok: false, detail: "échec après retry" };
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
