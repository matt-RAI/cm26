// Cloudflare Pages Function — envoi RÉEL d'invitations par e-mail via Resend.
//
// URL : /api/invite  (méthode POST)
// La clé secrète est lue côté SERVEUR via context.env.RESEND_API_KEY
// (variable configurée dans Cloudflare Pages). Jamais renvoyée au navigateur.
//
// Le client envoie un JSON :
//   { to: ["a@x.fr","b@y.fr"], subject, html, icsContent (base64), matchLabel }

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8"
};

// Pré-vol CORS
export async function onRequestOptions() {
  return new Response("", { status: 204, headers: CORS });
}

export async function onRequestPost(context) {
  const key = context.env && context.env.RESEND_API_KEY;
  if (!key) {
    return new Response(
      JSON.stringify({ error: "Clé Resend absente côté serveur (RESEND_API_KEY non configurée)." }),
      { status: 500, headers: CORS }
    );
  }

  let body;
  try { body = await context.request.json(); }
  catch { return new Response(JSON.stringify({ error: "Requête invalide (JSON attendu)." }), { status: 400, headers: CORS }); }

  const to = Array.isArray(body.to) ? body.to.filter(Boolean) : [];
  if (!to.length) {
    return new Response(JSON.stringify({ error: "Aucun destinataire." }), { status: 400, headers: CORS });
  }

  const payload = {
    from: "CM26 <onboarding@resend.dev>",            // domaine de TEST Resend (pas de DNS requis)
    to,
    subject: body.subject || "Invitation match — CM26",
    html: body.html || "<p>Invitation CM26</p>"
  };
  // pièce jointe .ics (contenu déjà encodé en base64 par le client)
  if (body.icsContent) {
    payload.attachments = [{ filename: "match-cm26.ics", content: body.icsContent }];
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: (data && (data.message || data.name)) || ("Resend a refusé (" + res.status + ")."), status: res.status }),
        { status: res.status, headers: CORS }
      );
    }
    return new Response(JSON.stringify({ ok: true, id: (data && data.id) || null }), { status: 200, headers: CORS });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Impossible de contacter Resend.", detail: String(err) }),
      { status: 502, headers: CORS }
    );
  }
}
