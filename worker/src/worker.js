/**
 * Worker de localisation (démo) — API de positions + pages élève et admin.
 *
 * Routes :
 *   GET  /                 page élève (asset statique public/eleve.html)
 *   GET  /admin            page admin pré-configurée (asset public/admin.html)
 *   POST /position         { eleve_id, lat, lng } -> enregistrée (aucune clé requise)
 *   GET  /position/:id     dernière position   (en-tête x-api-key ; ?format=xml pour du XML)
 *   GET  /trace/:id        50 dernières positions (idem)
 *   GET  /api/eleves       annuaire local (JSON, sans clé : données de démo)
 *   POST /import-xml       importe <eleves><eleve …> (corps brut XML)
 *   GET  /export-xml       exporte l'annuaire en XML (téléchargement)
 *
 * Stockage : D1 (SQLite). Le XML est généré et lu à la main : aucune dépendance.
 */

const TRACE_LIMIT = 50; // taille de l'historique conservé et renvoyé, par élève

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') return preflight(request); // CORS preflight

    try {
      if (request.method === 'GET' && (path === '/' || path === '/eleve')) return await servePage(env, 'eleve.html');
      if (request.method === 'GET' && path === '/admin') return await servePage(env, 'admin.html');

      if (request.method === 'POST' && path === '/position') return await savePosition(request, env);

      // Annuaire : mêmes origines que les pages, aucune clé (données de démo).
      if (request.method === 'GET' && path === '/api/eleves') return send(request, env, 200, await listeEleves(env));
      if (request.method === 'POST' && path === '/import-xml') return await importXml(request, env);
      if (request.method === 'GET' && path === '/export-xml') return await exportXml(request, env);

      const read = request.method === 'GET' && path.match(/^\/(position|trace)\/([^/]+)$/);
      if (read) return await readPositions(request, env, read[1], decodeURIComponent(read[2]));

      return fail(request, env, 404, `route inconnue: ${request.method} ${path}`);
    } catch (err) {
      return fail(request, env, 500, String((err && err.message) || err));
    }
  },
};

// ---------------------------------------------------------------- positions ---

/** POST /position — appelé par la page élève, sans clé : l'écriture n'est pas protégée. */
async function savePosition(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return send(request, env, 400, { error: 'corps JSON invalide' });
  }

  const eleveId = typeof body?.eleve_id === 'string' ? body.eleve_id.trim() : '';
  const { lat, lng } = body ?? {};
  if (!eleveId) return send(request, env, 400, { error: 'eleve_id requis' });
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    return send(request, env, 400, { error: 'lat invalide' });
  }
  if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return send(request, env, 400, { error: 'lng invalide' });
  }

  const date = new Date().toISOString();
  await env.DB.prepare('INSERT INTO positions (eleve_id, lat, lng, date) VALUES (?, ?, ?, ?)')
    .bind(eleveId, lat, lng, date)
    .run();

  // Purge : on ne garde que TRACE_LIMIT positions par élève (droit à l'oubli minimal).
  await env.DB.prepare(
    'DELETE FROM positions WHERE eleve_id = ? AND id NOT IN ' +
      `(SELECT id FROM positions WHERE eleve_id = ? ORDER BY date DESC, id DESC LIMIT ${TRACE_LIMIT})`,
  )
    .bind(eleveId, eleveId)
    .run();

  return send(request, env, 201, { ok: true, eleve_id: eleveId, date });
}

/** GET /position/:id et GET /trace/:id — lecture protégée par x-api-key. */
async function readPositions(request, env, kind, eleveId) {
  if (!authorized(request, env)) {
    return fail(request, env, 401, 'en-tête x-api-key manquant ou invalide');
  }

  const limit = kind === 'trace' ? TRACE_LIMIT : 1;
  const { results } = await env.DB.prepare(
    `SELECT lat, lng, date FROM positions WHERE eleve_id = ? ORDER BY date DESC, id DESC LIMIT ${limit}`,
  )
    .bind(eleveId)
    .all();

  const positions = results.map((r) => ({ lat: r.lat, lng: r.lng, date: r.date }));
  if (kind === 'position') {
    const position = positions[0] ?? null;
    return send(request, env, 200, { eleve_id: eleveId, position }, positionXml(eleveId, position));
  }

  positions.reverse(); // du plus ancien au plus récent : prêt pour un tracé
  return send(request, env, 200, { eleve_id: eleveId, count: positions.length, positions }, traceXml(eleveId, positions));
}

// ---------------------------------------------------------------- annuaire ---

// L'annuaire vit dans la même base D1 : la page /admin n'a besoin d'aucun serveur local.
async function listeEleves(env) {
  const { results } = await env.DB.prepare('SELECT id, nom, classe, code FROM eleves ORDER BY classe, nom').all();
  return results;
}

