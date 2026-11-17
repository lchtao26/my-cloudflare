CREATE TABLE reading_progress (
  excerpt_number INTEGER PRIMARY KEY,
  progress REAL NOT NULL CHECK (progress >= 0 AND progress <= 1),
  updated_at INTEGER NOT NULL
);
