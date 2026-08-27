#!/usr/bin/env node

// Test automatico permanente per il fix "limite giornaliero globale sui
// modelli free vs modello morto" — vedi PIANO-SVILUPPO.md, sezione "Bug
// preesistenti risolti". Prima del fix, checkAllModels() interpretava un
// 429 "free-models-per-day" (limite sull'INTERO account OpenRouter, non del
// singolo modello) come un modello morto, chiamava healPreset() per
// sostituirlo, e ripeteva lo stesso errore su ogni preset successivo.
//
// Non e' possibile testare questo scenario con una vera chiamata OpenRouter
// senza consumare rate limit reale: qui si monkey-patcha
// agent.client.chat.completions.create per simulare l'errore 429 esatto
// riportato da OpenRouter, senza rete ne' input interattivo.
//
// Uso: node tests/test-rate-limit-globale.js

import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import ChimeraAgent from '../src/agent.js';

// checkAllModels() scrive sempre in ~/.chimera/logs/health_<data-di-oggi>.json
// e logs/last_check.json (percorso non iniettabile) — anche quando i dati
// sono simulati come qui. Per non sporcare i log reali dell'utente con
// risultati finti, si fa un backup prima di ogni test che chiama
// checkAllModels() e lo si ripristina (o si cancella, se il file non
// esisteva) subito dopo.
const logDir = path.join(os.homedir(), '.chimera', 'logs');
const healthLogPath = path.join(logDir, `health_${new Date().toISOString().split('T')[0]}.json`);
const lastCheckPath = path.join(logDir, 'last_check.json');

function snapshotHealthLogs() {
    const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null);
    return { healthLog: read(healthLogPath), lastCheck: read(lastCheckPath) };
}

function restoreHealthLogs(snapshot) {
    const restore = (p, content) => {
        if (content === null) {
            if (fs.existsSync(p)) fs.unlinkSync(p);
        } else {
            fs.writeFileSync(p, content);
        }
    };
    restore(healthLogPath, snapshot.healthLog);
    restore(lastCheckPath, snapshot.lastCheck);
}

let failures = 0;

function assert(condition, label) {
    if (condition) {
        console.log(chalk.green(`  ✅ ${label}`));
    } else {
        console.log(chalk.red(`  ❌ ${label}`));
        failures++;
    }
}

// Stessa forma dell'errore lanciato dall'SDK OpenAI per una risposta 429 di
// OpenRouter con corpo {"error": {"message": "...free-models-per-day...", "code": 429}}.
function makeGlobalRateLimitError() {
    const err = new Error(
        '429 Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day'
    );
    err.status = 429;
    return err;
}

function makeDeadModelError() {
    const err = new Error('404 The model \'some/model:free\' does not exist or has been disabled');
    err.status = 404;
    return err;
}

async function testGlobalRateLimitSkipsHealPreset() {
    console.log(chalk.cyan('\nCaso 1: rate limit giornaliero globale su TUTTI i preset -> nessuna auto-guarigione'));

    const agent = new ChimeraAgent({
        confirmFn: async () => true,
        confirmWordFn: async () => true,
    });

    // Tutte le chiamate di health check sbattono contro lo stesso limite
    // di account, indipendentemente dal modello interrogato.
    agent.client.chat.completions.create = async () => { throw makeGlobalRateLimitError(); };

    let healPresetCalls = 0;
    agent.healPreset = async (...args) => { healPresetCalls++; return true; };

    const configBefore = JSON.stringify(agent.config.presets);

    const { results, deadModels, rateLimitedModels } = await agent.checkAllModels();

    assert(healPresetCalls === 0, 'healPreset() non e\' mai stato chiamato');
    assert(deadModels.length === 0, 'nessun preset finito in deadModels (non sono "modelli morti")');
    assert(
        rateLimitedModels.length === Object.keys(agent.config.presets).length,
        'tutti i preset finiscono in rateLimitedModels'
    );
    assert(
        results.every(r => r.alive === false && r.globalRateLimit === true),
        'ogni risultato e\' alive:false con globalRateLimit:true'
    );
    assert(JSON.stringify(agent.config.presets) === configBefore, 'config.json (in memoria) non e\' stato riscritto');
}

