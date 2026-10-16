# Démo — localisation d'élèves en milieu scolaire

API de positions sur **Cloudflare Workers + D1**, échanges de données en **XML**.
Démo volontairement minimale : pas d'alerte, pas de notification, pas d'authentification côté élève.

> **Parcours prof : un seul lien, zéro installation.**
> `https://school-tracking-worker.ferdilabspace.workers.dev/admin` — page admin pré-configurée
> (URL + clé déjà renseignées) : import du XML, suivi carte, export.
> Page élève : `https://school-tracking-worker.ferdilabspace.workers.dev/` (code `A123`).
> L'API Express locale (`admin/`) reste disponible en option, elle n'est plus nécessaire.

```
┌────────────────────────┐                         ┌──────────────────────────────┐
│  PAGE ÉLÈVE (web)      │   POST /position        │  CLOUDFLARE WORKER           │
│  eleve.html            │ ──────────────────────► │  worker.js                   │
│  servie par le Worker  │   { eleve_id, lat, lng }│   • POST /position  (écriture)│
│  geolocation / 10 s    │                         │   • GET /position/:id  (XML) │
└────────────────────────┘                         │   • GET /trace/:id     (XML) │
        ▲                                          └───────────────┬──────────────┘
        │ l'URL du Worker est la seule adresse publique            │ SQL
        │ (aucun tunnel vers la machine locale)                    ▼
        │                                          ┌──────────────────────────────┐
┌───────┴──────────────────────┐                   │  D1 (SQLite)                 │
│  PAGE ADMIN (web, locale)    │  GET ?format=xml  │  table positions             │
│  admin.html — Leaflet/OSM    │ ◄──────────────── │  50 positions max / élève   │
│  DOMParser + rafraîch / 5 s  │  x-api-key        └──────────────────────────────┘
└───────┬──────────────────────┘
        │ même origine (localhost:3000)
        ▼
┌──────────────────────────────┐
│  API ADMIN LOCALE (Express)  │   GET  /api/eleves     liste
│  server.js                   │   POST /api/eleves     upsert unitaire
│  SQLite (node:sqlite)        │   DELETE /api/eleves/:id
│  table eleves                │   POST /import-xml     XML -> SQLite
│                              │   GET  /export-xml     SQLite -> XML
└──────────────────────────────┘
```

Deux bases distinctes, volontairement :

- **D1 (cloud)** contient les positions, indexées par `eleve_id`, **et** l'annuaire des élèves
  (`id`, `nom`, `classe`, `code`, avec `code` unique) servi par la page `/admin` hébergée.
- **SQLite (local)** ne contient que l'annuaire des élèves (`id`, `nom`, `classe`, `code`, avec `code` unique).

> `eleve_id` dans les positions = le **code** saisi par l'élève (ex. `A123`), pas l'id SQLite.
> La page admin sélectionne donc par code, et interroge `/position/A123`.

## Endpoints

### Worker — `https://school-tracking-worker.ferdilabspace.workers.dev`

| Méthode | Route | Corps / params | Réponse | Clé |
| --- | --- | --- | --- | --- |
| GET | `/` (ou `/eleve`) | — | HTML de la page élève | non |
| GET | `/admin` | — | HTML de la page admin (pré-configurée) | non |
| POST | `/position` | JSON `{ eleve_id, lat, lng }` | `201 { ok, eleve_id, date }`, `400` si invalide | non |
| GET | `/position/:id` | `?format=xml` optionnel | dernière position, `vide="1"` / `position: null` si inconnue | `x-api-key` |
| GET | `/trace/:id` | `?format=xml` optionnel | 50 dernières positions, du plus ancien au plus récent | `x-api-key` |
| GET | `/api/eleves` | — | JSON `[{ id, nom, classe, code }]` | non (annuaire démo) |
| POST | `/import-xml` | corps brut XML | `{ ok, importes, ignores[] }` (upsert par `code`) | non (annuaire démo) |
| GET | `/export-xml` | — | `application/xml` + `Content-Disposition: attachment` | non (annuaire démo) |
| OPTIONS | toute route | — | `204` + en-têtes CORS | non |

