-- Runde 5: neue Papiersorten, Ordnerfarben, Seiten-Metadaten (Lesezeichen, Lernkartei, Abdeckungen), Abgabe und Korrektur.

ALTER TABLE {pages} MODIFY paper ENUM('blank','lined','grid','dotted','vocab','lin1','lin2','lin3','lin4','math','coord','mm','music','iso') NOT NULL DEFAULT 'blank';
ALTER TABLE {pages} ADD COLUMN meta TEXT NULL AFTER bg;
ALTER TABLE {folders} ADD COLUMN color CHAR(7) CHARACTER SET ascii NULL AFTER name;
ALTER TABLE {shares} ADD COLUMN review TINYINT(1) NOT NULL DEFAULT 0 AFTER item_id;

CREATE TABLE {corrections} (
  page_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reviewer_id INT UNSIGNED NOT NULL,
  owner_id INT UNSIGNED NOT NULL,
  note_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  strokes MEDIUMTEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (page_id, reviewer_id),
  KEY ix_note (note_id),
  FOREIGN KEY (reviewer_id) REFERENCES {users} (id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id) REFERENCES {users} (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