// Mini-lecteur XML taillé pour <eleves><eleve id="…">…</eleve></eleves> (démo : pas de parser générique).
const unescXml = (s) => s.replace(/&(lt|gt|amp|quot|apos|#39);/g, (m, n) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", '#39': "'" })[n]);
function baliseXml(src, nom) {
  const m = src.match(new RegExp('<' + nom + '>([\\s\\S]*?)</' + nom + '>'));
  return m ? unescXml(m[1]).trim() : '';
}
function parseEleves(xml) {
  if (!/<eleves[\s>]/.test(xml) && !/<eleve[\s>]/.test(xml)) throw new Error('racine <eleves> attendue');
  const out = [];
  const re = /<eleve\b([^>]*)>([\s\S]*?)<\/eleve>/g;
  let m;
  while ((m = re.exec(xml))) {
    const id = /id\s*=\s*"([^"]*)"/.exec(m[1]);
    out.push({ id: (id ? id[1] : '').trim(), nom: baliseXml(m[2], 'nom'), classe: baliseXml(m[2], 'classe'), code: baliseXml(m[2], 'code') });
  }
  return out;
}

// POST /import-xml — le fichier est posté en corps brut par la page admin.
async function importXml(request, env) {
  let eleves;
  try {
    eleves = parseEleves(await request.text());
  } catch (err) {
    return send(request, env, 400, { error: 'XML invalide : ' + err.message });
  }
  if (!eleves.length) return send(request, env, 400, { error: 'aucun <eleve> trouvé' });

  // Le code pilote l'upsert : c'est la clé de jointure avec les positions.
  let importes = 0;
  const ignores = [];
  for (const e of eleves) {
    if (!e.id || !e.code) {
      ignores.push(`${e.nom || '(sans nom)'} (id ou code manquant)`);
      continue;
    }
    const conflit = await env.DB.prepare('SELECT id, code FROM eleves WHERE code = ? OR id = ?').bind(e.code, e.id).first();
    if (conflit && (conflit.id !== e.id || conflit.code !== e.code)) {
      ignores.push(`${e.nom || e.code} (id ou code en conflit avec un autre élève)`);
      continue;
    }
    await env.DB.prepare(
      'INSERT INTO eleves (id, nom, classe, code) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(code) DO UPDATE SET id = excluded.id, nom = excluded.nom, classe = excluded.classe',
    ).bind(e.id, e.nom, e.classe, e.code).run();
    importes++;
  }
  return send(request, env, 200, { ok: true, importes, ignores });
}

// GET /export-xml — même format que l'import, téléchargé en eleves.xml.
async function exportXml(request, env) {
  const lignes = await listeEleves(env);
  const corps =
    XML_HEAD + '<eleves>\n' +
    lignes.map((r) => `  <eleve id="${esc(r.id)}"><nom>${esc(r.nom)}</nom><classe>${esc(r.classe)}</classe><code>${esc(r.code)}</code></eleve>`).join('\n') +
    (lignes.length ? '\n' : '') + '</eleves>';
  return new Response(corps, {
    headers: {
      ...corsHeaders(request),
      'content-type': 'application/xml; charset=utf-8',
      'content-disposition': 'attachment; filename="eleves.xml"',
    },
  });
}

// --------------------------------------------------------------------- XML ---

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);

// <eleve> absent => <vide/> : la page admin n'a qu'un seul chemin de lecture.
const positionXml = (eleveId, p) =>
  XML_HEAD +
  (p
    ? `<position eleve="${esc(eleveId)}"><lat>${esc(p.lat)}</lat><lng>${esc(p.lng)}</lng><date>${esc(p.date)}</date></position>`
    : `<position eleve="${esc(eleveId)}" vide="1"/>`);

const pointXml = (p) => `<position><lat>${esc(p.lat)}</lat><lng>${esc(p.lng)}</lng><date>${esc(p.date)}</date></position>`;

const traceXml = (eleveId, pts) =>
  XML_HEAD + `<trace eleve="${esc(eleveId)}" count="${pts.length}">${pts.map(pointXml).join('')}</trace>`;

const errorXml = (code, message) => XML_HEAD + `<erreur code="${code}">${esc(message)}</erreur>`;

// ------------------------------------------------------------------ réseau ---

function authorized(request, env) {
  const expected = env.API_KEY;
  return Boolean(expected) && request.headers.get('x-api-key') === expected;
}

function corsHeaders(request) {
  return {
    'access-control-allow-origin': request.headers.get('origin') || '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-api-key',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

const preflight = (request) => new Response(null, { status: 204, headers: corsHeaders(request) });

/** Erreur homogène : ?format=xml reste honoré, y compris pour les routes inconnues. */
function fail(request, env, status, message) {
  return send(request, env, status, { error: message }, errorXml(status, message));
}

/** Un seul chemin de réponse : ?format=xml renvoie le XML fourni, sinon le JSON. */
function send(request, env, status, data, xml) {
  const wantXml = new URL(request.url).searchParams.get('format') === 'xml' && xml !== undefined;
  const headers = corsHeaders(request);
  if (wantXml) return new Response(xml, { status, headers: { ...headers, 'content-type': 'application/xml; charset=utf-8' } });
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...headers, 'content-type': 'application/json; charset=utf-8' },
  });
}

async function servePage(env, fichier) {
  if (!env.ASSETS) throw new Error("binding ASSETS absent : déclarer assets = { directory = 'public', binding = 'ASSETS' }");
  const asset = await env.ASSETS.fetch(new Request(new URL('/' + fichier, 'https://assets.local')));
  return new Response(asset.body, {
    status: asset.status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
