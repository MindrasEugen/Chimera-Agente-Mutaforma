import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import chalk from 'chalk';
import { exec } from 'child_process';
import { promisify } from 'util';
import dotenv from 'dotenv';

const execAsync = promisify(exec);

// Carica ~/.chimera/.env esplicitamente (non la cwd, visto che chimera si
// lancia da qualsiasi cartella). override:true perche' .env, se presente,
// e' la fonte pensata per essere comoda da modificare: deve vincere anche
// su una vecchia variabile d'ambiente OS eventualmente rimasta impostata.
dotenv.config({ path: path.join(os.homedir(), '.chimera', '.env'), override: true });

// Comandi shell bloccati a prescindere dalla conferma dell'utente: rete di
// sicurezza aggiuntiva contro azioni distruttive o irreversibili.
const FORBIDDEN_SHELL_PATTERNS = [
    /\bdel\b[^\n]*\/f\b[^\n]*\/s\b[^\n]*\/q\b/i,
    /\bdel\b[^\n]*\/s\b[^\n]*\/q\b[^\n]*\/f\b/i,
    /\bformat\s+[a-z]:/i,
    /\brd\b[^\n]*\/s\b[^\n]*\/q\b/i,
    /\brmdir\b[^\n]*\/s\b[^\n]*\/q\b/i,
    /system32/i,
    /\bshutdown\b/i,
    /\bdiskpart\b/i,
];

function isForbiddenShellCommand(cmd) {
    return FORBIDDEN_SHELL_PATTERNS.some(re => re.test(cmd));
}

