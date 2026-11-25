-- Seitenformat DIN A4 (Standard), A5 oder A3 je Seite.

ALTER TABLE {pages} ADD COLUMN size ENUM('a4','a5','a3') NOT NULL DEFAULT 'a4' AFTER orient;
