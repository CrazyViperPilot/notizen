# Notizen – Sicherheits-Review (Nov 2026)

Geprüft: Backend (`api.php`, `backend/*.php`), Client (`js/`), Auslieferung (`.htaccess`, Deploy), Datenhaltung.
Ergebnis: **keine offenen kritischen Punkte.** Umgesetzte Maßnahmen und bewusst akzeptierte Restrisiken stehen unten.

## Umgesetzt und durch Tests abgesichert
| Bereich | Maßnahme | Test |
|---|---|---|
| Passwörter | bcrypt (`password_hash`), Rehash beim Login, min. 10 Zeichen, Einmal-Passwörter erzwingen Wechsel; Passwortwechsel drosselt falsche Alt-Passwörter über `login_attempts` und rotiert Sitzungs-Cookie + CSRF-Token (alle alten Sitzungen werden ungültig) | `auth_test.php` |
| Login | Bremse 5 Fehlversuche/Benutzer bzw. 20/IP in 15 min (auch für gesperrte Konten); gleiche Antwort und gleiche Laufzeit (Dummy-Hash) für unbekannte Benutzer; Login-Body auf 64 KB (`NZ_MAX_LOGIN_BODY`) begrenzt | `auth_test.php` |
| Sitzung | 32 Byte Zufall, nur SHA-256 in der DB, Cookie `__Secure-notizen_sid` unter HTTPS (kein Fallback auf `notizen_sid`), `HttpOnly; Secure; SameSite=Strict; Path=/notizen/`, 60 Tage gleitend, neue ID bei jedem Login und Passwortwechsel; Sperren/Reset/Löschen beenden alle Sitzungen | `auth_test.php`, `admin_test.php` |
| CSRF & Same-Origin | Alle `POST`-Routen inkl. `login` erzwingen `Content-Type: application/json` (`415`), `Sec-Fetch-Site: same-origin` (falls gesetzt) und `Origin`-Prüfung (kein `null`, Schema `https` bei `cookie_secure`, Host/Port = `Host`); zusätzlich `X-CSRF-Token` pro Sitzung nur bei `POST` (nicht bei `GET`) | `auth_test.php` |
| Rechte & Quota | Jede Datenabfrage auf `user_id` des Aufrufers; fremde Daten nur über Freigabe (`can_read_note`) oder Admin-Routen mit Protokoll; Speicherlimit (Quota) greift auch bei Sync-Konfliktkopien (Client- und Server-Sieg) | `sync_test.php`, `share_test.php`, `assets_test.php` |
| SQL | Ausschließlich vorbereitete Anweisungen; eingesetzt werden nur interne Konstanten und `(int)`-Werte (LIMIT, Spaltenlisten) | Review |
| XSS & Header | Keine `innerHTML`/`eval` im eigenen Code; Benutzertexte nur über `textContent`/Attribute; CSP `default-src 'self'` ohne `unsafe-inline`/`unsafe-eval` per `.htaccess` **und** `<meta http-equiv="Content-Security-Policy">` als Fallback in `index.html`/`admin.html`; `ping` gibt keine PHP-/MySQL-Versionen aus; Deploy warnt bei fehlenden Sicherheits-Headern; pdf.js mit `isEvalSupported: false` | `auth_test.php`, Deploy-Check, CSP-Browsertest (P20) |
| Uploads | Nur echte JPEGs (`getimagesizefromstring`, `IMAGETYPE_JPEG`), serverseitig geprüfte Maße (`1..10000` px) gespeichert, id = SHA-256 des Inhalts, ≤ 8 MB, Quota pro Benutzer, Auslieferung mit festem `Content-Type` + `nosniff`; `admin_asset` mit `Cache-Control: no-store`; geteilte Bilder werden clientseitig nicht in IndexedDB gespeichert (`store: false`) | `assets_test.php`, `admin_test.php` |
| Interne Dateien & SW | Jede PHP-Datei in `backend/` und `config.php` antwortet ohne Einstieg über `api.php` mit 403 (`.htaccess`-Sperren greifen auf dem Webspace nicht zuverlässig); Deploy prüft das live; Service Worker umgeht alle Pfade mit `/api.php` (`path.includes('/api.php')`) | Deploy-Check, `sw.test.mjs` |
| Secrets & CI/CD | DB-Zugang und Admin-Hash nur in der vom Deploy erzeugten `config.php` (nie im Repo); `admin.fp` nutzt PBKDF2-SHA256 (`600000` Iterationen, Salt `notizen-admin-fp:<user>`); Workflows laufen mit minimalen Rechten (`permissions: { contents: read }`); Deploy warnt bei `FTP_PROTOCOL=ftp` oder `FTP_SECURITY=loose` | `auth_test.php` |
| Abmelden | „Abmelden und Daten löschen“ entfernt IndexedDB + `notizen:recent` und schickt `Clear-Site-Data: "cache"` (auch beim Admin-Logout); bei Offline-Abmeldung warnt ein Fehler-Toast, dass die Server-Sitzung nicht beendet werden konnte | `auth_test.php` |
| Admin | Letzter aktiver Admin nicht sperr-/lösch-/herabstufbar; Einsicht in Notizen, Sicherungen und alle Kontoaktionen werden protokolliert; `display_name` wird im `admin_log` um `,` und `=` bereinigt | `admin_test.php` |

## Bewusst akzeptiert (Restrisiken)
- **Admins können alle Notizen lesen** (Anforderung). Die App weist im Konto darauf hin; jeder Zugriff steht im Protokoll.
- **Lokale Daten auf dem Gerät** (IndexedDB) sind nicht zusätzlich verschlüsselt – Schutz über die Gerätesperre des iPads.
  Wer sich auf einem fremden Gerät anmeldet, sollte beim Abmelden „Daten löschen“ wählen.
- **Kein HSTS-Header**: Er würde für die ganze Domain phpexpert.de gelten (auch die Spiele); die App selbst läuft nur per HTTPS
  (Cookie `__Secure-notizen_sid`, `Secure`).
- **Keine Zwei-Faktor-Anmeldung** – für eine Familien-App mit wenigen Konten verhältnismäßig.
- **Server-Backups** liegen beim Hoster; zusätzlich gibt es die Gesamtsicherung im Admin-Bereich (Datei enthält alle Notizen →
  sicher aufbewahren).