// Euristica di instradamento (Fase 1, vedi PIANO-SVILUPPO.md): parole chiave
// per categoria concettuale. Una categoria viene suggerita solo se esiste
// davvero un preset con quel nome in config.json, cosi' l'euristica resta
// valida anche se i preset configurati cambiano (es. "creativo" non esiste
// oggi, ma le regole restano pronte per quando verra' aggiunto).
const ROUTING_KEYWORDS = {
    tecnico: [
        /\bbug\b/i, /\bfunzion[ei]\b/i, /\berrore\b/i, /\bdebug/i, /\bcodice\b/i,
        /\beccezione\b/i, /\bcompil/i, /\bstack\s*trace\b/i, /\bapi\b/i,
        /\brefactor/i, /```/,
    ],
    creativo: [
        /\bscrivi\b/i, /\bracconto\b/i, /\bpoesia\b/i, /\bemail\b/i, /\bstoria\b/i,
        /\bslogan\b/i, /\barticolo\b/i, /\bcanzone\b/i,
    ],
    potente: [
        /\bconfronta\b/i, /\bspiega\s+perch[eé]/i, /\bqual\s+[eè]\s+il\s+modo\s+migliore\b/i,
        /\banalizza\b/i, /\bvaluta\b/i, /\bstrategia\b/i, /\bpro\s+e\s+contro\b/i,
        /\bragiona\b/i,
    ],
};

class ChimeraAgent {
    constructor(options = {}) {
        const configPath = path.join(os.homedir(), '.chimera', 'config.json');
        this.configPath = configPath;
        this.config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        this.currentModel = this.config.default_model;

        const apiKey = process.env.CHIMERA_API_KEY || this.config.api_key;
        if (!apiKey) {
            throw new Error(
                'API key non trovata. Imposta la variabile d\'ambiente CHIMERA_API_KEY prima di avviare Chimera.'
            );
        }
        this.apiKey = apiKey;

        this.client = new OpenAI({
            apiKey: this.apiKey,
            baseURL: this.config.base_url
        });

        this.history = [];
        this.maxHistory = this.config.max_context_messages || 8;
        this.healthChecked = false;
        this.failedModels = new Set();
        this.modelErrors = {};

        // Ultimo task completato con successo: usato da !feedback per
        // sapere a quale preset/modello/task associare il giudizio.
        this.lastTask = null;

        // Funzione usata per chiedere conferma manuale prima di eseguire
        // comandi shell o scritture su file. Chi integra l'agente (es.
        // bin/chimera.js) puo' iniettare la propria implementazione per
        // riusare un'interfaccia readline gia' aperta sullo stdin.
        this.confirmFn = options.confirmFn || this.defaultConfirm.bind(this);
    }

    async defaultConfirm(promptText) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        return new Promise(resolve => {
            rl.question(promptText, answer => {
                rl.close();
                resolve(/^y(es)?$/i.test(answer.trim()));
            });
        });
    }

    saveConfig() {
        fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    }

    switchModel(preset) {
        if (this.config.presets[preset]) {
            this.currentModel = this.config.presets[preset].model;
            return `?? Mutato in: ${preset} (${this.config.presets[preset].description})`;
        }
        return `Preset non trovato. Disponibili: ${Object.keys(this.config.presets).join(', ')}`;
    }

    // Fase 1 dell'instradamento (vedi PIANO-SVILUPPO.md): euristica a parole
    // chiave, nessuna chiamata AI. Ritorna il nome di un preset esistente in
    // config.presets, o null se non c'e' un suggerimento chiaro (in quel
    // caso chi chiama deve lasciare il preset attuale invariato).
    suggestPreset(userInput) {
        const direct = this.scoreCategories(userInput);
        if (direct.length > 0) return direct[0][0];

        // Fase 4, punto 3: nessun segnale diretto nel messaggio corrente.
        // Prima di ricadere sul default, guarda se gli ultimi scambi
        // avevano un segnale chiaro (es. "e ora?" dopo un task tecnico
        // resta su tecnico). La cronologia non vince mai su un segnale
        // esplicito nel messaggio attuale: si arriva qui solo se sopra non
        // c'e' stato nessun match.
        const fromHistory = this.suggestFromHistory();
        if (fromHistory) return fromHistory;

        // Ancora nessun segnale: un task breve e diretto va sul preset
        // veloce, se configurato. Altrimenti nessun suggerimento.
        if (userInput.trim().length < 60 && this.config.presets.veloce) {
            return 'veloce';
        }

        return null;
    }

    // Ritorna le categorie con match, ordinate per numero di parole chiave
    // trovate (piu' alto prima). Condivisa tra suggestPreset() e
    // suggestFromHistory() per non duplicare la logica di scoring.
    scoreCategories(text) {
        const scores = {};
        for (const [category, patterns] of Object.entries(ROUTING_KEYWORDS)) {
            if (!this.config.presets[category]) continue;
            const hits = patterns.filter(re => re.test(text)).length;
            if (hits > 0) scores[category] = hits;
        }
        return Object.entries(scores).sort((a, b) => b[1] - a[1]);
    }

    // Guarda gli ultimi `lookback` messaggi utente nella cronologia (dal piu'
    // recente al meno recente) e ritorna la categoria del primo che ha un
    // segnale chiaro. Usata solo come aiuto nei casi ambigui, mai come
    // priorita' sopra il contenuto del messaggio attuale.
    suggestFromHistory(lookback = 3) {
        const recentUserMessages = this.history
            .filter(m => m.role === 'user')
            .slice(-lookback)
            .reverse();

        for (const msg of recentUserMessages) {
            const ranked = this.scoreCategories(msg.content);
            if (ranked.length > 0) return ranked[0][0];
        }

        return null;
    }

    async checkModelHealth(model) {
        try {
            await this.client.chat.completions.create({
                model: model,
                messages: [{ role: 'user', content: 'ping' }],
                max_tokens: 1
            });
            return { alive: true };
        } catch (error) {
            return { alive: false, error: error.message, status: error.status };
        }
    }

    async findAllFreeModels() {
        try {
            const response = await fetch('https://openrouter.ai/api/v1/models', {
                headers: { 'Authorization': `Bearer ${this.apiKey}` }
            });
            const data = await response.json();
            return data.data
                .filter(m => m.pricing?.prompt === '0' && m.pricing?.completion === '0')
                .map(m => ({ id: m.id, name: m.name, description: m.description }));
        } catch { return []; }
    }

    logModelSwap(presetName, oldModel, newModel) {
        try {
            const logDir = path.join(os.homedir(), '.chimera', 'logs');
            if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
            const logPath = path.join(logDir, 'model-swaps.log');
            const line = `${new Date().toISOString()} | preset=${presetName} | old=${oldModel} | new=${newModel}\n`;
            fs.appendFileSync(logPath, line);
        } catch (e) {
            console.log(`?? Impossibile scrivere logs/model-swaps.log: ${e.message}`);
        }
    }

    // Punto 2 della sessione (vedi PIANO-SVILUPPO.md): !feedback +/- in
    // bin/chimera.js chiama questo metodo per registrare se l'ultima
    // risposta e' stata utile. Alimenta la Fase 2 (raffinamento euristiche).
    logQualityFeedback(rating) {
        if (!this.lastTask) {
            return 'Nessun task recente a cui associare il feedback.';
        }
        try {
            const logDir = path.join(os.homedir(), '.chimera', 'logs');
            if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
            const logPath = path.join(logDir, 'quality.jsonl');
            const entry = {
                timestamp: new Date().toISOString(),
                preset: this.lastTask.preset,
                model: this.lastTask.model,
                task: this.lastTask.taskExcerpt,
                rating,
            };
            fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
            return `Feedback (${rating}) registrato per preset "${this.lastTask.preset}".`;
        } catch (e) {
            return `Impossibile scrivere logs/quality.jsonl: ${e.message}`;
        }
    }

    // Punto 3 della sessione: log di errori che impediscono di completare
    // un task (non i semplici alive:false di routine, quelli restano solo
    // in logs/health_*.json). Vive dentro il progetto Chimera stesso
    // (~/.chimera/logs/), MAI dentro %USERPROFILE%\.claude\.
    logChimeraFailure(presetName, model, userInput, errorMessage) {
        try {
            const logDir = path.join(os.homedir(), '.chimera', 'logs');
            if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
            const logPath = path.join(logDir, 'chimera-failures.md');
            const entry = `\n## ${new Date().toISOString()}\n- Preset: ${presetName}\n- Modello: ${model}\n- Task: ${userInput.substring(0, 150)}\n- Errore: ${errorMessage}\n`;
            fs.appendFileSync(logPath, entry);
        } catch (e) {
            console.log(`?? Impossibile scrivere logs/chimera-failures.md: ${e.message}`);
        }
    }

    async healPreset(presetName, deadModel) {
        console.log(`\n?? Auto-guarigione: ${presetName} (${deadModel}) non funziona pi�...`);
        console.log('?? Cerco un modello free alternativo...');

        const freeModels = await this.findAllFreeModels();

        if (freeModels.length === 0) {
            console.log('? Nessun modello free disponibile al momento.');
            return false;
        }

        const usedModels = Object.values(this.config.presets).map(p => p.model);
        const available = freeModels.filter(m =>
            !usedModels.includes(m.id) && !this.failedModels.has(m.id)
        );

        const replacement = available[0] || freeModels[0];
        const oldModel = this.config.presets[presetName].model;

        this.config.presets[presetName].model = replacement.id;
        this.config.presets[presetName].description = replacement.name || replacement.description?.substring(0, 50) || 'Modello sostitutivo';
        this.saveConfig();

        this.currentModel = replacement.id;

        this.logModelSwap(presetName, oldModel, replacement.id);

        console.log(`? Sostituito con: ${replacement.id}`);
        console.log(`   ${replacement.name || replacement.description?.substring(0, 80)}`);

        return true;
    }

    // Fase 4, punto 4: legge logs/quality.jsonl (se esiste) e calcola, per
    // ogni preset con abbastanza feedback, la percentuale di giudizi
    // positivi. Non tocca alive/healPreset in alcun modo: e' solo lettura,
    // pensata per essere unita ai risultati di checkAllModels().
    readQualityStats(minFeedback = 5, positiveThreshold = 0.4) {
        const logPath = path.join(os.homedir(), '.chimera', 'logs', 'quality.jsonl');
        const counts = {};

        if (!fs.existsSync(logPath)) return counts;

        try {
            const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
            for (const line of lines) {
                let entry;
                try { entry = JSON.parse(line); } catch { continue; }
                if (!entry || !entry.preset) continue;
                if (!counts[entry.preset]) counts[entry.preset] = { positive: 0, total: 0 };
                counts[entry.preset].total++;
                if (entry.rating === '+') counts[entry.preset].positive++;
            }
        } catch {
            return {};
        }

        const stats = {};
        for (const [preset, { positive, total }] of Object.entries(counts)) {
            if (total < minFeedback) continue;
            const ratio = positive / total;
            stats[preset] = { total, positive, ratio, lowQuality: ratio < positiveThreshold };
        }
        return stats;
    }

    async checkAllModels() {
        const results = [];
        const deadModels = [];

        for (const [name, preset] of Object.entries(this.config.presets)) {
            const health = await this.checkModelHealth(preset.model);
            results.push({ name, model: preset.model, ...health });

            if (!health.alive) {
                deadModels.push(name);
                this.modelErrors[name] = health.error;

                const healed = await this.healPreset(name, preset.model);
                if (healed) {
                    const newHealth = await this.checkModelHealth(this.config.presets[name].model);
                    const idx = results.findIndex(r => r.name === name);
                    results[idx] = { name, model: this.config.presets[name].model, ...newHealth };

                    if (newHealth.alive) {
                        deadModels.splice(deadModels.indexOf(name), 1);
                    }
                }
            }
        }

        // Segnala i preset vivi ma con feedback di qualita' scarso (Fase 4,
        // punto 4). Solo segnalazione: non tocca deadModels ne' triggera
        // healPreset -- la decisione resta all'utente.
        const qualityStats = this.readQualityStats();
        results.forEach(r => {
            const q = qualityStats[r.name];
            if (r.alive && q) {
                r.qualityWarning = q.lowQuality;
                r.qualityRatio = q.ratio;
                r.qualityFeedbackCount = q.total;
            }
        });

        const logDir = path.join(os.homedir(), '.chimera', 'logs');
        const reportPath = path.join(logDir, `health_${new Date().toISOString().split('T')[0]}.json`);
        fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
        fs.writeFileSync(path.join(logDir, 'last_check.json'), JSON.stringify({ timestamp: Date.now() }));

        return { results, deadModels };
    }

    shouldHealthCheck() {
        const lastCheckPath = path.join(os.homedir(), '.chimera', 'logs', 'last_check.json');
        try {
            const lastCheck = JSON.parse(fs.readFileSync(lastCheckPath, 'utf-8'));
            const hoursSince = (Date.now() - lastCheck.timestamp) / (1000 * 60 * 60);
            return hoursSince > (this.config.health_check_hours || 24);
        } catch { return true; }
    }

    async startupHealthCheck() {
        if (!this.shouldHealthCheck()) return null;
        console.log('?? Verifica modelli...\n');
        const { results, deadModels } = await this.checkAllModels();

        results.forEach(r => {
            const icon = r.alive ? '?' : '?';
            console.log(`  ${icon} ${r.name.padEnd(12)} ${r.model}`);
            if (r.qualityWarning) {
                console.log(chalk.yellow(`     [qualita' scarsa] ${Math.round(r.qualityRatio * 100)}% feedback positivo su ${r.qualityFeedbackCount} valutazioni`));
            }
        });

        if (deadModels.length > 0) {
            console.log(`\n??  ${deadModels.length} modelli riparati automaticamente. Usa !health per dettagli.`);
        } else {
            console.log(`\n? Tutti i modelli sono attivi!`);
        }

        console.log('');
        this.healthChecked = true;
        return { results, deadModels };
    }

    getCurrentPresetName() {
        return Object.entries(this.config.presets).find(([_, info]) => info.model === this.currentModel)?.[0] || 'personalizzato';
    }

    async think(userInput) {
        const systemPrompt = `${this.config.personality}

Sei ${this.config.agent_name}, un agente mutaforma con accesso al terminale.
Modello attuale: ${this.currentModel}
Sistema: Windows (USA COMANDI WINDOWS: dir, type, del, copy, etc. NON usare ls, cat, rm) | Directory: ${process.cwd()}

Puoi proporre azioni reali sul sistema di Gino (comandi shell, lettura/scrittura file, elenco directory) SOLO quando Gino te lo chiede esplicitamente nel messaggio corrente. Non agire di tua iniziativa, non anticipare richieste, non proporre comandi "per essere utile" se non richiesti. Ogni comando shell o scrittura di file che proponi viene comunque mostrato a Gino per una conferma manuale esplicita prima di essere eseguito davvero: se rifiuta, l'azione non avviene.

Usa questi formati SOLO quando Gino chiede esplicitamente di eseguire, leggere, scrivere o elencare qualcosa:
- \`\`\`shell\ncomando\n\`\`\` per eseguire un comando terminale
- \`\`\`read\npercorso\n\`\`\` per leggere un file
- \`\`\`write\npercorso\ncontenuto\n\`\`\` per scrivere/creare un file
- \`\`\`ls\npercorso\n\`\`\` per elencare una directory

Per tutto il resto, rispondi normalmente senza usare blocchi di azione.`;

        const messages = [
            { role: 'system', content: systemPrompt },
            ...this.history.slice(-this.maxHistory),
            { role: 'user', content: userInput }
        ];

        try {
            const response = await this.client.chat.completions.create({
                model: this.currentModel,
                messages: messages,
                temperature: this.config.temperature || 0.7,
                max_tokens: this.config.max_tokens || 2000,
                extra_headers: {
                    'HTTP-Referer': 'http://localhost',
                    'X-Title': 'Chimera Agent'
                }
            });

            let reply = response.choices[0].message.content;

            // Esegue letture/liste automaticamente; shell e write richiedono conferma manuale.
            reply = await this.executeCommands(reply);

            this.history.push(
                { role: 'user', content: userInput },
                { role: 'assistant', content: reply.substring(0, 500) }
            );

            if (this.history.length > this.maxHistory * 2) {
                this.history = this.history.slice(-this.maxHistory * 2);
            }

            this.lastTask = {
                preset: this.getCurrentPresetName(),
                model: this.currentModel,
                taskExcerpt: userInput.substring(0, 100),
            };

            return { reply, model: this.currentModel, tokens: response.usage?.total_tokens || 0 };
        } catch (error) {
            const presetName = this.getCurrentPresetName();

            if (error.status === 429) {
                this.logChimeraFailure(presetName, this.currentModel, userInput, `Rate limit (429): ${error.message}`);
                return { reply: `? Rate limit per ${presetName}. Prova /bilanciato o attendi.`, model: this.currentModel, tokens: 0 };
            }

            if (error.status === 401 || error.status === 404 || error.message.includes('not found') || error.message.includes('disabled')) {
                console.log(chalk.yellow(`\n?? Il modello ${presetName} non funziona. Auto-riparazione...`));
                const healed = await this.healPreset(presetName, this.currentModel);
                if (healed) {
                    console.log(chalk.green('? Modello sostituito!\n'));
                    return this.think(userInput);
                }
            }

            this.logChimeraFailure(presetName, this.currentModel, userInput, error.message);
            return { reply: `? ${error.message}`, model: this.currentModel, tokens: 0 };
        }
    }

    async executeCommands(text) {
        // Comandi shell: richiedono conferma esplicita dell'utente.
        const shellMatches = [...text.matchAll(/```shell\n([\s\S]*?)```/g)];
        for (const m of shellMatches) {
            const cmd = m[1].trim();

            if (isForbiddenShellCommand(cmd)) {
                console.log(chalk.red(`\n?? Comando bloccato dalla whitelist di sicurezza (non eseguibile nemmeno con conferma):\n   ${cmd}`));
                text = text.replace(m[0], m[0] + '\n?? Comando bloccato dalla whitelist di sicurezza (potenzialmente distruttivo).');
                continue;
            }

            console.log(chalk.yellow(`\n?? Il modello vuole eseguire questo comando shell:\n   ${cmd}`));
            const confirmed = await this.confirmFn('Eseguire questo comando? (y/n): ');

            if (!confirmed) {
                console.log(chalk.gray('?? Comando annullato dall\'utente.'));
                text = text.replace(m[0], m[0] + '\n?? Comando annullato dall\'utente.');
                continue;
            }

            try {
                const { stdout, stderr } = await execAsync(cmd, {
                    timeout: 30000, maxBuffer: 5 * 1024 * 1024, cwd: process.cwd()
                });
                text = text.replace(m[0], m[0] + '\n?? ' + (stdout || stderr || '(ok)').trim());
            } catch (e) {
                text = text.replace(m[0], m[0] + '\n? ' + e.message);
            }
        }

        // Scrivi file: richiede conferma esplicita dell'utente.
        const writeMatches = [...text.matchAll(/```write\n([^\n]*)\n([\s\S]*?)```/g)];
        for (const m of writeMatches) {
            const filePath = m[1].trim();
            const content = m[2].trim();
            const preview = content.length > 500 ? content.substring(0, 500) + '\n... (troncato)' : content;

            console.log(chalk.yellow(`\n?? Il modello vuole scrivere questo file:\n   ${filePath}`));
            console.log(chalk.gray(`--- contenuto ---\n${preview}\n-----------------`));
            const confirmed = await this.confirmFn('Scrivere questo file? (y/n): ');

            if (!confirmed) {
                console.log(chalk.gray('?? Scrittura annullata dall\'utente.'));
                text = text.replace(m[0], '?? Scrittura annullata dall\'utente: ' + filePath);
                continue;
            }

            try {
                const dir = path.dirname(filePath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(filePath, content);
                text = text.replace(m[0], '? Creato: ' + filePath);
            } catch (e) {
                text = text.replace(m[0], '? ' + e.message);
            }
        }

        // Leggi file (automatico, sola lettura).
        const readMatches = [...text.matchAll(/```read\n([\s\S]*?)```/g)];
        for (const m of readMatches) {
            const filePath = m[1].trim();
            console.log(chalk.gray(`?? Lettura file: ${filePath}`));
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                text = text.replace(m[0], '?? ' + filePath + ':\n' + content.substring(0, 2000));
            } catch (e) {
                text = text.replace(m[0], '? ' + e.message);
            }
        }

        // Lista directory (automatico, sola lettura).
        const lsMatches = [...text.matchAll(/```ls\n([\s\S]*?)```/g)];
        for (const m of lsMatches) {
            const dir = m[1].trim() || '.';
            console.log(chalk.gray(`?? Elenco directory: ${dir}`));
            try {
                const files = fs.readdirSync(dir, { withFileTypes: true });
                const list = files.map(f => `${f.isDirectory() ? '??' : '??'} ${f.name}`).join('\n');
                text = text.replace(m[0], '?? ' + dir + ':\n' + list);
            } catch (e) {
                text = text.replace(m[0], '? ' + e.message);
            }
        }

        return text;
    }

    clearHistory() { this.history = []; return 'Pulito'; }
}

export default ChimeraAgent;