CORS : `access-control-allow-origin` repris de l'`Origin`, `access-control-allow-headers: content-type, x-api-key`.

### API admin locale — `http://localhost:3000` (optionnel, la page `/admin` hébergée suffit)

| Méthode | Route | Entrée | Sortie |
| --- | --- | --- | --- |
| GET | `/` | — | redirection vers `/admin.html` |
| GET | `/api/eleves` | — | JSON `[{ id, nom, classe, code }]` |
| POST | `/api/eleves` | JSON `{ id, nom?, classe?, code }` | `201 { ok, id }` (upsert par `code`), `400` si `id`/`code` manque, `409` en cas de conflit |
| DELETE | `/api/eleves/:id` | — | `{ ok, supprime }` ou `404` |
| POST | `/import-xml` | corps brut XML (`text/xml` ou `application/xml`) | `{ ok, importes, ignores[] }` |
| GET | `/export-xml` | — | `application/xml` + `Content-Disposition: attachment` |
| GET | `/health` | — | `{ ok, eleves }` |

## Formats XML

Élèves (`admin/data/eleves.xml`, importable tel quel) :

```xml
<?xml version="1.0" encoding="UTF-8"?>
<eleves>
  <eleve id="1"><nom>Awa Dossou</nom><classe>CM2</classe><code>A123</code></eleve>
</eleves>
```

Position et trace (générées par le Worker, sans dépendance) :

```xml
<?xml version="1.0" encoding="UTF-8"?>
<position eleve="A123"><lat>6.3654</lat><lng>2.4183</lng><date>2026-10-16T17:00:00Z</date></position>
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<trace eleve="A123" count="2"><position><lat>6.3654</lat><lng>2.4183</lng><date>…</date></position>…</trace>
```

Élève sans position → `<position eleve="A123" vide="1"/>`. Erreur → `<erreur code="401">…</erreur>`.
Import toléré : un seul `<eleve>` à la racine fonctionne aussi ; un `<eleve>` incomplet ou en conflit
`id`/`code` est ignoré et listé dans `ignores`. La réimportation met à jour les élèves existants par `code`.

## Fichiers

```
worker/wrangler.toml      config Worker + D1 + clé partagée
worker/src/worker.js      API positions + annuaire, pages élève/admin, XML à la main
worker/schema.sql         tables D1 positions + eleves
worker/public/eleve.html  page élève (géolocation toutes les 10 s)
worker/public/admin.html  page admin hébergée pré-configurée (Leaflet, rafraîch. 5 s)
admin/server.js           API locale optionnelle (Express + node:sqlite + fast-xml-parser)
admin/public/admin.html   page admin locale (demande URL du Worker + clé)
admin/data/eleves.xml     exemple de fichier à importer
```

## Lancer

### 0. Parcours prof (2 minutes, sans rien installer)

1. Ouvrir `https://school-tracking-worker.ferdilabspace.workers.dev/admin`
   (l'annuaire d'exemple est déjà chargé ; sinon **Choisir un fichier** =
   `admin/data/eleves.xml` → **Importer le XML**).
2. Sur un téléphone : ouvrir `https://school-tracking-worker.ferdilabspace.workers.dev/`,
   saisir le code `A123`, **Envoyer** (ou cocher **Coordonnées simulées** sans GPS).
3. Revenir sur `/admin`, choisir `Awa Dossou` : position + tracé, refresh toutes les 5 s.
   **Exporter le XML** télécharge l'annuaire ; le réimporter ne crée aucun doublon.

### 1. API admin locale (optionnel)

```bash
cd admin
npm install          # express + fast-xml-parser (SQLite via node natif, Node >= 22.5)
npm start            # http://localhost:3000
```

`data/admin.db` est créée au premier démarrage.

### 2. Worker

Déjà déployé via le MCP Cloudflare (sans wrangler) :

