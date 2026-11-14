-- Offsets are UTF-16 code units in whitespace-stripped rendered body text.
CREATE TABLE highlights (
  id TEXT PRIMARY KEY,
  excerpt_number INTEGER NOT NULL,
  excerpt_page_id TEXT NOT NULL,
  field TEXT NOT NULL CHECK (field IN ('original', 'translation')),
  start INTEGER NOT NULL CHECK (start >= 0),
  "end" INTEGER NOT NULL CHECK ("end" > start),
  quote TEXT NOT NULL CHECK (length(quote) BETWEEN 1 AND 500),
  prefix TEXT NOT NULL,
  suffix TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  anchor_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (excerpt_number, excerpt_page_id, field, start, "end", body_hash)
);
CREATE INDEX highlights_by_excerpt ON highlights (excerpt_number, field, start);
CREATE INDEX highlights_by_created ON highlights (created_at DESC, id DESC);
