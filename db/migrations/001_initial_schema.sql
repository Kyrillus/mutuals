-- 001_initial_schema.sql
-- Anfangsschema fuer Mutuals (lokales Personen-CRM).
-- Wird vom Migrations-Runner als Ganzes per db.exec() ausgefuehrt.
-- Keine Transaktionssteuerung und kein PRAGMA in dieser Datei: beides setzt der Runner
-- bzw. die Verbindung.
--
-- ACHTUNG fuer spaetere Migrationen: die neun FTS-Trigger am Ende dieser Datei
-- verweisen namentlich auf contacts, needs und offers. Wer eine dieser Tabellen nach
-- dem 12-Schritte-Verfahren umbaut (noetig bei jeder Aenderung an den CHECK-Constraints,
-- die SQLite per ALTER TABLE nicht kann), muss die Trigger vorher droppen und danach
-- wieder anlegen - sonst laufen sie waehrend des Umbaus gegen die noch nicht existierende
-- Zieltabelle. Ablauf und die Marker-Zeile "-- migrate: no-transaction" sind in
-- db/migrations/README.md beschrieben.

-- ---------------------------------------------------------------------------
-- Tabellen
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS contacts (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'imported',
  stage           TEXT NOT NULL DEFAULT 'new',
  role            TEXT,
  company         TEXT,
  title           TEXT,
  city            TEXT,
  country         TEXT,
  email           TEXT,
  phone           TEXT,
  linkedin_url    TEXT,
  birthday        TEXT,
  how_we_met      TEXT,
  closeness       INTEGER,
  source          TEXT NOT NULL DEFAULT 'manual',
  last_contact_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CONSTRAINT contacts_status_check
    CHECK (status IN ('imported', 'active', 'archived')),
  CONSTRAINT contacts_stage_check
    CHECK (stage IN ('new', 'reached_out', 'in_touch', 'close', 'dormant')),
  CONSTRAINT contacts_role_check
    CHECK (role IS NULL OR role IN ('founder', 'investor', 'operator', 'student', 'community', 'other')),
  CONSTRAINT contacts_source_check
    CHECK (source IN ('manual', 'linkedin', 'csv')),
  CONSTRAINT contacts_closeness_check
    CHECK (closeness IS NULL OR (closeness BETWEEN 1 AND 5))
);

