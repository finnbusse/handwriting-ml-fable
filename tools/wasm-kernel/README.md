# WASM-Kernel (noch nicht eingebunden)

Ergebnis der Tempo-Recherche: ein handgeschriebener WebAssembly-SIMD-Kern für
das Netz. Gemessen auf einem Server-Kern mit den vortrainierten Gewichten:

| Variante | Schritte pro Sekunde | Zeit für 700 Punkte |
|---|---|---|
| JavaScript (so läuft die App derzeit) | etwa 460 | etwa 1,5 s |
| WASM SIMD, float32 | etwa 1.700 | etwa 0,4 s |
| WASM SIMD, int16-Gewichte | etwa 3.000 | etwa 0,23 s |

Die App nutzt bisher die reine JavaScript-Engine (`web/js/engine/engine.js`),
die Schritt für Schritt gegen die Python-Referenz geprüft ist. Dieser Kern ist
als späterer Tempo-Ausbau gedacht; bevor er eingebunden wird, muss er dieselbe
Prüfung bestehen (`tests/engine`). `bench.html` misst das Tempo auf dem
eigenen Gerät.

Bauen: `./build.sh` (braucht clang mit wasm32-Ziel und wasm-ld, kein emscripten).