async function testGlobalRateLimitDetectedMidCycleSkipsRemaining() {
    console.log(chalk.cyan('\nCaso 2: rate limit rilevato sul primo preset -> niente ricerca alternative per i successivi'));

    const agent = new ChimeraAgent({
        confirmFn: async () => true,
        confirmWordFn: async () => true,
    });

    let callCount = 0;
    agent.client.chat.completions.create = async () => {
        callCount++;
        // Il primo preset controllato rivela il limite globale; per
        // qualunque preset successivo, anche se l'errore simulato fosse
        // "diverso", non deve piu' scattare la ricerca di alternative.
        throw callCount === 1 ? makeGlobalRateLimitError() : makeDeadModelError();
    };

    let healPresetCalls = 0;
    agent.healPreset = async (...args) => { healPresetCalls++; return true; };

    const { deadModels, rateLimitedModels } = await agent.checkAllModels();

    assert(healPresetCalls === 0, 'healPreset() non e\' mai stato chiamato dopo il rilevamento del limite globale');
    assert(deadModels.length === 0, 'nessun preset successivo trattato come "modello morto"');
    assert(
        rateLimitedModels.length === Object.keys(agent.config.presets).length,
        'tutti i preset (incluso quello col 404 simulato dopo il rilevamento) finiscono in rateLimitedModels'
    );
}

async function testRealDeadModelStillHealed() {
    console.log(chalk.cyan('\nCaso 3: modello davvero morto (404, nessun rate limit) -> auto-guarigione invariata'));

    const agent = new ChimeraAgent({
        confirmFn: async () => true,
        confirmWordFn: async () => true,
    });

    agent.client.chat.completions.create = async () => { throw makeDeadModelError(); };

    let healPresetCalls = 0;
    agent.healPreset = async (name) => { healPresetCalls++; return false; };

    const { deadModels, rateLimitedModels } = await agent.checkAllModels();

    assert(
        healPresetCalls === Object.keys(agent.config.presets).length,
        'healPreset() e\' stato chiamato per ogni preset morto, come prima del fix'
    );
    assert(rateLimitedModels.length === 0, 'nessun preset finito in rateLimitedModels');
    assert(
        deadModels.length === Object.keys(agent.config.presets).length,
        'tutti i preset restano in deadModels (healPreset mockato per fallire)'
    );
}

function testMessageMentionsAccountWideDailyLimit() {
    console.log(chalk.cyan('\nCaso 4: messaggio mostrato distingue chiaramente il limite di account da un modello morto'));

    const agent = new ChimeraAgent({
        confirmFn: async () => true,
        confirmWordFn: async () => true,
    });

    const msg = agent.formatGlobalRateLimitMessage(['veloce', 'tecnico']);

    assert(msg.includes('veloce') && msg.includes('tecnico'), 'elenca i preset coinvolti');
    assert(/account/i.test(msg), 'menziona che il limite e\' sull\'intero account (non sul singolo modello)');
    assert(/resetta|giorno|giornalier/i.test(msg), 'menziona che il limite si resetta su base giornaliera');
    assert(/credit/i.test(msg), 'menziona l\'opzione di aggiungere credito su OpenRouter');
    assert(!/\d{1,2}:\d{2}/.test(msg), 'non inventa un orario preciso di reset');
}

let healthLogSnapshot = null;

async function main() {
    const snapshot = snapshotHealthLogs();
    healthLogSnapshot = snapshot;
    try {
        await testGlobalRateLimitSkipsHealPreset();
        await testGlobalRateLimitDetectedMidCycleSkipsRemaining();
        await testRealDeadModelStillHealed();
        testMessageMentionsAccountWideDailyLimit();
    } finally {
        restoreHealthLogs(snapshot);
    }

    console.log('');
    if (failures > 0) {
        console.log(chalk.red(`❌ ${failures} verifica/e fallita/e.`));
        process.exit(1);
    } else {
        console.log(chalk.green('✅ Tutte le verifiche superate.'));
        process.exit(0);
    }
}

main().catch(err => {
    console.error(chalk.red('❌ Errore imprevisto nel test:'), err);
    if (healthLogSnapshot) restoreHealthLogs(healthLogSnapshot);
    process.exit(1);
});