CREATE TABLE IF NOT EXISTS needs (
  id          INTEGER PRIMARY KEY,
  contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS offers (
  id          INTEGER PRIMARY KEY,
  contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);

-- Notizen sind die private Schicht und gehoeren bewusst NICHT in den Volltextindex.
CREATE TABLE IF NOT EXISTS notes (
  id          INTEGER PRIMARY KEY,
  contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  occurred_on TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS contact_tags (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (contact_id, tag_id)
);

CREATE TABLE IF NOT EXISTS connections (
  id           INTEGER PRIMARY KEY,
  contact_a_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  contact_b_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  note         TEXT,
  created_at   TEXT NOT NULL,
  CONSTRAINT connections_order_check CHECK (contact_a_id < contact_b_id)
);

-- ---------------------------------------------------------------------------
-- Indizes
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_contacts_status       ON contacts(status);
CREATE INDEX IF NOT EXISTS idx_contacts_stage        ON contacts(stage);
CREATE INDEX IF NOT EXISTS idx_contacts_name         ON contacts(name);
CREATE INDEX IF NOT EXISTS idx_contacts_linkedin_url ON contacts(linkedin_url);
CREATE INDEX IF NOT EXISTS idx_contacts_email        ON contacts(email);

CREATE INDEX IF NOT EXISTS idx_needs_contact_id  ON needs(contact_id);
CREATE INDEX IF NOT EXISTS idx_offers_contact_id ON offers(contact_id);
CREATE INDEX IF NOT EXISTS idx_notes_contact_id  ON notes(contact_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_connections_pair
  ON connections(contact_a_id, contact_b_id);

-- ---------------------------------------------------------------------------
-- Volltextindex
-- ---------------------------------------------------------------------------
-- Normale fts5-Tabelle (bewusst NICHT contentless und NICHT external-content),
-- damit UPDATE/DELETE per rowid zuverlaessig funktionieren.
-- rowid der FTS-Zeile == contacts.id.
-- Notizen sind hier absichtlich nicht enthalten (Datenschutz-Entscheidung).
CREATE VIRTUAL TABLE IF NOT EXISTS contacts_fts USING fts5(
  name,
  company,
  title,
  how_we_met,
  needs_text,
  offers_text,
  tokenize = "unicode61 remove_diacritics 2",
  prefix = '2 3'
);

-- ---------------------------------------------------------------------------
-- Trigger: contacts
-- ---------------------------------------------------------------------------

-- Neuer Kontakt -> FTS-Zeile anlegen (needs/offers sind zu diesem Zeitpunkt leer).
CREATE TRIGGER IF NOT EXISTS contacts_ai AFTER INSERT ON contacts BEGIN
  DELETE FROM contacts_fts WHERE rowid = new.id;
  INSERT INTO contacts_fts(rowid, name, company, title, how_we_met, needs_text, offers_text)
  SELECT c.id, c.name, COALESCE(c.company, ''), COALESCE(c.title, ''), COALESCE(c.how_we_met, ''),
         COALESCE((SELECT group_concat(n.text, ' ') FROM needs  n WHERE n.contact_id = c.id), ''),
         COALESCE((SELECT group_concat(o.text, ' ') FROM offers o WHERE o.contact_id = c.id), '')
  FROM contacts c WHERE c.id = new.id;
END;

-- Kontakt geaendert -> Zeile neu bauen. old.id wird mit geloescht, falls sich die
-- id selbst geaendert hat, damit keine Leiche im Index zurueckbleibt.
CREATE TRIGGER IF NOT EXISTS contacts_au AFTER UPDATE ON contacts BEGIN
  DELETE FROM contacts_fts WHERE rowid IN (old.id, new.id);
  INSERT INTO contacts_fts(rowid, name, company, title, how_we_met, needs_text, offers_text)
  SELECT c.id, c.name, COALESCE(c.company, ''), COALESCE(c.title, ''), COALESCE(c.how_we_met, ''),
         COALESCE((SELECT group_concat(n.text, ' ') FROM needs  n WHERE n.contact_id = c.id), ''),
         COALESCE((SELECT group_concat(o.text, ' ') FROM offers o WHERE o.contact_id = c.id), '')
  FROM contacts c WHERE c.id = new.id;
END;

-- Kontakt geloescht -> FTS-Zeile entfernen.
CREATE TRIGGER IF NOT EXISTS contacts_ad AFTER DELETE ON contacts BEGIN
  DELETE FROM contacts_fts WHERE rowid = old.id;
END;

-- ---------------------------------------------------------------------------
-- Trigger: needs
-- ---------------------------------------------------------------------------

-- Need angelegt -> FTS-Zeile des Kontakts komplett neu bauen.
CREATE TRIGGER IF NOT EXISTS needs_ai AFTER INSERT ON needs BEGIN
  DELETE FROM contacts_fts WHERE rowid = new.contact_id;
  INSERT INTO contacts_fts(rowid, name, company, title, how_we_met, needs_text, offers_text)
  SELECT c.id, c.name, COALESCE(c.company, ''), COALESCE(c.title, ''), COALESCE(c.how_we_met, ''),
         COALESCE((SELECT group_concat(n.text, ' ') FROM needs  n WHERE n.contact_id = c.id), ''),
         COALESCE((SELECT group_concat(o.text, ' ') FROM offers o WHERE o.contact_id = c.id), '')
  FROM contacts c WHERE c.id = new.contact_id;
END;

-- Need geaendert -> beide betroffenen Kontakte neu bauen. Deckt auch den Fall ab,
-- dass der Need auf einen anderen Kontakt umgehaengt wurde (contact_id-Wechsel):
-- dann verliert der alte Kontakt den Text und der neue bekommt ihn.
-- Sind old und new derselbe Kontakt, greift IN nur einmal - keine Doppel-Zeile.
CREATE TRIGGER IF NOT EXISTS needs_au AFTER UPDATE ON needs BEGIN
  DELETE FROM contacts_fts WHERE rowid IN (old.contact_id, new.contact_id);
  INSERT INTO contacts_fts(rowid, name, company, title, how_we_met, needs_text, offers_text)
  SELECT c.id, c.name, COALESCE(c.company, ''), COALESCE(c.title, ''), COALESCE(c.how_we_met, ''),
         COALESCE((SELECT group_concat(n.text, ' ') FROM needs  n WHERE n.contact_id = c.id), ''),
         COALESCE((SELECT group_concat(o.text, ' ') FROM offers o WHERE o.contact_id = c.id), '')
  FROM contacts c WHERE c.id IN (old.contact_id, new.contact_id);
END;

-- Need geloescht -> Zeile ohne diesen Text neu bauen. Ist der Kontakt bereits weg
-- (Cascade beim Loeschen des Kontakts), liefert das SELECT nichts und es bleibt
-- korrekterweise beim reinen DELETE.
CREATE TRIGGER IF NOT EXISTS needs_ad AFTER DELETE ON needs BEGIN
  DELETE FROM contacts_fts WHERE rowid = old.contact_id;
  INSERT INTO contacts_fts(rowid, name, company, title, how_we_met, needs_text, offers_text)
  SELECT c.id, c.name, COALESCE(c.company, ''), COALESCE(c.title, ''), COALESCE(c.how_we_met, ''),
         COALESCE((SELECT group_concat(n.text, ' ') FROM needs  n WHERE n.contact_id = c.id), ''),
         COALESCE((SELECT group_concat(o.text, ' ') FROM offers o WHERE o.contact_id = c.id), '')
  FROM contacts c WHERE c.id = old.contact_id;
END;

-- ---------------------------------------------------------------------------
-- Trigger: offers (spiegelbildlich zu needs)
-- ---------------------------------------------------------------------------

-- Offer angelegt -> FTS-Zeile des Kontakts komplett neu bauen.
CREATE TRIGGER IF NOT EXISTS offers_ai AFTER INSERT ON offers BEGIN
  DELETE FROM contacts_fts WHERE rowid = new.contact_id;
  INSERT INTO contacts_fts(rowid, name, company, title, how_we_met, needs_text, offers_text)
  SELECT c.id, c.name, COALESCE(c.company, ''), COALESCE(c.title, ''), COALESCE(c.how_we_met, ''),
         COALESCE((SELECT group_concat(n.text, ' ') FROM needs  n WHERE n.contact_id = c.id), ''),
         COALESCE((SELECT group_concat(o.text, ' ') FROM offers o WHERE o.contact_id = c.id), '')
  FROM contacts c WHERE c.id = new.contact_id;
END;

-- Offer geaendert -> beide betroffenen Kontakte neu bauen (inkl. contact_id-Wechsel).
CREATE TRIGGER IF NOT EXISTS offers_au AFTER UPDATE ON offers BEGIN
  DELETE FROM contacts_fts WHERE rowid IN (old.contact_id, new.contact_id);
  INSERT INTO contacts_fts(rowid, name, company, title, how_we_met, needs_text, offers_text)
  SELECT c.id, c.name, COALESCE(c.company, ''), COALESCE(c.title, ''), COALESCE(c.how_we_met, ''),
         COALESCE((SELECT group_concat(n.text, ' ') FROM needs  n WHERE n.contact_id = c.id), ''),
         COALESCE((SELECT group_concat(o.text, ' ') FROM offers o WHERE o.contact_id = c.id), '')
  FROM contacts c WHERE c.id IN (old.contact_id, new.contact_id);
END;

-- Offer geloescht -> Zeile ohne diesen Text neu bauen; bei bereits geloeschtem
-- Kontakt bleibt es beim DELETE.
CREATE TRIGGER IF NOT EXISTS offers_ad AFTER DELETE ON offers BEGIN
  DELETE FROM contacts_fts WHERE rowid = old.contact_id;
  INSERT INTO contacts_fts(rowid, name, company, title, how_we_met, needs_text, offers_text)
  SELECT c.id, c.name, COALESCE(c.company, ''), COALESCE(c.title, ''), COALESCE(c.how_we_met, ''),
         COALESCE((SELECT group_concat(n.text, ' ') FROM needs  n WHERE n.contact_id = c.id), ''),
         COALESCE((SELECT group_concat(o.text, ' ') FROM offers o WHERE o.contact_id = c.id), '')
  FROM contacts c WHERE c.id = old.contact_id;
END;