- Worker : `school-tracking-worker`
- URL publique : `https://school-tracking-worker.ferdilabspace.workers.dev`
- Base D1 : `school-tracking` (`42477da5-7d97-4b89-ac8b-c843e7ab9bfa`), tables `positions` + `eleves` créées
- Bindings : `DB` (D1) + secret `API_KEY` (clé démo `cle-de-demo-changez-moi`)
- Le module déployé embarque `eleve.html` + `admin.html` en ligne (même code, vérifié par empreinte avant envoi)

Équivalent manuel avec wrangler :

```bash
cd worker
npm install -D wrangler                     # >= 3.83 (assets + script ensemble)
npx wrangler d1 create school-tracking      # coller le database_id renvoyé dans wrangler.toml
npx wrangler d1 execute school-tracking --local  --file=./schema.sql   # base du `wrangler dev`
npx wrangler dev                            # http://localhost:8787
```

Pour l'élève : la page est sur l'URL du Worker, donc en local `http://localhost:8787`
(la géolocation navigateur exige HTTPS ou localhost), ou après déploiement :

```bash
npx wrangler d1 execute school-tracking --remote --file=./schema.sql
npx wrangler secret put API_KEY             # remplace la clé de wrangler.toml
npx wrangler deploy                         # https://school-tracking-worker.<compte>.workers.dev
```

### 3. Tester

Terminal A — une position, comme le ferait la page élève :

```bash
curl -X POST http://localhost:8787/position -H 'content-type: application/json' \
  -d '{"eleve_id":"A123","lat":6.3654,"lng":2.4183}'
```

Terminal B — lecture JSON puis XML, et refus sans clé :

```bash
curl 'http://localhost:8787/position/A123' -H 'x-api-key: cle-de-demo-changez-moi'
curl 'http://localhost:8787/trace/A123?format=xml' -H 'x-api-key: cle-de-demo-changez-moi'
curl -o /dev/null -w '%{http_code}\n' 'http://localhost:8787/position/A123'   # -> 401
```

Import / export de l'annuaire :

```bash
cd admin                                  # les 2 commandes partent de ce dossier
curl -X POST http://localhost:3000/import-xml -H 'content-type: text/xml' --data-binary @data/eleves.xml
curl http://localhost:3000/export-xml -o /tmp/eleves-export.xml
```

Dans le navigateur (production, sans localhost) :

1. `https://school-tracking-worker.ferdilabspace.workers.dev/` → code `A123`, cocher
   **Coordonnées simulées**, **Envoyer** → une position toutes les 10 s
   (décocher pour tester le vrai GPS).
2. `https://school-tracking-worker.ferdilabspace.workers.dev/admin` → **Choisir un fichier** =
   `admin/data/eleves.xml` → **Importer le XML** → l'élève `A123` apparaît
   dans la liste, sa position et son tracé se rafraîchissent toutes les 5 s.
   Aucune URL ni clé à saisir : tout est pré-configuré.
3. **Exporter le XML** télécharge `eleves.xml` ; la réimporter ne crée aucun doublon (upsert par `code`).
4. Historique : après plus de 50 envois, `/trace/A123` renvoie toujours 50 points, et seulement 50
   lignes en base.

En local (`wrangler dev` + `npm start` dans `admin/`) : mêmes étapes sur
`http://localhost:8787`, `http://localhost:8787/admin`, `http://localhost:3000` —
la page admin locale demande alors l'URL du Worker et la clé API.

## Limites assumées (démo)

- Écriture ouverte : n'importe qui peut poster une position pour n'importe quel code. La clé
  partagée ne protège que la **lecture**. Un vrai système exigerait un jeton par élève.
- Clé en clair dans `wrangler.toml` en dev, à remplacer par `wrangler secret put API_KEY`.
- Une position par élève est conservée 50 max, sans horodatage de rétention au-delà.
- La localisation d'enfants est une donnée personnelle sensible : en production, il faut base
  légale, information et consentement des responsables, finalité limitée et durée de conservation
  courte. Cette démo ne doit pas suivre de vrais élèves.
