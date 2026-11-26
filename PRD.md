# Notizen – PRD (v0.1, Entwurf)

Minimale Handschrift-Notiz-App für das iPad mit Apple Pencil, als Web-App (PWA) mit PHP/MySQL-Backend,
Benutzerverwaltung und Admin-Bereich. Eigenes Repo `CrazyViperPilot/notizen`; ausgeliefert unter `phpexpert.de/notizen/`
(eigener Service-Worker-Cache mit Präfix `notizen-`, eigene IndexedDB, eigene Cookies mit Pfad `/notizen/`).
Die Startseite der Spielesammlung (Repo `games`) verlinkt nur dorthin.

Status: **Entwurf 2026-11-23, noch nicht umgesetzt.** Technische Umsetzung: [`docs/ARCHITEKTUR.md`](docs/ARCHITEKTUR.md),
Arbeitspakete: [`PLAN.md`](PLAN.md).

## 1. Ziele
- Auf dem **iPad Air mit Apple Pencil** in Safari bzw. als Home-Bildschirm-App flüssig handschriftlich schreiben.
- **Minimal:** wenige Papiersorten, wenige Werkzeuge, keine Spielereien.
- Notizen in **Ordnern und Unterordnern** organisieren.
- **Offline schreiben**, später automatisch mit dem Server abgleichen. Kein Datenverlust durch WLAN-Abbrüche.
- **Benutzerkonten**: Der Admin legt Benutzer an und verwaltet sie. Es gibt keine Selbstregistrierung.
- Notizen **nur lesend teilen** mit anderen Benutzern.
- Läuft komplett unter **`https://phpexpert.de/notizen/`** (Oberfläche und API auf derselben Domain).
- Vanilla JS ohne Build-Schritt, PHP ohne Framework, MySQL/MariaDB.

## 2. Nicht-Ziele (v1)
- Keine Handschrifterkennung, keine Textsuche im Geschriebenen (Suche nur über Titel und Ordnernamen).
- Keine Tastatur-Textfelder. (Bilder/PDF-Import, Formen-Erkennung und Lasso kamen später dazu.)
- Kein gemeinsames Bearbeiten derselben Notiz durch mehrere Benutzer; Teilen nur lesend, außer der Korrektur-Ebene (Abschnitt 7).
- Keine Selbstregistrierung und kein „Passwort vergessen“ per E-Mail (der Admin setzt Passwörter zurück).
- Keine native iOS-App und keine Unterstützung der Pencil-Gesten Doppeltippen/Squeeze (im Browser nicht verfügbar).
- Andere Geräte (Android, Desktop mit Maus) sollen funktionieren, sind aber nicht das Optimierungsziel.

## 3. Rollen
| Rolle | Darf |
|---|---|
| **Benutzer** | Eigene Ordner und Notizen anlegen, bearbeiten, löschen und teilen. Mit ihm geteilte Notizen lesen. Eigenes Passwort ändern. |
| **Admin** | Alles, was ein Benutzer darf (hat eigene Notizen), dazu der Admin-Bereich (Abschnitt 8). |

Das erste Admin-Konto kommt aus GitHub-Secrets (Abschnitt 9). Weitere Admins kann ein Admin ernennen.

## 4. Anmeldung und Konto
- Anmeldung mit **Benutzername + Passwort**. Die Sitzung bleibt **60 Tage** gültig und verlängert sich bei jeder Nutzung.
- Vom Admin angelegte Konten und zurückgesetzte Passwörter sind **Einmal-Passwörter**: Nach der Anmeldung muss man ein eigenes Passwort setzen.
- Passwortregeln: mindestens 10 Zeichen. Keine weiteren Zwangsregeln.
- **Schutz gegen Raten:** Nach 5 Fehlversuchen für denselben Benutzernamen oder dieselbe IP sind weitere Versuche 15 Minuten gesperrt.
- Konto-Seite: Anzeigename, Passwort ändern, „Auf allen Geräten abmelden“, Speicherverbrauch, Hinweis
  **„Admins können deine Notizen einsehen“** (Transparenz, siehe Abschnitt 8).
