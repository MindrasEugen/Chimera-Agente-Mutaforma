# Piano di sviluppo — Chimera, verso un instradamento intelligente

Documento vivo. Ogni sessione che tocca l'intelligenza di instradamento (quale AI usare per quale task) aggiorna questo file: cosa è stato fatto, cosa resta, e perché certe scelte sono state prese. Non riguarda la sicurezza (confinamento shell/write, API key, system prompt): quella è trattata come prerequisito sempre valido, non come una fase di questo piano.

## Obiettivo di fondo

Oggi Chimera cambia preset solo su comando esplicito dell'utente (`/tecnico`, `/veloce`, ecc.) o quando un modello smette di rispondere (`healPreset`, autonomia che resta intatta e fuori da questo piano). L'obiettivo è farlo scegliere con criterio *quale AI usare per ogni task*, non solo sopravvivere ai modelli morti — mantenendo sempre la possibilità per l'utente di scegliere manualmente.

## Fase 1 — Instradamento a parole chiave (con conferma) — ✅ COMPLETATA in questa sessione

**Obiettivo:** un primo instradamento automatico, semplice e verificabile a occhio, che suggerisce (non impone) un preset in base al contenuto del task.

**Cosa serve:**
- `ChimeraAgent.suggestPreset(userInput)` in `src/agent.js`: euristica a regex su parole chiave, mappata solo sui preset realmente presenti in `config.json` (oggi: `tecnico`, `veloce`, `potente`, `bilanciato` — niente `creativo`, quindi le regole "creativo" restano scritte e pronte ma inattive finché quel preset non esiste in config).
- In `bin/chimera.js`: prima di inviare un task in chiaro (non `/comando`, non `!comando`), se l'utente non ha appena selezionato un preset a mano, mostra il suggerimento e chiede conferma (invio = accetta, si può scrivere un altro preset, qualsiasi altra risposta lascia il preset attuale invariato). Se il suggerimento coincide col preset già attivo, non chiede nulla.
- La selezione manuale (`/preset`) ha sempre priorità: sopprime il suggerimento per il task immediatamente successivo, poi il suggerimento automatico riprende a funzionare normalmente sui task seguenti (scelta di design: la selezione manuale non disattiva la funzione per sempre, solo per l'input immediatamente successivo — vedi nota sotto).

**Come si misura se ha funzionato:** l'utente prova alcuni task tipo e verifica a occhio se il preset suggerito ha senso (esempi forniti a fine sessione). Non c'è ancora una metrica automatica — è compito della Fase 2.

**Nota di design da rivedere se non convince:** l'interpretazione di "non sovrascrivere la scelta manuale" adottata qui è "sopprimi il prossimo suggerimento, poi riprendi". L'alternativa è "sticky": una volta scelto un preset a mano, i suggerimenti non si ripropongono più finché non si sceglie di nuovo a mano. Se in uso pratico la prima interpretazione risulta fastidiosa (il suggerimento "ritorna" troppo spesso), passare alla seconda è una modifica piccola e localizzata in `bin/chimera.js`.

## Fase 2 — Raffinamento in base al feedback raccolto — 🔲 NON iniziata

**Obiettivo:** usare `logs/quality.jsonl` (implementato in questa sessione, vedi sotto) per capire se le euristiche della Fase 1 suggeriscono presets sensati, e correggerle sulla base dei dati reali invece che di ipotesi.

**Cosa serve:**
- Accumulare un po' di `!feedback +`/`!feedback -` in uso reale (settimane, non ore).
- ✅ **Script già pronto**: `scripts/quality-report.mjs` (`npm run quality-report`) legge `logs/quality.jsonl` e mostra percentuale di feedback positivo per preset, con barra e nota se il campione è piccolo (<5). Verificato con dati finti in uno script temporaneo separato (mai scritti nel vero `quality.jsonl`, che oggi resta assente). **Limite noto**: non rompe per categoria di parola chiave che ha scatenato il suggerimento, perché `quality.jsonl` oggi non registra quella regola — solo preset/modello/task/esito. Se in futuro servisse quel dettaglio, va esteso `logQualityFeedback()`/`lastTask` in `src/agent.js` per portarsi dietro anche la categoria che ha scatenato il suggerimento in `bin/chimera.js`.
- Sulla base dei numeri di `quality-report.mjs`, aggiustare le liste di keyword in `suggestPreset()` (aggiungerne, toglierne, cambiare le soglie).

**Come si misura se ha funzionato:** il tasso di correzione manuale del suggerimento (l'utente scrive un preset diverso da quello suggerito) scende nel tempo.

**Prerequisito:** serve un volume minimo di feedback raccolto — questa fase non ha senso finché `quality.jsonl` non ha abbastanza righe.

## Fase 3 — Classificazione via AI invece che a parole chiave — 🔲 NON iniziata, solo pianificata

**Obiettivo:** quando le euristiche a parole chiave mostrano il loro limite (task ambigui, formulati in modo che nessuna keyword intercetta, o in cui il tono conta più delle parole), sostituire (o affiancare) l'euristica con una chiamata di classificazione leggera a un modello (es. il preset "veloce" stesso, con un prompt dedicato "che tipo di task è questo, rispondi con una sola parola tra le categorie X").

**Cosa serve:**
- Decidere se sostituire del tutto le keyword o usarle come primo filtro veloce (gratis, zero latenza) e la classificazione AI come fallback solo sui casi ambigui — probabilmente la seconda, per non pagare una chiamata extra ad ogni messaggio.
- Gestire il caso in cui anche la chiamata di classificazione fallisce (fallback su euristica o su preset di default, mai un errore bloccante).
- Valutare il costo/latenza aggiuntivo: ogni task guadagnerebbe una seconda chiamata al modello prima di quella "vera".

**Come si misura se ha funzionato:** confronto A/B (anche solo aneddotico all'inizio) tra tasso di correzione manuale con euristica pura vs euristica+classificazione AI sui casi ambigui.

**Prerequisito:** Fase 2 completata — senza sapere dove le keyword falliscono, non si sa nemmeno se serve la Fase 3, né come scrivere il prompt di classificazione.

## Fase 4 — Altre idee emerse esplorando il codice

Quattro punti indipendenti, scelti perché non richiedevano dati reali non ancora raccolti. Completati in sessione dedicata (dopo la Fase 1):

- **1. Preset "creativo" aggiunto** — ✅ completato. `config.json` ora ha `google/gemma-4-31b-it:free` (scelto da `findAllFreeModels()` tra i modelli gratuiti disponibili su OpenRouter, instruction-tuned, generalista). Verificato che `suggestPreset()` ci instrada correttamente task come "scrivimi una poesia" o "scrivi un racconto".
- **2. `!help` dinamico** — ✅ completato. Non elenca più nomi di modello hardcoded (erano obsoleti: Gemini/Llama/Mistral/Gemma non corrispondevano più ai modelli reali NVIDIA/Cohere/Poolside/Google in uso). Ora legge `agent.config.presets` e mostra la descrizione di ciascun preset, quindi resta coerente anche dopo una sostituzione automatica via `healPreset`.
- **3. Instradamento con cronologia recente** — ✅ completato. `suggestPreset()` ora consulta `this.history` (ultimi 3 messaggi utente) SOLO quando il messaggio corrente non ha nessun segnale diretto di parole chiave — mai come priorità sopra un segnale esplicito nel messaggio attuale. Verificato: dopo un contesto tecnico, "e ora?"/"continua" restano su tecnico; ma "scrivimi una poesia" nello stesso contesto passa comunque a creativo, come deve essere.
- **4. Health check di qualità** — ✅ implementato, ⏸️ verifica funzionale sospesa. `readQualityStats()` legge `logs/quality.jsonl` e calcola, per preset con almeno 5 feedback, la percentuale di positivi; se sotto il 40% viene segnalato come "vivo ma qualità scarsa" sia in `!health` sia all'avvio, senza mai triggerare `healPreset()` automaticamente. **Non verificabile con dati reali finché `quality.jsonl` non accumula feedback da uso reale** (il file oggi non esiste — nessun dato fittizio è stato scritto, come richiesto). Verificato solo che `readQualityStats()` si comporta correttamente a file assente (ritorna `{}`, nessun errore).

**Collegamento con lo storico di Nova/Vibe (Claude Code)**: valutato e scartato per ora — Chimera resta volutamente isolata da `%USERPROFILE%\.claude\`; se in futuro serve un collegamento, deve essere Claude Code a leggere `logs/chimera-failures.md` da fuori, mai il contrario. Nessun accesso a quella cartella è stato fatto in nessuna delle sessioni finora.

---

## Infrastruttura di supporto (non "fasi" del routing)

Richiesta e completata nella sessione della Fase 1, non fa parte delle fasi di instradamento ma le alimenta:

- **Log di qualità** (`logs/quality.jsonl`) — ✅ completato. Comandi `!feedback +` / `!feedback -`, una riga JSON per feedback con data, preset, modello, primi 100 caratteri del task, esito. Alimenta la Fase 2 sopra.
- **Log di errori rilevanti** (`logs/chimera-failures.md`) — ✅ completato. Registra i casi in cui un task non viene completato (rate limit dopo tutti i tentativi, errore non recuperato da `healPreset`) — non i semplici `alive:false` di routine, quelli restano solo in `logs/health_*.json` come già facevano. File dentro `~/.chimera/logs/`, mai in `%USERPROFILE%\.claude\`.

## Bug preesistenti risolti

- **Icone/caratteri corrotti in console** — ✅ risolto. `bin/chimera.js` e `src/agent.js` avevano sequenze `??`/`�` al posto di emoji (probabile problema di codifica in un salvataggio precedente al di fuori di questo progetto), incluse due parole italiane rovinate ("pi�" → "più", "disponibilit�" → "disponibilità"). Sostituite con emoji reali e coerenti per categoria (✅/❌ vivo-morto, 🔧 auto-guarigione, 💻 shell, 📝 scrittura file, 📄 lettura file, 📁 elenco directory, 🚫 bloccato/annullato, 🎭 identità di Chimera). Verificato a occhio con uno script di prova poi rimosso.
- **`!health` chiamava un metodo inesistente** — ✅ risolto. In `bin/chimera.js`, il ramo "cerco alternative gratuite" (scatta solo quando `checkAllModels()` trova almeno un modello morto) chiamava `agent.findFreeAlternatives()`, mai esistito su `ChimeraAgent` — solo `findAllFreeModels()` (stessa firma: nessun argomento, ritorna `[{id, name, description}]`). Il bug non si manifestava nei test perché scattava solo col modello morto, cioè proprio il caso d'uso principale di `!health`. Corretto rinominando la chiamata. Verificato simulando un modello morto (monkey-patch temporaneo di `checkModelHealth`/`healPreset`, script poi rimosso): nessun crash, alternative elencate correttamente.

## Esempi osservati in uso reale

**2026-08-27** — prima rotazione automatica osservata in uso normale (non un test), durante un `!health`:

- `veloce`: `poolside/laguna-xs-2.1:free` risultato morto → sostituito automaticamente con `inclusionai/ling-3.0-flash-fin:free`.
- `creativo`: `google/gemma-4-31b-it:free` (il modello scelto per questo preset in Fase 4, pochi giorni prima) risultato morto → sostituito automaticamente con `dots-studio/dots-3-note-preview:free`.
- Nessun intervento manuale richiesto, nessun errore: `healPreset()` ha gestito entrambe le sostituzioni nello stesso ciclo di `!health`. Confermato in `config.json` (modelli aggiornati) e `logs/model-swaps.log` (righe `2026-08-27T18:33:32.567Z` e `2026-08-27T18:33:39.392Z`).

*Perché tenerne traccia:* mostra che la rotazione dei modelli gratuiti non è un caso limite raro ma un evento concreto e frequente — il preset `creativo`, aggiunto da pochissimo, è già alla sua prima sostituzione. Utile come riferimento futuro se si vorrà valutare quali provider (OpenRouter free tier) risultano più stabili nel tempo, magari incrociando questi dati con `logs/model-swaps.log` su una finestra più lunga.

## Stato del progetto

- **Fase 1** (instradamento a parole chiave): implementata e verificata, sia sintatticamente sia con esempi di task reali.
- **Log di qualità e log di errori** (infrastruttura): implementati.
- **Fase 4** (4 punti indipendenti: preset creativo, `!help` dinamico, instradamento con cronologia, health check di qualità): implementata e verificata con esempi — eccetto il punto 4 (health check di qualità), corretto sintatticamente ma non ancora verificabile con dati reali: `logs/quality.jsonl` non contiene ancora feedback da uso reale.
- **Fase 2** (raffinamento in base al feedback): non iniziata — richiede un volume reale di `!feedback +`/`!feedback -` accumulato in uso normale, non ancora presente.
- **Fase 3** (classificazione via AI): non iniziata — dipende dai risultati della Fase 2.
