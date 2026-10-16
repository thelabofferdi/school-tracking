-- Schéma D1 : le Worker ne stocke QUE les positions.
-- La liste des élèves (id, nom, classe, code) vit dans la SQLite de l'admin local.

CREATE TABLE IF NOT EXISTS positions (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  eleve_id TEXT NOT NULL,          -- id/code élève envoyé par la page élève
  lat      REAL NOT NULL,
  lng      REAL NOT NULL,
  date     TEXT NOT NULL           -- ISO 8601 UTC, horodaté côté Worker (pas par le client)
);

-- Sert les "N dernières positions" et le purge de l'historique.
CREATE INDEX IF NOT EXISTS idx_positions_eleve ON positions (eleve_id, date DESC, id DESC);

-- Annuaire des élèves (utilisé par la page /admin hébergée sur le Worker).
-- Le code est la clé de jointure avec les positions : il doit rester unique.
CREATE TABLE IF NOT EXISTS eleves (
  id     TEXT PRIMARY KEY,
  nom    TEXT,
  classe TEXT,
  code   TEXT NOT NULL UNIQUE
);