- **Abmelden** fragt, ob die lokalen Daten auf diesem Gerät gelöscht werden sollen. Hat das Gerät noch nicht
  abgeglichene Änderungen, warnt die App vorher deutlich.
- **Offline:** Wer auf dem Gerät schon angemeldet war, kann die App ohne Netz öffnen und weiterschreiben.
  Ist die Sitzung inzwischen abgelaufen, bleibt alles lokal erhalten und wird nach der nächsten Anmeldung
  **desselben** Benutzers hochgeladen.

## 5. Bibliothek (Ordner und Notizen)
- Startansicht: **Ordnerbaum** links (Seitenleiste im Querformat, ausklappbar im Hochformat), rechts der Inhalt des
  gewählten Ordners als **Raster mit Vorschaubildern** (erste Seite), Unterordner zuerst.
- Beliebig tiefe **Unterordner**. Notizen können auch direkt in der obersten Ebene liegen.
- Aktionen für Ordner und Notizen: **Neu, Umbenennen, Verschieben** (Zielordner wählen), **Löschen** (in den Papierkorb), **Teilen**.
- **Favoriten** (★, im Kachelmenü) und **Zuletzt geöffnet** (pro Gerät) oben in der Übersicht.
- Sortierung: Ordner alphabetisch, Notizen nach „zuletzt geändert“ (umschaltbar auf alphabetisch).
- **Suche** über Notiztitel und Ordnernamen.
- **Papierkorb:** Gelöschte Ordner und Notizen bleiben 30 Tage wiederherstellbar und werden danach endgültig
  gelöscht. Ein gelöschter Ordner nimmt seinen Inhalt mit. Der Papierkorb lässt sich manuell leeren.
- Bereich **„Mit mir geteilt“** unterhalb des eigenen Baums (Abschnitt 7).
- Ein **Statussymbol** oben zeigt: abgeglichen ✓ / wird abgeglichen / offline (n Änderungen ausstehend) / Fehler.

## 6. Editor
### 6.1 Seiten und Papier
- Eine Notiz besteht aus Seiten im Format **DIN A4** (210 × 297 mm, Standard), **DIN A5** (148 × 210 mm) oder **DIN A3** (297 × 420 mm),
  wahlweise **hoch oder quer**, beides pro Seite einstellbar (Seitenmenü „Format“). Papiermuster bleiben in echten Millimetern.
- **Papiersorten** (pro Seite): **Blanko, Liniert** (8 mm Zeilenabstand, Rand links), **Kariert** (5 mm), **Gepunktet** (5 mm),
  **Lineatur 1–4** (Schulhefte mit Hilfslinien, Werte anpassbar), **Rechenkästchen mit Rand**, **Koordinatensystem** (Achsen mit
  cm-Teilung), **Millimeterpapier**, **Notenlinien**, **Isometriepapier**,
  **Vokabeln** (liniert, Trennlinie zwischen Wort und Übersetzung, schmale Spalte rechts zum Abhaken, darüber eine Zeile für Überschriften).
- **Vokabeln abfragen:** Hat eine Notiz Vokabel-Seiten, zeigt die Werkzeugleiste „Abfragen“. Dann ist die Übersetzungs-Spalte
  abgedeckt (umschaltbar: die Wörter abdecken); Antippen einer Zeile mit Finger oder Stift deckt sie auf bzw. wieder zu,
  Scrollen bleibt möglich, die Abhak-Spalte bleibt frei. Abgehakte Zeilen gelten als gekonnt (bleiben offen, grün), Zähler „gekonnt: x von y“,
  „Nächste“ fragt eine zufällige offene Vokabel ab. Nach dem Aufdecken antwortet man mit „✓ Gewusst“ (setzt automatisch den Haken)
  oder „✗ Nicht gewusst“ (wieder zugedeckt, kommt später erneut); danach geht es automatisch weiter. „Alle aufdecken“, „Alle zudecken“, „Fertig“. Nichts davon wird gespeichert.
  Papier ist weiß, Linien hellgrau bzw. hellblau.
