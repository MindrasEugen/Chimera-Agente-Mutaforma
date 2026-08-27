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
- Uno script (anche minimale, `node` o manuale) che legga `logs/quality.jsonl` e mostri: percentuale di feedback positivo per preset, ed eventualmente per categoria di parola chiave che ha scatenato il suggerimento — per capire se es. "tecnico" viene confermato spesso o corretto spesso dall'utente.
- Sulla base di questo, aggiustare le liste di keyword in `suggestPreset()` (aggiungerne, toglierne, cambiare le soglie).

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

## Fase 4 — Altre idee emerse esplorando il codice — 🔲 NON iniziata, solo annotate

Idee raccolte ma non pianificate in dettaglio, da valutare quando si arriva a quel punto:

- **Instradamento che tiene conto della cronologia recente**, non solo del singolo messaggio (`this.history` esiste già in `agent.js` — oggi `suggestPreset` guarda solo l'ultimo input).
- **Preset "creativo"** manca in `config.json` pur essendo citato nell'help testuale di `bin/chimera.js` (`/veloce | /potente | /creativo | /tecnico`) e nei nomi di modello nel testo di `!help` (che cita ancora Gemini/Llama/Mistral/Gemma, non più i modelli NVIDIA/Cohere/Poolside attuali) — disallineamento preesistente, non toccato in questa sessione perché fuori scope, ma da sistemare quando si tocca di nuovo `bin/chimera.js` per evitare confusione con l'utente.
- **Health check di qualità, non solo di vita**: `checkAllModels()` verifica solo `alive: true/false` con un ping da 1 token — potrebbe in futuro usare `quality.jsonl` per marcare un preset come "vivo ma scadente" e suggerire `healPreset` anche in quel caso, non solo quando il modello smette di rispondere del tutto.
- **Collegamento con lo storico di Nova/Vibe (Claude Code)**: valutato e scartato per ora — Chimera resta volutamente isolata da `%USERPROFILE%\.claude\`; se in futuro serve un collegamento, deve essere Claude Code a leggere `logs/chimera-failures.md` da fuori, mai il contrario.

---

## Punti 2 e 3 di questa sessione (infrastruttura, non "fasi" del routing)

Questi non sono fasi del piano di instradamento ma infrastruttura di supporto, richiesta e completata in questa stessa sessione:

- **Log di qualità** (`logs/quality.jsonl`) — ✅ completato. Comandi `!feedback +` / `!feedback -`, una riga JSON per feedback con data, preset, modello, primi 100 caratteri del task, esito. Alimenta la Fase 2 sopra.
- **Log di errori rilevanti** (`logs/chimera-failures.md`) — ✅ completato. Registra i casi in cui un task non viene completato (rate limit dopo tutti i tentativi, errore non recuperato da `healPreset`) — non i semplici `alive:false` di routine, quelli restano solo in `logs/health_*.json` come già facevano. File dentro `~/.chimera/logs/`, mai in `%USERPROFILE%\.claude\`.

## Stato a fine sessione odierna

- Fase 1: implementata e verificata sintatticamente. Da provare in uso reale per giudicare se le euristiche sono sensate (esempi di prova nel riepilogo di fine sessione).
- Punti 2 e 3: implementati.
- Fasi 2, 3, 4: solo pianificate, nessun codice scritto — richiedono dati d'uso reali (Fase 2) prima di avere senso.
