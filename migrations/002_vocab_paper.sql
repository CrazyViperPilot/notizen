-- Papiersorte "vocab" (Vokabeln).

ALTER TABLE {pages} MODIFY paper ENUM('blank','lined','grid','dotted','vocab') NOT NULL DEFAULT 'blank';