- Neue Notiz: Titel (Standard: Datum), Papiersorte, Ausrichtung und Format wählen. Die Werte der letzten Notiz sind vorausgewählt.
- **Seitenübersicht** (Miniaturen, springen, umsortieren per Ziehen, duplizieren, löschen).
- **Foto oder PDF einfügen** (z. B. Arbeitsblatt abfotografieren): jede Bild-/PDF-Seite wird eine Seite mit dem Bild als Hintergrund, darauf schreiben.
- Seiten **hinzufügen** (am Ende oder nach der aktuellen Seite, übernimmt das Papier der aktuellen Seite), **löschen**,
  **Papier ändern**. Die Seiten werden untereinander gescrollt.

### 6.2 Werkzeuge
- **Stift** mit Druckempfindlichkeit, **3 Stärken** (fein, mittel, dick) und **6 Farben** (Schwarz, Dunkelblau, Rot, Grün, Orange, Lila),
  danach **3 eigene Farbslots**: Antippen wählt den Slot und öffnet den Farbwähler des Systems (voller RGB-Raum); die Slotfarben bleiben gemerkt.
- **Textmarker**: halbtransparent, liegt optisch unter der Schrift, 3 Farben (Gelb, Grün, Pink) und ebenfalls **3 eigene Farbslots**
  (eigene Farbe wird getrennt vom Stift gemerkt), fester breiter Strich.
- **Bleistift** zum Schraffieren: halbtransparent, 3 Stärken und die Farben des Stifts (inkl. 3 eigener Farbslots). Die Breite hängt am
  Apple Pencil: schräg gehalten wird der Strich breit und weich, senkrecht bleibt er fein.
- **Radierer**: Modus „Ganze Striche“ (löscht berührte Striche) oder „Teilweise“ (entfernt nur den berührten Teil).
  Stifte mit **Radier-Ende** oder **Seitentaste** (gedrückt halten beim Schreiben) radieren direkt, ohne Werkzeugwechsel –
  sofern der Browser die Taste meldet (Android/Windows oft ja, Apple Pencil hat keine). Die Spielwiese zeigt an, was der Stift meldet.
- **Formen geraderücken**: Stift am Ende kurz ruhig halten → Linie, Pfeil, Kreis, Ellipse, Rechteck (auch gedreht), Dreieck oder Vieleck.
- **Lasso**: Striche einkreisen → verschieben, vergrößern/verkleinern, **drehen** (Griff über der Auswahl, rastet alle 15° ein),
  Farbe ändern, duplizieren, löschen, **kopieren** und auf einer anderen Seite oder in einer anderen Notiz **einfügen**
  (Seitenmenü „Einfügen“, Cmd/Strg+C/X/V), **abdecken** (zum Lernen).
- **Rückgängig / Wiederholen** (pro geöffneter Notiz, bis zu 100 Schritte, gilt bis zum Schließen der Notiz).
- Werkzeugleiste oben, kompakt, mit großen Tippflächen (mindestens 44 pt).

### 6.3 Eingabe
- **Nur der Apple Pencil zeichnet.** Finger scrollen (1 Finger) und zoomen (2 Finger, 100–400 %).
  Die aufliegende Handfläche löst nichts aus.
- **Gesten:** mit zwei Fingern tippen = Rückgängig, mit drei Fingern = Wiederholen; lange mit dem Finger auf einen Strich drücken =
  dessen Farbe übernehmen (Pipette); schnell mit zwei Fingern zusammenziehen = zurück auf ganze Seitenbreite.
- **Glättung** der Schrift im Konto einstellbar: Direkt / Normal / Stark.
- Wer keinen Stift hat (anderes Gerät, Maus), kann in den Einstellungen **„Mit Finger/Maus zeichnen“** einschalten.
  Dann scrollt man mit zwei Fingern.
