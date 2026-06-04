// Cloudflare Pages Function — agrégateur d'actus foot (RSS) spécial Mondial 2026.
// URL : /api/news  — contourne le CORS des flux RSS (le navigateur ne peut pas
// les lire directement). On ne renvoie que titre + extrait + lien (jamais
// l'article complet), pour rester légal.

// --- Flux RSS (faciles à éditer). Ceux qui échouent sont ignorés proprement. ---
const FEEDS = [
  { url: "http://rss.maxifoot.com/football-general.xml",         source: "Maxifoot" },
  { url: "http://rss.maxifoot.com/football-equipe-france.xml",   source: "Maxifoot — Bleus" },
  { url: "http://rss.maxifoot.com/football-ligue-champion.xml",  source: "Maxifoot — LdC" },
  { url: "https://dwh.lequipe.fr/api/edito/rss?path=/Football/", source: "L'Équipe" },
  { url: "https://www.sofoot.com/rss",                           source: "So Foot" },
  { url: "https://www.footmercato.net/flux-rss",                 source: "Foot Mercato" },
  { url: "https://www.football.fr/feed",                         source: "Football.fr" }
];

// --- Mots-clés "spécial Mondial" (insensible casse/accents). Faciles à éditer. ---
const KEYWORDS = [
  "mondial","coupe du monde","cm 2026","world cup","fifa","equipe de france","les bleus","bleus","deschamps","mbappe",
  "france","bresil","argentine","espagne","angleterre","portugal","allemagne","pays-bas","belgique","croatie",
  "maroc","senegal","uruguay","mexique","usa","etats-unis","canada"
].map(normalize);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8"
};

function normalize(s){ return (s||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,""); }
function uncdata(s){ return (s||"").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,"$1"); }
const ENT={amp:"&",lt:"<",gt:">",quot:'"',apos:"'",nbsp:" ",eacute:"é",egrave:"è",ecirc:"ê",euml:"ë",agrave:"à",acirc:"â",auml:"ä",ccedil:"ç",ugrave:"ù",ucirc:"û",icirc:"î",iuml:"ï",ocirc:"ô",ouml:"ö",ndash:"–",mdash:"—",rsquo:"’",lsquo:"‘",ldquo:"“",rdquo:"”",hellip:"…",laquo:"«",raquo:"»",deg:"°",oelig:"œ",euro:"€"};
function decodeEnt(s){
  return (s||"")
    .replace(/&#x([0-9a-f]+);/gi,(_,h)=>{try{return String.fromCodePoint(parseInt(h,16))}catch{return ""}})
    .replace(/&#(\d+);/g,(_,d)=>{try{return String.fromCodePoint(parseInt(d,10))}catch{return ""}})
    .replace(/&([a-z]+);/gi,(m,n)=>{const v=ENT[n]!=null?ENT[n]:ENT[n.toLowerCase()];return v!=null?v:m});
}
function stripTags(s){ return (s||"").replace(/<[^>]+>/g," "); }
function clean(s){ return decodeEnt(uncdata(s||"")).replace(/\s+/g," ").trim(); }
function pick(block,tag){
  const m=block.match(new RegExp("<"+tag+"(?:\\s[^>]*)?>([\\s\\S]*?)<\\/"+tag+">","i"));
  return m?m[1]:"";
}

function parseFeed(xml, source){
  const out=[];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for(const b of blocks){
    let title=clean(pick(b,"title"));
    let link=clean(pick(b,"link"));
    if(!link){ const mm=b.match(/<link[^>]*href=["']([^"']+)["']/i); if(mm)link=clean(mm[1]); }
    const descRaw = pick(b,"description") || pick(b,"summary") || pick(b,"content:encoded") || "";
    const pub = clean(pick(b,"pubDate") || pick(b,"published") || pick(b,"updated") || pick(b,"dc:date") || "");
    let image=null, mm;
    if(mm=b.match(/<enclosure[^>]*url=["']([^"']+)["']/i)) image=mm[1];
    else if(mm=b.match(/<media:content[^>]*url=["']([^"']+)["']/i)) image=mm[1];
    else if(mm=b.match(/<media:thumbnail[^>]*url=["']([^"']+)["']/i)) image=mm[1];
    else if(mm=uncdata(descRaw).match(/<img[^>]*src=["']([^"']+)["']/i)) image=mm[1];
    let excerpt=stripTags(decodeEnt(uncdata(descRaw))).replace(/\s+/g," ").trim();
    if(excerpt.length>160) excerpt=excerpt.slice(0,159).trim()+"…";
    const d=pub?new Date(pub):null;
    const date=(d && !isNaN(d.getTime()))?d.toISOString():null;
    if(title && link) out.push({ title, link, source, date, excerpt, image });
  }
  return out;
}

async function fetchFeed(f){
  try{
    const opts={ headers:{
      "User-Agent":"Mozilla/5.0 (compatible; CM26/1.0; +https://cm26.workplay.fr)",
      "Accept":"application/rss+xml, application/xml, text/xml, */*"
    }};
    if(typeof AbortSignal!=="undefined" && AbortSignal.timeout) opts.signal=AbortSignal.timeout(8000);
    const r=await fetch(f.url, opts);
    if(!r.ok) return [];
    const xml=await r.text();
    if(!/<rss|<feed|<channel|<item|<entry/i.test(xml)) return []; // pas du RSS -> on ignore
    return parseFeed(xml, f.source);
  }catch(e){ return []; }
}

export async function onRequest(context){
  if(context.request.method==="OPTIONS") return new Response("", { status:204, headers:CORS });
  try{
    const results = await Promise.all(FEEDS.map(fetchFeed));
    let items = results.flat();

    // filtre "spécial Mondial"
    items = items.filter(it=>{
      const hay = normalize((it.title||"")+" "+(it.excerpt||""));
      return KEYWORDS.some(k=>hay.includes(k));
    });

    // déduplication (titre normalisé + lien)
    const seen=new Set(), out=[];
    for(const it of items){
      const key = normalize(it.title).slice(0,90) || it.link;
      if(seen.has(key) || seen.has(it.link)) continue;
      seen.add(key); seen.add(it.link); out.push(it);
    }

    // tri par date décroissante (sans date -> en bas)
    out.sort((a,b)=> (b.date?Date.parse(b.date):0) - (a.date?Date.parse(a.date):0));

    return new Response(JSON.stringify(out.slice(0,30)), {
      status:200,
      headers:{ ...CORS, "Cache-Control":"public, max-age=600" } // cache CDN ~10 min
    });
  }catch(e){
    // jamais d'erreur 500 : on renvoie une liste vide
    return new Response("[]", { status:200, headers:CORS });
  }
}
