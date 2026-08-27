#!/usr/bin/env node

// Test automatico permanente per il fix "stato condiviso tra comandi shell
// nello stesso blocco" (cd relativo tra righe successive) — vedi
// PIANO-SVILUPPO.md, sezione "Bug preesistenti risolti". Non dipende da un
// modello AI ne' da input interattivo: costruisce direttamente il testo del
// blocco ```shell``` e chiama executeCommands() di ChimeraAgent, poi
// verifica il risultato sia dal testo di report sia dal filesystem reale.
//
// Copre anche, di riflesso, il fix precedente (falso successo su comandi
// multipli): il Caso 2 verifica che un fallimento a meta' blocco sia
// riportato comando per comando, non mascherato da un esito aggregato.
//
// Uso: node tests/test-shell-multi-comando.js

import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import ChimeraAgent from '../src/agent.js';

const baseDir = path.join(os.tmpdir(), 'chimera-test-shell-multi-' + process.pid);

let failures = 0;

function assert(condition, label) {
    if (condition) {
        console.log(chalk.green(`  ✅ ${label}`));
    } else {
        console.log(chalk.red(`  ❌ ${label}`));
        failures++;
    }
}

// Cerca nel testo di report se `cmd` e' segnato come riuscito (✅) o fallito
// (❌). Il comando compare due volte nel testo (una nel blocco ```shell```
// originale senza emoji, una nella sezione di report con l'emoji davanti):
// cerchiamo quindi specificamente la riga con l'emoji.
function statusOf(output, cmd) {
    const escaped = cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('✅ ' + escaped + '(\\n|$)').test(output)) return 'ok';
    if (new RegExp('❌ ' + escaped + '(\\n|$)').test(output)) return 'fail';
    return null;
}

async function runBlock(agent, cmds) {
    const text = '```shell\n' + cmds.join('\n') + '\n```';
    return agent.executeCommands(text);
}

async function testHappyPath(agent) {
    console.log(chalk.cyan('\nCaso 1: cd relativi tra sottocartelle, tutti validi'));
    const dir = path.join(baseDir, 'happy');
    fs.mkdirSync(dir, { recursive: true });

    const cmds = [
        `cd "${dir}"`,
        'mkdir testA',
        'mkdir testB',
        'mkdir testC',
        'cd testA',
        'type nul > file.txt',
        'cd ..\\testB',
        'type nul > file.txt',
        'cd ..\\testC',
        'type nul > file.txt',
    ];

    const output = await runBlock(agent, cmds);

    for (const c of cmds) {
        assert(statusOf(output, c) === 'ok', `report ✅ per: ${c}`);
    }

    assert(fs.existsSync(path.join(dir, 'testA', 'file.txt')), 'file.txt presente in testA');
    assert(fs.existsSync(path.join(dir, 'testB', 'file.txt')), 'file.txt presente in testB (non in testA)');
    assert(fs.existsSync(path.join(dir, 'testC', 'file.txt')), 'file.txt presente in testC (non in testA/testB)');
}

async function testFailureMidBlock(agent) {
    console.log(chalk.cyan('\nCaso 2: cd verso cartella inesistente a meta\' blocco'));
    const dir = path.join(baseDir, 'fail');
    fs.mkdirSync(dir, { recursive: true });

    const cmds = [
        `cd "${dir}"`,
        'mkdir testA',
        'cd testA',
        'type nul > file.txt',
        'cd ..\\nonexistent',
        'type nul > file2.txt',
    ];

    const output = await runBlock(agent, cmds);

    assert(statusOf(output, `cd "${dir}"`) === 'ok', 'cd iniziale riuscito');
    assert(statusOf(output, 'mkdir testA') === 'ok', 'mkdir testA riuscito');
    assert(statusOf(output, 'cd testA') === 'ok', 'cd testA riuscito');
    assert(statusOf(output, 'type nul > file.txt') === 'ok', 'prima scrittura riuscita');
    assert(statusOf(output, 'cd ..\\nonexistent') === 'fail', 'cd verso cartella inesistente riportato come fallito (non falso successo)');
    assert(statusOf(output, 'type nul > file2.txt') === 'ok', 'seconda scrittura eseguita (nella cwd rimasta valida)');

    // Il cd e' fallito: la cwd resta quella precedente (testA), quindi il
    // secondo file deve trovarsi li' e non nella cartella base ne' in una
    // fantomatica "nonexistent".
    assert(fs.existsSync(path.join(dir, 'testA', 'file.txt')), 'file.txt presente in testA');
    assert(fs.existsSync(path.join(dir, 'testA', 'file2.txt')), 'file2.txt presente in testA (cwd non cambiata dal cd fallito)');
    assert(!fs.existsSync(path.join(dir, 'nonexistent')), 'la cartella "nonexistent" non e\' stata creata');
    assert(!fs.existsSync(path.join(dir, 'file2.txt')), 'file2.txt NON e\' finito nella cartella base');
}

async function main() {
    const agent = new ChimeraAgent({
        confirmFn: async () => true,
        confirmWordFn: async () => true,
    });

    try {
        await testHappyPath(agent);
        await testFailureMidBlock(agent);
    } finally {
        if (fs.existsSync(baseDir)) fs.rmSync(baseDir, { recursive: true, force: true });
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
    if (fs.existsSync(baseDir)) fs.rmSync(baseDir, { recursive: true, force: true });
    process.exit(1);
});