- Die Linie folgt dem Stift ohne spürbare Verzögerung, die Darstellung ist auch beim Zoomen scharf.
- Die Linien werden leicht geglättet, ohne die Handschrift zu verfälschen.

### 6.3a Lineal
- Transparentes **Lineal** (30 cm, mm- und cm-Skala im Maßstab der Seite) über der Schreibfläche, ein- und ausblendbar
  (Knopf „Messwerkzeuge“ → Lineal, Taste **r**). Mit Finger/Maus **verschieben**, mit zwei Fingern oder dem Dreh-Griff **drehen**
  (rastet bei 0°/45°/90° ein, Doppeltipp = 0°). Ein Stift-Strich, der an einer Längskante beginnt, läuft gerade an der Kante entlang.
  Lage, Winkel und an/aus werden pro Gerät gemerkt.
- **Geodreieck** (wie im Mathematikunterricht): lange Kante 16 cm mit mm-Skala und 0 in der Mitte, Winkelmesser 0–180° in zwei
  gegenläufigen Reihen um den Nullpunkt, Parallelen im 5-mm-Abstand, rechter Winkel an der Spitze. Knopf „Messwerkzeuge“ → Geodreieck, Taste **g**.
  Verschieben und Drehen wie beim Lineal (Drehpunkt ist der Nullpunkt, Griff bei der Spitze); der Stift zeichnet an allen drei Kanten
  gerade Linien. Lineal und Geodreieck können gleichzeitig sichtbar sein.

- **Zirkel**: Einstichpunkt und Radius (mm-genau, „r = 3,5 cm“) einstellen; der Stift zeichnet am Kreis exakte Bögen. Taste **z**.
- Lineal, Geodreieck und Zirkel liegen gemeinsam hinter dem Knopf **„Messwerkzeuge“** (Tasten r, g, z). Beim Zeichnen an einem
  Messwerkzeug zeigt eine **Messanzeige** Länge und Winkel (bzw. Radius und Bogen), beim Drehen einer Auswahl den Winkel.
  Die Lineal-Länge (15, 20 oder 30 cm) ist im Konto einstellbar.

### 6.3b Lernen, Lesezeichen, Präsentieren
- **Lernkartei**: Die Vokabel-Abfrage merkt sich je Zeile ein Fach (1–5, Leitner); „Gewusst“ rückt ein Fach weiter, „Nicht gewusst“
  zurück in Fach 1. „Nächste“ fragt fällige Vokabeln aus niedrigen Fächern bevorzugt. Das Häkchen wird gesetzt, sobald eine Vokabel
  Fach 5 erreicht. Der Lernstand wird gespeichert und synchronisiert; die Leiste zeigt „Fächer 3·2·1·0·0“.
- **Abdecken**: Auf jeder Seite Bereiche mit dem Lasso abdecken; in „Abfragen“ sind sie zugedeckt und lassen sich antippen.
  „Abdeckungen dieser Seite entfernen“ im Seitenmenü.
- **Lesezeichen**: Seiten benennen (Seitenmenü), Sprungliste „Lesezeichen anzeigen…“; im PDF als Inhaltsverzeichnis.
- **Titelblatt einfügen**: Vorlage wie beim Export, wird eine neue erste Seite (darauf schreibbar).
- **Präsentieren**: Seite für Seite im Vollbild, blättern mit Wischen/Tasten, **Laserpointer** (rote, verblassende Spur, nichts wird gespeichert).
- **Format ändern** fragt bei beschriebenen Seiten, ob der Inhalt mitskaliert werden soll.
- **Fächerfarben**: Ordner farbig markieren (8 Farben); Notizen zeigen die Farbe ihres Ordners.

### 6.4 Speichern
- **Automatisch**, ohne Speichern-Knopf. Lokal spätestens 1 s nach dem letzten Strich, auf dem Server
  (falls online) spätestens nach ein paar Sekunden.
- Schließen, App-Wechsel oder Akku leer dürfen höchstens den gerade gezeichneten Strich kosten.

