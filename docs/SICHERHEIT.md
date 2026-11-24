# Notizen – Sicherheits-Review (Nov 2026)

Geprüft: Backend (`api.php`, `backend/*.php`), Client (`js/`), Auslieferung (`.htaccess`, Deploy), Datenhaltung.
Ergebnis: **keine offenen kritischen Punkte.** Umgesetzte Maßnahmen und bewusst akzeptierte Restrisiken stehen unten.

## Umgesetzt und durch Tests abgesichert
| Bereich | Maßnahme | Test |
|---|---|---|
| Passwörter | bcrypt (`password_hash`), Rehash beim Login, min. 10 Zeichen, Einmal-Passwörter erzwingen Wechsel | `auth_test.php` |
| Login | Bremse 5 Fehlversuche/Benutzer bzw. 20/IP in 15 min; gleiche Antwort und gleiche Laufzeit (Dummy-Hash) für unbekannte Benutzer | `auth_test.php` |
| Sitzung | 32 Byte Zufall, nur SHA-256 in der DB, Cookie `HttpOnly; Secure; SameSite=Strict; Path=/notizen/`, 60 Tage gleitend, neue ID bei jedem Login; Sperren/Reset/Löschen beenden alle Sitzungen | `auth_test.php`, `admin_test.php` |
| CSRF | Token pro Sitzung im Header `X-CSRF-Token` für jedes POST, zusätzlich Origin-Prüfung | `auth_test.php` |
| Rechte | Jede Datenabfrage auf `user_id` des Aufrufers; fremde Daten nur über Freigabe (`can_read_note`) oder Admin-Routen mit Protokoll | `sync_test.php` (Isolation), `share_test.php`, `assets_test.php` |
| SQL | Ausschließlich vorbereitete Anweisungen; eingesetzt werden nur interne Konstanten und `(int)`-Werte (LIMIT, Spaltenlisten) | Review |
| XSS | Keine `innerHTML`/`eval` im eigenen Code; Benutzertexte nur über `textContent`/Attribute; CSP `default-src 'self'` ohne `unsafe-inline`/`unsafe-eval`; pdf.js mit `isEvalSupported: false` | Review, CSP-Browsertest (P20) |
| Uploads | Nur JPEG (Signatur geprüft), id = SHA-256 des Inhalts, ≤ 8 MB, Quota pro Benutzer, Auslieferung mit festem `Content-Type` + `nosniff` | `assets_test.php` |
| Interne Dateien | Jede PHP-Datei in `backend/` und `config.php` antwortet ohne Einstieg über `api.php` mit 403 (`.htaccess`-Sperren greifen auf dem Webspace nicht zuverlässig); Deploy prüft das live | Deploy-Check |
| Secrets | DB-Zugang und Admin-Hash nur in der vom Deploy erzeugten `config.php` (nie im Repo); Admin-Passwort-Reset über geändertes Secret | – |
| Abmelden | „Abmelden und Daten löschen“ entfernt die lokale Datenbank und schickt `Clear-Site-Data: "cache"` (zwischengespeicherte Bilder) | `auth_test.php` |
| Admin | Letzter aktiver Admin nicht sperr-/lösch-/herabstufbar; Einsicht in Notizen, Sicherungen und alle Kontoaktionen werden protokolliert | `admin_test.php` |

## Bewusst akzeptiert (Restrisiken)
- **Admins können alle Notizen lesen** (Anforderung). Die App weist im Konto darauf hin; jeder Zugriff steht im Protokoll.
- **Lokale Daten auf dem Gerät** (IndexedDB) sind nicht zusätzlich verschlüsselt – Schutz über die Gerätesperre des iPads.
  Wer sich auf einem fremden Gerät anmeldet, sollte beim Abmelden „Daten löschen“ wählen.
- **Kein HSTS-Header**: Er würde für die ganze Domain phpexpert.de gelten (auch die Spiele); die App selbst läuft nur per HTTPS
  (Cookie `Secure`).
- **Keine Zwei-Faktor-Anmeldung** – für eine Familien-App mit wenigen Konten verhältnismäßig.
- **Server-Backups** liegen beim Hoster; zusätzlich gibt es die Gesamtsicherung im Admin-Bereich (Datei enthält alle Notizen →
  sicher aufbewahren).
