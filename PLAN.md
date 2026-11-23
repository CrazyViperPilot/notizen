# Notizen – Arbeitsplan

Verbindlich: [`PRD.md`](PRD.md) und [`docs/ARCHITEKTUR.md`](docs/ARCHITEKTUR.md).
**Regel:** Opus plant, prüft und übernimmt die schwierigen Pakete (Sicherheit, Sync, Pencil-Eingabe/Rendering, Deploy).
Die übrigen Pakete setzt der Implementer (Haiku, Effort *high*) um, jeweils mit einem Auftrag, der Dateien und Schnittstellen nennt.
Opus prüft jedes Haiku-Paket (Review + Tests), bevor das nächste darauf aufbaut.

Status: **P1–P4, P6 erledigt; P5 umgesetzt (iPad-Test über https://phpexpert.de/notizen/labor.html).** Implementer-Agent: `.claude/agents/implementer.md` (Haiku); beim Start eines Pakets mit Effort *high* aufrufen.

## Reihenfolge und Abhängigkeiten

```
P1 Gerüst+Backend-Kern (Opus) ─┬─ P2 Admin-API (Haiku) ─────────────┐
                               ├─ P3 Sync-Backend (Opus) ─┐         │
                               └─ P4 Teilen-API (Haiku) ──┤         │
P5 Ink-Kern (Opus, parallel zu P2–P4) ─┐                  │         │
P6 Client-Daten+Sync (Opus) ◀──────────┼──────────────────┘         │
                                       ▼                            ▼
             P7 Login/Konto/Status (Haiku) · P8 Bibliothek (Haiku) · P9 Editor-UI (Haiku) · P12 Admin-UI (Haiku)
             P10 PDF+Backup (Haiku) · P11 Teilen-UI (Haiku)
                                       ▼
             P13 PWA + Deploy + Startseite (Opus) → P14 E2E, Sicherheits-Review, Feinschliff auf dem iPad (Opus)
```

## Pakete

### P1 – Gerüst und Backend-Kern (Opus) ✅
`api.php`, `backend/bootstrap.php`, `backend/http.php`, `backend/db.php`, `backend/migrate.php`, `backend/auth.php`, `backend/account.php`, `backend/util.php`,
`migrations/001_init.sql`, `config.example.php`, `.htaccess`, `test/php/run.php` (Testrahmen + Auth-Tests),
lokale MariaDB-Einrichtung. Routen: `ping`, `login`, `logout`, `me`, `password`, `logout_all`, `account`.
Liefert die PHP-Helfer, auf denen P2/P3/P4 aufbauen (`db()`, `t()`, `q()`, `one()`, `all()`, `tx()`, `json_out()`, `fail()`, `body()`,
`param()`, `require_user()`, `require_admin()`, `require_csrf()`, `user_public()`, `admin_log()`, `now_ms()`, `uuid_valid()`).

**Stand P1 (für P2–P4 verbindlich):**
- Routen registriert jedes Modul selbst: `route($name, 'GET'|'POST', $handler, 'none'|'user'|'user_any'|'admin')`. Handler bekommen
  die Benutzerzeile (`$u['id']`, `$u['role']`, …) und geben ein Array zurück (wird zu `{"ok":true, …}`). Fehler: `fail($status, $code, $message)`.
  CSRF/Origin prüft `dispatch()` automatisch für jedes `POST`. `backend/bootstrap.php` lädt `sync`, `tree`, `share`, `admin` automatisch, sobald die Datei existiert.
- SQL mit Tabellen-Platzhaltern: `one('SELECT * FROM {users} WHERE id = ?', [$id])`; weitere Helfer `val()`, `field($name)` (JSON-Body),
  `clean_text($v, $max, $label)`, `gen_temp_password()`, `password_problem($p)`, `validate_username($u)`, `hash_password($p)`,
  `end_sessions_for($userId)`.
- Tests: `test/php/<thema>_test.php` mit Funktionen `test_*`, Helfer `Client` (`->login()`, `->get()`, `->post()`), `make_user()`,
  `user_client()`, `assert_eq()`, `assert_true()`, `assert_status($status, $res, $code)`, Admin aus `T_ADMIN_USER`/`T_ADMIN_PASS`.
  Lauf: `NZ_TEST_DB_USER=nz NZ_TEST_DB_PASS=nz php test/php/run.php [filter]`.

### P2 – Admin-API (Haiku) ✅
`backend/admin.php` + Tests in `test/php/admin_test.php`. Routen `admin_users`, `admin_user_create`, `admin_user_update`,
`admin_user_reset`, `admin_user_lock`, `admin_user_logout`, `admin_user_delete`, `admin_log`. Schutzregeln letzter Admin.
`admin_tree`/`admin_pages` erst nach P4 (nutzen `backend/tree.php`).

### P3 – Sync-Backend (Opus) ✅
`backend/sync.php` + Tests: `sync_pull`, `sync_push`, Konflikte, Papierkorb/Purge, Bereinigung, Quota, Isolation.

### P4 – Teilen-API und Lesezugriff (Haiku) ✅
`backend/tree.php` (`owner_tree`, `note_with_pages`, `can_read_note`, Vorfahren-Prüfung inkl. gelöschter Vorfahren),
`backend/share.php` (`directory`, `shares_of`, `share`, `unshare`, `shared_tree`, `shared_pages`), danach `admin_tree`/`admin_pages`
in `backend/admin.php`. Tests inkl. Isolation.

### P5 – Ink-Kern (Opus) 🟡 umgesetzt, Abnahme auf dem iPad offen (`labor.html`)
`js/config.js`, `js/ink/codec.js`, `js/ink/stroke.js`, `js/ink/paper.js`, `js/ink/render.js`, `js/ink/surface.js`,
Testseite `test/ink.html` (Fläche ohne Backend), Tests `test/js/{codec,stroke,paper}.test.mjs`.
Abnahme: auf dem iPad gegenprüfen (Latenz, Handballen, Zoom, Speicher bei 50 Seiten).

### P6 – Client-Daten und Sync (Opus) ✅
`js/api.js`, `js/db.js`, `js/model.js`, `js/sync.js`, reine Merge-Funktionen + `test/js/sync.test.mjs`.

### P7 – Login, Konto, Status, App-Rahmen (Haiku) ✅ (App-Rahmen js/app.js von Opus)
`index.html`, `css/app.css` (Grundlayout), `js/app.js` (Router, Login-Zustand, Offline-Start über `notizen:lastUser`),
`js/ui/dom.js`, `js/ui/login.js` (inkl. erzwungenem Passwortwechsel), `js/ui/account.js`, `js/ui/status.js`.

### P8 – Bibliothek (Haiku) ✅
`js/ui/library.js`, `js/ui/tree.js`, `js/ui/dialogs.js` (Neu/Umbenennen/Verschieben/Löschen, Neue Notiz mit Papierwahl),
`js/ui/trash.js`, Suche, Vorschaubilder (`thumbs`).

### P9 – Editor-UI (Haiku) ✅
`js/ui/editor.js`, `js/ui/toolbar.js`: Werkzeuge, Farben, Stärken, Undo/Redo, Seiten hinzufügen/löschen, Papier ändern,
Titel, Zurück, Verdrahtung `surface` ↔ `model`.

### P10 – PDF-Export und Backup (Haiku) ✅
`js/export/pdf.js` (Vektor-PDF nach Vorgabe in der Architektur), `js/export/backup.js`, Teilen über `navigator.share({files})`
mit Download als Ausweichlösung, `test/js/pdf.test.mjs`.

### P11 – Teilen-UI (Haiku) ✅
`js/ui/share.js` (Dialog), `js/ui/shared.js` („Mit mir geteilt“, Leseansicht mit `surface` `readOnly`, Offline-Zwischenspeicher `shared`).

### P12 – Admin-UI (Haiku) ✅
`admin.html`, `css/admin.css`, `js/admin/admin.js`: Liste, Anlegen (Einmal-Passwort einmalig anzeigen), Bearbeiten,
Reset, Sperren, Sitzungen beenden, Löschen mit Bestätigung, Notizen einsehen (Baum + `surface` `readOnly`), Protokoll.

### P13 – PWA, Deploy, Startseite (Opus)
`manifest.json`, `sw.js`, Icons, `.github/workflows/test.yml` (Tests bei jedem Push), `.github/workflows/deploy.yml`
(MariaDB-Service, Tests, Upload, config.php, Live-Check), `README.md`; im Repo `games`: Karte auf der Startseite + Tabellenzeile im README.

### P14 – E2E, Review, Feinschliff (Opus)
Playwright-Tests (`test/e2e/`), Sicherheits-Review, Leistungstest (2.000 Striche/Seite, 50 Seiten), Abgleich PRD ↔ Umsetzung.

## Voraussetzungen beim Betreiber (vor dem ersten Deploy)
1. Bei dogado eine MySQL/MariaDB-Datenbank anlegen.
2. Repository-Secrets in **diesem** Repo setzen: `FTP_SERVER`, `FTP_USER`, `FTP_PASSWORD` (FTP-Login startet im Web-Ordner `/notizen`), `NOTIZEN_DB_HOST`, `NOTIZEN_DB_PORT`, `NOTIZEN_DB_NAME`, `NOTIZEN_DB_USER`, `NOTIZEN_DB_PASSWORD`,
   `NOTIZEN_ADMIN_USER`, `NOTIZEN_ADMIN_PASSWORD`.
