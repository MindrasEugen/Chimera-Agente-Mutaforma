#!/usr/bin/env node

// Fase 2 (vedi PIANO-SVILUPPO.md): report da riga di comando su
// logs/quality.jsonl, alimentato da !feedback +/- dentro Chimera.
// Oggi il file non contiene ancora dati reali: lo script gestisce quel
// caso senza errori, pronto per quando i feedback inizieranno ad arrivare.

import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';

const logPath = path.join(os.homedir(), '.chimera', 'logs', 'quality.jsonl');

if (!fs.existsSync(logPath)) {
    console.log(chalk.yellow('\n📊 Nessun dato ancora: logs/quality.jsonl non esiste.'));
    console.log('Usa !feedback + oppure !feedback - dentro Chimera dopo qualche risposta per iniziare a raccogliere dati.\n');
    process.exit(0);
}

const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
const byPreset = {};
let malformed = 0;

for (const line of lines) {
    let entry;
    try {
        entry = JSON.parse(line);
    } catch {
        malformed++;
        continue;
    }
    if (!entry || !entry.preset || (entry.rating !== '+' && entry.rating !== '-')) {
        malformed++;
        continue;
    }
    if (!byPreset[entry.preset]) byPreset[entry.preset] = { positive: 0, total: 0 };
    byPreset[entry.preset].total++;
    if (entry.rating === '+') byPreset[entry.preset].positive++;
}

console.log(chalk.bold(`\n📊 Report qualità — ${lines.length} righe lette (${malformed} illeggibili ignorate)\n`));

const rows = Object.entries(byPreset).sort((a, b) => b[1].total - a[1].total);

if (rows.length === 0) {
    console.log('Nessun feedback valido trovato.\n');
} else {
    for (const [preset, { positive, total }] of rows) {
        const ratio = Math.round((positive / total) * 100);
        const filledBlocks = Math.round(ratio / 5);
        const bar = '█'.repeat(filledBlocks) + '░'.repeat(20 - filledBlocks);
        const note = total < 5 ? chalk.gray(' (campione piccolo, <5 feedback)') : '';
        console.log(`  ${preset.padEnd(12)} ${bar} ${String(ratio).padStart(3)}%  (${positive}/${total})${note}`);
    }
    console.log('');
}

console.log(chalk.gray(
    'Nota: la rottura per categoria di parola chiave (quale regola di suggestPreset() ha\n' +
    'innescato il suggerimento) non è ancora disponibile — quality.jsonl oggi registra solo\n' +
    'preset/modello/task/esito, non la regola che ha attivato il suggerimento. Vedi\n' +
    'PIANO-SVILUPPO.md, Fase 2, se servisse in futuro.\n'
));
