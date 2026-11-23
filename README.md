# Notizen

Minimale Handschrift-Notizen für das iPad mit Apple Pencil: Web-App (PWA) mit PHP/MySQL-Backend,
Benutzerverwaltung und Admin-Bereich. Ordner und Unterordner, A4-Seiten mit vier Papiersorten, offline schreiben mit Sync,
nur lesend teilen, PDF-Export.

Live (geplant): https://phpexpert.de/notizen/

- Anforderungen: [PRD.md](PRD.md)
- Technik: [docs/ARCHITEKTUR.md](docs/ARCHITEKTUR.md)
- Arbeitspakete und Stand: [PLAN.md](PLAN.md)

Status: **in Arbeit** – siehe PLAN.md.

## Voraussetzungen für den Deploy
Repository-Secrets: `FTP_SERVER`, `FTP_USER`, `FTP_PASSWORD` (FTP-Login startet im Web-Ordner `/notizen`), `NOTIZEN_DB_HOST`, `NOTIZEN_DB_PORT`, `NOTIZEN_DB_NAME`,
`NOTIZEN_DB_USER`, `NOTIZEN_DB_PASSWORD`, `NOTIZEN_ADMIN_USER`, `NOTIZEN_ADMIN_PASSWORD`.

## Lokal entwickeln und testen
```sh
# MariaDB/MySQL mit Datenbank notizen_test, dann:
NZ_TEST_DB_USER=nz NZ_TEST_DB_PASS=nz php test/php/run.php   # PHP-Tests (Präfix test_)
cp config.example.php config.php                              # anpassen
php -S 127.0.0.1:8080 -t .                                    # App: http://127.0.0.1:8080/
```
