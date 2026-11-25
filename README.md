# Notizen

Minimale Handschrift-Notizen für das iPad mit Apple Pencil: Web-App (PWA) mit PHP/MySQL-Backend,
Benutzerverwaltung und Admin-Bereich. Ordner und Unterordner, Seiten in DIN A4, A5 oder A3 mit vielen Papiersorten, Lineal, offline schreiben mit Sync,
nur lesend teilen, PDF-Export (mit Titelblatt, auch PDF/A) und Backup.

- **App:** https://phpexpert.de/notizen/ (auf dem iPad in Safari öffnen → Teilen → „Zum Home-Bildschirm“)
- **Admin:** https://phpexpert.de/notizen/admin.html
- **Schreib-Labor** (Stift ohne Konto ausprobieren): https://phpexpert.de/notizen/labor.html

Dokumente: [PRD.md](PRD.md) (Anforderungen) · [docs/ARCHITEKTUR.md](docs/ARCHITEKTUR.md) (Technik) · [PLAN.md](PLAN.md) (Arbeitspakete, Stand) · [docs/SICHERHEIT.md](docs/SICHERHEIT.md) (Sicherheits-Review)

## Aufbau

| Teil | Ort |
|---|---|
| Oberfläche (Vanilla JS, ES-Module, kein Build) | `index.html`, `js/`, `css/`, `sw.js`, `manifest.json` |
| Admin-Bereich | `admin.html`, `js/admin/` |
| API (PHP 7.4+, ohne Framework) | `api.php` → `backend/*.php` |
| Datenbank-Schema | `migrations/*.sql` (laufen automatisch beim ersten Aufruf nach einem Deploy) |
| Tests | `test/php/` (gegen MySQL/MariaDB), `test/js/` (`node --test`) |

## Deploy

Jeder Push auf `main` testet (PHP 7.4/8.3 gegen MySQL 8, Node) und lädt per FTP nach `phpexpert.de/notizen/`
(`.github/workflows/deploy.yml`). Repository-Secrets:

| Secret | Inhalt |
|---|---|
| `FTP_SERVER`, `FTP_USER`, `FTP_PASSWORD` | FTP-Zugang; der Login startet im Web-Ordner `/notizen` |
| `NOTIZEN_DB_HOST`, `NOTIZEN_DB_PORT`, `NOTIZEN_DB_NAME`, `NOTIZEN_DB_USER`, `NOTIZEN_DB_PASSWORD` | MySQL-Zugang |
| `NOTIZEN_ADMIN_USER`, `NOTIZEN_ADMIN_PASSWORD` | Erst-Admin. Ein **geändertes** Passwort-Secret setzt beim nächsten Deploy das Admin-Passwort zurück (Notfallzugang). |

Release der Oberfläche: `CACHE_NAME` in `sw.js` erhöhen, damit installierte Apps die neue Version laden.

## Lokal entwickeln und testen
```sh
# MariaDB/MySQL mit Datenbanken notizen und notizen_test, dann:
cp config.example.php config.php                              # Zugang + Admin eintragen (Anleitung in der Datei)
php -S 127.0.0.1:8080 -t .                                    # App: http://127.0.0.1:8080/
NZ_TEST_DB_USER=nz NZ_TEST_DB_PASS=nz php test/php/run.php    # PHP-Tests (Tabellenpräfix test_)
npm test                                                      # JS-Tests
npm run test:e2e                                              # Browser-Tests (Playwright) gegen http://127.0.0.1:8080/
```
