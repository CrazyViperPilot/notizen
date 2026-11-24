# pdf.js (vendored)

- Version: pdfjs-dist 4.10.38 (npm), Build `legacy/build`
- Herkunft: `npm pack pdfjs-dist@4.10.38`, daraus nur `legacy/build/pdf.min.js` und `legacy/build/pdf.worker.min.js` sowie `LICENSE` (Apache-2.0)
- Verwendung: nur bei Bedarf, dynamisch aus `js/import/importer.js` geladen (PDF-Import). Keine npm-Abhängigkeit im Repo.
- Der Worker wird über `GlobalWorkerOptions.workerSrc` aus demselben Ordner geladen (CSP `worker-src 'self'`).
- Kein Update ohne Prüfung der CSP (`.htaccess`) und des PDF-Imports auf dem iPad.
- Die Dateien heißen hier `.js` statt `.mjs` (Webspace liefert `.mjs` nicht zuverlässig als JavaScript aus); Inhalt unverändert.