### 6.5 Export
- **PDF-Export** einer Notiz: Vektor-PDF im Format der Seiten mit Papierhintergrund, über das Teilen-Menü von iPadOS
  (Dateien, AirDrop, Mail). Vor dem Export ein Dialog:
  - **Titelblatt** aus einer Vorlage voranstellen („Klassisch“, „Schulheft“, „Schlicht“) mit Feldern (Titel, Untertitel, Name, Datum,
    Fach, Klasse, Schuljahr je nach Vorlage) und Vorschau; Format wie die erste Seite. Die letzte Wahl wird gemerkt.
  - **PDF/A** (PDF/A-2b, Archivformat) wahlweise.
  - **Seitenzahlen** und **Lesezeichen** (Inhaltsverzeichnis) wahlweise. Korrekturen (Abschnitt 7) werden mit exportiert, wenn sie eingeblendet sind.
- **Backup**: Export aller eigenen Notizen als eine Datei (`.notizen`) und **Import** einer solchen Datei.
  Importierte Inhalte landen als Kopie in einem neuen Ordner „Import <Datum>“.

## 7. Teilen (nur lesen)
- Ein Benutzer kann einen **Ordner** (samt allen Unterordnern und Notizen, auch künftig hinzukommenden)
  oder eine **einzelne Notiz** für **ausgewählte Benutzer** freigeben.
- Der Teilen-Dialog zeigt die anderen aktiven Benutzer mit Anzeigenamen, dazu die bestehenden Freigaben mit „Aufheben“.
- Empfänger sehen unter **„Mit mir geteilt“** die Freigaben nach Besitzer gruppiert. Sie können lesen, blättern,
  zoomen und als PDF exportieren, aber nichts ändern.
- Zuletzt geöffnete geteilte Notizen sind auch **offline lesbar** (Zwischenspeicher, kein Sync-Ziel).
- Gelöschte oder nicht mehr geteilte Inhalte verschwinden beim Empfänger beim nächsten Online-Abruf.
- **Abgabe und Korrektur**: Im Teilen-Dialog je Person „Korrigieren“ erlauben. Diese Person kann in der geteilten Ansicht
  „Korrigieren“ einschalten und mit Rotstift, Grün, Textmarker und Radierer in einer **eigenen Ebene** schreiben (nur online,
  die Schrift des Besitzers bleibt unverändert). Der Besitzer sieht die Korrekturen im Editor obenauf, kann sie ausblenden und je Seite entfernen.

## 8. Admin-Bereich (`/notizen/admin.html`, nur online)
- **Benutzerliste** mit Benutzername, Anzeigename, Rolle, Status (aktiv/gesperrt), letzter Anmeldung,
  Speicherverbrauch und Anzahl der Notizen.
- **Benutzer anlegen**: Benutzername (a–z, 0–9, `.-_`, 3–32 Zeichen, unveränderlich), Anzeigename, Rolle,
  Speicherlimit (Standard 500 MB). Die App erzeugt ein **Einmal-Passwort** und zeigt es genau einmal an
  (alternativ selbst eingeben).
- **Bearbeiten**: Anzeigename, Rolle, Speicherlimit.
- **Passwort zurücksetzen**: neues Einmal-Passwort, alle Sitzungen des Benutzers werden beendet.
- **Sperren / Entsperren**: Ein gesperrtes Konto kann sich nicht anmelden, bestehende Sitzungen enden sofort.
  Seine Freigaben bleiben bestehen, sind aber unsichtbar, solange es gesperrt ist.
- **Sitzungen beenden** („überall abmelden“).
- **Löschen**: nach Eingabe des Benutzernamens zur Bestätigung. Löscht das Konto mit allen Notizen und Freigaben endgültig.
- **Notizen einsehen**: Ordnerbaum und Notizen eines Benutzers **nur lesend** ansehen und als PDF exportieren.
  Jeder Zugriff landet im Protokoll.
