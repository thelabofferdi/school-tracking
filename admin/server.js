/**
 * API d'administration locale (démo) — liste des élèves + import/export XML.
 *
 * Dépendances : express, fast-xml-parser. SQLite via le module natif node:sqlite
 * (Node >= 22.5) : aucune compilation native.
 *
 * Les positions ne sont PAS stockées ici : la page admin va les lire directement
 * sur le Worker (GET /position/:id?format=xml, GET /trace/:id?format=xml).
 */

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const { XMLParser, XMLBuilder, XMLValidator } = require('fast-xml-parser');

const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'admin.db');

// ----------------------------------------------------------------- SQLite ---

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`CREATE TABLE IF NOT EXISTS eleves (
  id     TEXT PRIMARY KEY,
  nom    TEXT,
  classe TEXT,
  code   TEXT NOT NULL UNIQUE
)`);

// Le code est la clé de jointure avec les positions du Worker : il doit rester unique.
// En cas de réimport, c'est donc le code qui pilote l'upsert (pas seulement l'id).
const upsertEleve = db.prepare(
  `INSERT INTO eleves (id, nom, classe, code) VALUES (?, ?, ?, ?)
   ON CONFLICT(code) DO UPDATE SET id = excluded.id, nom = excluded.nom, classe = excluded.classe`,
);
const conflitCle = db.prepare('SELECT id, code FROM eleves WHERE code = ? OR id = ?');
const cleCompatible = (e) => {
  const ligne = conflitCle.get(e.code, e.id);
  return !ligne || (ligne.id === e.id && ligne.code === e.code);
};

// -------------------------------------------------------------------- XML ---

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: true });
const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  format: true,
  indentBy: '  ',
  suppressEmptyNode: true,
});

// <eleve> unique => objet, plusieurs => tableau : on normalise toujours en tableau.
const toList = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const text = (value) => String(value ?? '').trim();

/** <eleves><eleve id="1">…</eleve></eleves> => [{ id, nom, classe, code }] */
function parseElevesXml(xml) {
  const check = XMLValidator.validate(xml);
  if (check !== true) throw Object.assign(new Error(`XML invalide : ${check.err.msg} (ligne ${check.err.line})`), { status: 400 });

  const parsed = parser.parse(xml);
  const root = parsed.eleves ?? parsed; // racine <eleve> acceptée aussi
  return toList(root.eleve)
    .map((e) => ({
      id: text(e['@_id'] ?? e.id),
      nom: text(e.nom),
      classe: text(e.classe),
      code: text(e.code),
    }));
}

const buildElevesXml = (rows) =>
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  builder.build({ eleves: { eleve: rows.map((r) => ({ '@_id': r.id, nom: r.nom, classe: r.classe, code: r.code })) } });

// ---------------------------------------------------------------- Express ---

const app = express();

app.use(express.json());
// Le XML arrive en corps brut (fichier lu par la page admin), pas en JSON.
app.use(express.text({ type: ['text/xml', 'application/xml', 'text/plain'], limit: '2mb' }));

// CORS maison : utile si la page admin est ouverte autrement qu'en même origine.
app.use((req, res, next) => {
  res.set({
    'access-control-allow-origin': req.headers.origin || '*',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'Origin',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.redirect('/admin.html'));

// Liste des élèves : servie à la page admin pour remplir la liste déroulante.
app.get('/api/eleves', (req, res) => {
  res.json(db.prepare('SELECT id, nom, classe, code FROM eleves ORDER BY classe, nom').all());
});

// Ajout / modification unitaire (l'import XML passe par le même upsert).
app.post('/api/eleves', (req, res) => {
  const eleve = { id: text(req.body?.id), nom: text(req.body?.nom), classe: text(req.body?.classe), code: text(req.body?.code) };
  if (!eleve.id) return res.status(400).json({ error: 'id requis' });
  if (!eleve.code) return res.status(400).json({ error: 'code requis' });
  if (!cleCompatible(eleve)) return res.status(409).json({ error: 'id ou code déjà utilisé par un autre élève' });
  upsertEleve.run(eleve.id, eleve.nom, eleve.classe, eleve.code);
  res.status(201).json({ ok: true, id: eleve.id });
});

app.delete('/api/eleves/:id', (req, res) => {
  const { changes } = db.prepare('DELETE FROM eleves WHERE id = ?').run(req.params.id);
  if (!changes) return res.status(404).json({ error: 'élève inconnu' });
  res.json({ ok: true, supprime: req.params.id });
});

// Import XML : le fichier est envoyé en corps brut (Content-Type: text/xml).
app.post('/import-xml', (req, res) => {
  const xml = typeof req.body === 'string' ? req.body : '';
  if (!xml.trim()) return res.status(400).json({ error: 'corps XML vide (attendu : text/xml ou application/xml)' });

  const eleves = parseElevesXml(xml);
  if (!eleves.length) return res.status(400).json({ error: 'aucun <eleve> trouvé' });

  let importes = 0;
  const ignores = [];
  for (const e of eleves) {
    if (!e.id || !e.code) {
      ignores.push(`${e.nom || '(sans nom)'} (id ou code manquant)`);
      continue;
    }
    if (!cleCompatible(e)) {
      ignores.push(`${e.nom || e.code} (id ou code en conflit avec un autre élève)`);
      continue;
    }
    upsertEleve.run(e.id, e.nom, e.classe, e.code);
    importes++;
  }
  res.json({ ok: true, importes, ignores });
});

// Export XML : même format que l'import => round-trip eleves.xml <-> SQLite.
app.get('/export-xml', (req, res) => {
  const rows = db.prepare('SELECT id, nom, classe, code FROM eleves ORDER BY CAST(id AS INTEGER), nom').all();
  res.set({ 'content-type': 'application/xml; charset=utf-8', 'content-disposition': 'attachment; filename="eleves.xml"' });
  res.send(buildElevesXml(rows));
});

app.get('/health', (req, res) => {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM eleves').get();
  res.json({ ok: true, eleves: n });
});

// Erreurs DB / XML : réponse JSON cohérente, pas de stack trace.
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`Admin locale : http://localhost:${PORT} (base : ${DB_FILE})`);
});
