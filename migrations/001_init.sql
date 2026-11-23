-- Notizen: initial schema. {name} = table with configured prefix. Statements end with ";" at line end.

CREATE TABLE {settings} (
  k VARCHAR(64) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  v TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE {users} (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(32) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  display_name VARCHAR(64) NOT NULL,
  password_hash VARCHAR(255) CHARACTER SET ascii NOT NULL,
  role ENUM('user','admin') NOT NULL DEFAULT 'user',
  status ENUM('active','locked') NOT NULL DEFAULT 'active',
  must_change_pw TINYINT(1) NOT NULL DEFAULT 0,
  quota_bytes BIGINT NOT NULL DEFAULT 524288000,
  used_bytes BIGINT NOT NULL DEFAULT 0,
  seq BIGINT NOT NULL DEFAULT 0,
  purge_floor BIGINT NOT NULL DEFAULT 0,
  last_purge_at BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  last_login_at BIGINT NULL,
  UNIQUE KEY uq_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE {sessions} (
  id_hash CHAR(64) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  csrf CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  user_agent VARCHAR(200) NOT NULL DEFAULT '',
  KEY ix_user (user_id),
  FOREIGN KEY (user_id) REFERENCES {users} (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE {login_attempts} (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  ip VARCHAR(45) CHARACTER SET ascii NOT NULL,
  at BIGINT NOT NULL,
  KEY ix_user_at (username, at),
  KEY ix_ip_at (ip, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE {folders} (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  parent_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  name VARCHAR(200) NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT NULL,
  purged TINYINT(1) NOT NULL DEFAULT 0,
  rev INT UNSIGNED NOT NULL DEFAULT 1,
  seq BIGINT NOT NULL,
  KEY ix_user_seq (user_id, seq),
  KEY ix_parent (parent_id),
  FOREIGN KEY (user_id) REFERENCES {users} (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE {notes} (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  folder_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  title VARCHAR(200) NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT NULL,
  purged TINYINT(1) NOT NULL DEFAULT 0,
  rev INT UNSIGNED NOT NULL DEFAULT 1,
  seq BIGINT NOT NULL,
  KEY ix_user_seq (user_id, seq),
  KEY ix_folder (folder_id),
  FOREIGN KEY (user_id) REFERENCES {users} (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE {pages} (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  note_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  pos DOUBLE NOT NULL DEFAULT 0,
  paper ENUM('blank','lined','grid','dotted') NOT NULL DEFAULT 'blank',
  orient ENUM('p','l') NOT NULL DEFAULT 'p',
  strokes MEDIUMTEXT NOT NULL,
  bytes INT UNSIGNED NOT NULL DEFAULT 0,
  conflict TINYINT(1) NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT NULL,
  purged TINYINT(1) NOT NULL DEFAULT 0,
  rev INT UNSIGNED NOT NULL DEFAULT 1,
  seq BIGINT NOT NULL,
  KEY ix_user_seq (user_id, seq),
  KEY ix_note (note_id),
  FOREIGN KEY (user_id) REFERENCES {users} (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE {shares} (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  owner_id INT UNSIGNED NOT NULL,
  target_id INT UNSIGNED NOT NULL,
  kind ENUM('folder','note') NOT NULL,
  item_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE KEY uq_share (owner_id, target_id, kind, item_id),
  KEY ix_target (target_id),
  FOREIGN KEY (owner_id) REFERENCES {users} (id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES {users} (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE {admin_log} (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  admin_id INT UNSIGNED NOT NULL,
  action VARCHAR(40) NOT NULL,
  target_user_id INT UNSIGNED NULL,
  details VARCHAR(500) NOT NULL DEFAULT '',
  at BIGINT NOT NULL,
  KEY ix_at (at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