- **Protokoll**: Admin-Aktionen (anlegen, ändern, sperren, löschen, Passwort zurücksetzen, Notizen einsehen) mit Zeit, Admin und Ziel.
- Schutzregeln: Der letzte aktive Admin kann nicht gesperrt, gelöscht oder zum Benutzer herabgestuft werden.
  Ein Admin kann sich nicht selbst löschen.

## 8a. Spielwiese (`/notizen/labor.html`)
- Bleibt dauerhaft: Zeichenfläche ohne Konto und Server zum Ausprobieren des Stifts (z. B. auf einem neuen Tablet) und zur Fehlersuche.
- Vier feste Seiten (liniert, kariert, gepunktet, blanko), speichert nur lokal im Browser, kein Abgleich.

## 8b. Datensicherung
- Konto: „Backup herunterladen“ / „Backup einspielen“ (Datei `.notizen`). Admin: Gesamtsicherung aller Benutzer und Sicherung einzelner Benutzer.

## 9. Betrieb
- Deploy per GitHub Actions (FTP) aus diesem Repo nach `phpexpert.de/notizen/` (eigener FTP-Zugang, Login startet im Web-Ordner /notizen).
- **Secrets** (in diesem Repo): FTP-Zugang (`FTP_SERVER`, `FTP_USER`, `FTP_PASSWORD`; Login startet im Web-Ordner `/notizen`), MySQL-Zugang (`NOTIZEN_DB_HOST`, `NOTIZEN_DB_PORT`, `NOTIZEN_DB_NAME`, `NOTIZEN_DB_USER`, `NOTIZEN_DB_PASSWORD`) und
  Erst-Admin (`NOTIZEN_ADMIN_USER`, `NOTIZEN_ADMIN_PASSWORD`). Wird `NOTIZEN_ADMIN_PASSWORD` geändert, setzt der
  nächste Deploy das Passwort dieses Admins zurück. Das ist der Notfallzugang, falls man sich ausgesperrt hat.
- Die Datenbank-Tabellen legt die App beim ersten Aufruf nach einem Deploy selbst an bzw. aktualisiert sie (Migrationen).
- Die Startseite des Repos `games` bekommt eine Karte „Notizen“, die auf `https://phpexpert.de/notizen/` verlinkt.
- **Datensicherung** des Servers: über die Backup-Funktion des Hosters (MySQL). Zusätzlich hat jeder Benutzer den Backup-Export.

## 10. Qualitätsziele
- Schreiben fühlt sich auch auf einer Seite mit 2.000 Strichen flüssig an (60 fps beim Zeichnen, sichtbare Verzögerung unter ca. 30 ms auf iPad Air M1 oder neuer).
- Eine Notiz mit 50 Seiten öffnet in unter 2 s und scrollt flüssig.
- Kein Datenverlust bei Offline-Betrieb, App-Abbruch oder parallelem Schreiben auf zwei Geräten.
  Bei Konflikten bleibt beides erhalten (Abschnitt „Sync“ in der Architektur).
- Sicherheit: Passwörter nur als bcrypt-Hash, Sitzungs-Cookie `HttpOnly; Secure; SameSite=Strict`, CSRF-Schutz,
  alle SQL-Abfragen mit Platzhaltern, strikte Content-Security-Policy, keine Benutzerinhalte per `innerHTML`.
- Benutzer sehen niemals Daten anderer Benutzer, außer über ausdrückliche Freigaben. Das ist durch Tests abgesichert.

## 11. Offene Punkte
- PHP- und MySQL-Version auf dem dogado-Webspace sind unbekannt. Der Code bleibt **PHP-7.4-kompatibel**, ein
  Ping-Endpunkt meldet die Versionen nach dem ersten Deploy.
- Die MySQL-Datenbank muss bei dogado angelegt und die Zugangsdaten als Secrets hinterlegt werden (Betreiber).
- Später denkbar: Pixel-Radierer, Lasso/Verschieben, Kopie einer geteilten Notiz in die eigenen Notizen, Seiten umsortieren.
