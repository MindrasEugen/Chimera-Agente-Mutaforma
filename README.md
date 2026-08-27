# Chimera

## 1. Cos'è Chimera

Chimera è un agente CLI "mutaforma": parla con più modelli AI gratuiti via [OpenRouter](https://openrouter.ai) e sceglie quale usare in base al tipo di task, invece di restare legato a un solo modello.

Due livelli di autonomia, volutamente separati:

- **Instradamento per contenuto** — quando scrivi un task senza scegliere un preset a mano, Chimera suggerisce quello più adatto in base a un'euristica a parole chiave e chiede conferma prima di usarlo. Non sceglie mai in silenzio.
- **Auto-guarigione dei modelli morti** (`healPreset`) — se il modello di un preset smette di rispondere, Chimera lo sostituisce da sola con un'alternativa gratuita disponibile su OpenRouter, senza chiedere conferma: è la sua identità di "mutaforma", pensata per restare sempre operativa.

Preset attualmente configurati (`config.json`):

| Preset | Descrizione |
|---|---|
| `tecnico` | Specializzato in codice |
| `veloce` | Piccolo e rapidissimo |
| `potente` | Ragionamento complesso (NVIDIA) |
| `bilanciato` | Bilanciato NVIDIA |
| `creativo` | Scrittura e creatività |

I modelli dietro ciascun preset possono cambiare nel tempo (rotazione automatica via `healPreset`) — l'elenco affidabile è sempre `/list` dentro l'app, non questa tabella.

## 2. Setup

**Requisiti:** Node.js 18 o superiore (Chimera usa `fetch` nativo, senza dipendenze aggiuntive per le chiamate HTTP dirette a OpenRouter).

**Installazione dipendenze**, dalla cartella del progetto (`~/.chimera`):

```powershell
npm install
```

**Configurazione della API key** — Chimera legge la chiave OpenRouter dalla variabile d'ambiente `CHIMERA_API_KEY`, mai da `config.json` (che oggi ha `"api_key": ""` e resta così). Il modo consigliato è un file `.env` nella root del progetto:

```
CHIMERA_API_KEY=sk-or-v1-...
```

`.env` è già escluso da git (`.gitignore`) — verificato. Se in futuro sposti o rinomini quel file, controlla che resti nella lista prima di fare un commit. `.env` ha sempre precedenza su un'eventuale variabile d'ambiente OS con lo stesso nome, quindi basta modificare quel file per cambiare chiave, senza toccare il sistema.

**Avvio.** Se hai già configurato la funzione `chimera` nel profilo PowerShell (`$PROFILE`), basta:

```powershell
chimera
```

In alternativa, da qualunque terminale, dalla root del progetto:

```powershell
node bin/chimera.js
```

## 3. Comandi disponibili

**Cambio preset manuale** — `/nome-preset` (es. `/tecnico`, `/veloce`, `/potente`, `/bilanciato`, `/creativo` — l'elenco esatto e aggiornato è sempre quello di `/list`, che legge `config.json` dal vivo). Una scelta manuale ha sempre priorità sul suggerimento automatico per il task immediatamente successivo.

**Comandi con `!`:**

| Comando | Cosa fa |
|---|---|
| `!help` | Mostra l'aiuto (preset con relative descrizioni, letti da `config.json`) |
| `!health` | Verifica se i modelli configurati rispondono; per un modello morto propone alternative gratuite; per un modello vivo ma con feedback di qualità scarso lo segnala senza sostituirlo |
| `!current` | Mostra il preset e il modello attualmente in uso |
| `!clear` | Svuota la cronologia della conversazione |
| `!shell <comando>` | Esegue un comando shell direttamente (bypassa il modello — utile per verifiche rapide) |
| `!feedback +` | Segnala che l'ultima risposta è stata utile |
| `!feedback -` | Segnala che l'ultima risposta NON è stata utile |
| `!exit` | Esce, mostrando il totale token usati nella sessione |

**Suggerimento automatico del preset** — quando scrivi un task in chiaro (non `/comando`, non `!comando`) senza aver appena selezionato un preset a mano, Chimera valuta il testo con un'euristica a parole chiave e, se individua un preset diverso da quello attivo, chiede conferma:

```
Task rilevato come tecnico → uso /tecnico? [invio per confermare, o scrivi un altro preset]:
```

- **Invio** (risposta vuota) → conferma e passa al preset suggerito.
- **Nome di un altro preset esistente** → passa a quello invece.
- **Qualsiasi altra risposta** → resta sul preset attuale, il task parte comunque.

Se il suggerimento coincide col preset già attivo, non viene chiesto nulla. Se non c'è un segnale chiaro nel messaggio corrente, Chimera guarda anche gli ultimi messaggi della conversazione prima di ricadere sul preset veloce di default — ma un segnale esplicito nel messaggio attuale vince sempre su quello.

## 4. Sicurezza

Quando un modello propone di eseguire un comando shell o di scrivere/creare un file, Chimera mostra sempre il contenuto esatto e chiede conferma esplicita (`y`/`n`) prima di agire — **non c'è mai esecuzione automatica**. Se rifiuti, l'azione non avviene e viene segnalato chiaramente nell'output. Letture di file ed elenchi di directory restano automatici (sola lettura, rischio minimo). Esiste inoltre una lista di comandi shell bloccati a prescindere dalla conferma (es. `format`, comandi su `system32`, `shutdown`, `diskpart`) come rete di sicurezza aggiuntiva.

La API key OpenRouter vive solo in `.env`, mai in un file tracciato da git.

## 5. Log e dati raccolti

Tutto dentro `~/.chimera/logs/` — mai nella cartella `.claude` di Claude Code, che è un sistema completamente separato:

- **Health check dei modelli** (`health_YYYY-MM-DD.json`, `last_check.json`) — esito del controllo periodico "il modello risponde?" ed eventuali sostituzioni automatiche (`model-swaps.log`).
- **Log di qualità** (`quality.jsonl`) — un feedback per riga, alimentato da `!feedback +`/`!feedback -`: preset, modello, estratto del task, esito. Per un riepilogo leggibile: `npm run quality-report`.
- **Log di errori rilevanti** (`chimera-failures.md`) — task che non sono stati completati (non i semplici modelli irraggiungibili di routine, quelli restano solo negli health check).

## 6. Stato del progetto e sviluppi futuri

L'instradamento automatico per contenuto è attivo dalla Fase 1 ed è stato esteso nella Fase 4 (preset creativo, cronologia recente, health check di qualità). Le fasi successive — raffinare le euristiche sui dati reali raccolti, eventualmente affiancarle con una classificazione via AI — richiedono un volume d'uso reale non ancora accumulato. Per i dettagli, la roadmap completa e lo stato aggiornato di ogni fase: [`PIANO-SVILUPPO.md`](./PIANO-SVILUPPO.md).
