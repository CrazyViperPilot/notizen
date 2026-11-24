-- Bilder als Seitenhintergrund ("Assets") und Feld pages.bg. {name} = table with configured prefix. Statements end with ";" at line end.

ALTER TABLE {pages} ADD COLUMN bg CHAR(64) CHARACTER SET ascii NULL AFTER orient, ADD KEY ix_user_bg (user_id, bg);

CREATE TABLE {assets} (
  user_id INT UNSIGNED NOT NULL,
  id CHAR(64) CHARACTER SET ascii NOT NULL,
  mime VARCHAR(40) CHARACTER SET ascii NOT NULL,
  w INT UNSIGNED NOT NULL,
  h INT UNSIGNED NOT NULL,
  bytes INT UNSIGNED NOT NULL,
  data MEDIUMBLOB NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, id),
  KEY ix_user_created (user_id, created_at),
  FOREIGN KEY (user_id) REFERENCES {users} (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
