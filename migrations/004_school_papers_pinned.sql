-- Schul-Lineaturen (lin1–lin4, math) als Papiersorten und Favoriten-Feld notes.pinned.

ALTER TABLE {pages} MODIFY paper ENUM('blank','lined','grid','dotted','vocab','lin1','lin2','lin3','lin4','math') NOT NULL DEFAULT 'blank';
ALTER TABLE {notes} ADD COLUMN pinned TINYINT(1) NOT NULL DEFAULT 0 AFTER title;
