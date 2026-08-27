#!/usr/bin/env node

import readline from 'readline';
import chalk from 'chalk';
import ChimeraAgent from '../src/agent.js';

const banner = `
${chalk.green('+--------------------------------------+')}
${chalk.green('🎭')}   ${chalk.bold.white('CHIMERA - Agente Mutaforma')} ${chalk.green('🎭')}
${chalk.green('+--------------------------------------+')}
`;

console.log(banner);

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.green('chimera > ')
});

// Riusa l'interfaccia readline gia' aperta sullo stdin per le conferme di
// esecuzione shell/write, invece di farne aprire una seconda all'agente.
const agent = new ChimeraAgent({
    confirmFn: (promptText) => new Promise(resolve => {
        rl.question(promptText, answer => resolve(/^y(es)?$/i.test(answer.trim())));
    })
});
let totalTokens = 0;

// Diventa true subito dopo una selezione manuale di preset (/comando):
// sopprime il suggerimento di instradamento per il task immediatamente
// successivo, poi si resetta (vedi PIANO-SVILUPPO.md, nota di design).
let justSetPresetManually = false;

agent.startupHealthCheck().then(result => {
    if (result && result.deadModels.length > 0) {
        console.log(chalk.yellow('⚠️  Alcuni modelli non disponibili. Usa !health per dettagli.\n'));
    }
});

console.log(chalk.gray('/veloce | /potente | /creativo | /tecnico | /list | !help | !exit'));
console.log(chalk.gray('-'.repeat(50)));

rl.on('line', async (input) => {
    const trimmed = input.trim();
    if (!trimmed) { rl.prompt(); return; }
    
    if (trimmed.startsWith('/')) {
        const presetName = trimmed.substring(1).toLowerCase();
        
        if (presetName === 'list') {
            console.log(chalk.bold('\n📋 Modelli disponibili:'));
            Object.entries(agent.config.presets).forEach(([name, info]) => {
                const marker = agent.currentModel === info.model ? ' ?' : '';
                console.log(`  /${name.padEnd(12)} ${info.description}${marker}`);
            });
            console.log('');
        } else if (agent.config.presets[presetName]) {
            console.log(chalk.green(agent.switchModel(presetName)));
            console.log(chalk.gray(`   Modello: ${agent.currentModel}`));
            justSetPresetManually = true;
        } else {
            console.log(chalk.red(`Modello non trovato. Usa /list per vedere i disponibili`));
        }
        rl.prompt();
        return;
    }
    
    if (trimmed.startsWith('!')) {
        const [cmd, ...args] = trimmed.split(' ');
        
        switch(cmd) {
            case '!help': {
                // Le descrizioni vengono lette da config.json invece di
                // elencare nomi di modello hardcoded: i modelli cambiano nel
                // tempo per via della rotazione automatica di healPreset(),
                // le descrizioni dei preset restano il riferimento stabile.
                const presetLines = Object.entries(agent.config.presets)
                    .map(([name, info]) => `  /${name.padEnd(12)} - ${info.description}`)
                    .join('\n');

                console.log(`
${chalk.bold('🎭 CHIMERA - COMANDI:')}

${chalk.yellow('Cambio modello:')}
${presetLines}
  /list        - Lista modelli disponibili

${chalk.yellow('Altri comandi:')}
  !help        - Questo aiuto
  !health      - Verifica salute modelli
  !current     - Modello attuale
  !clear       - Pulisci cronologia
  !shell <cmd> - Esegui comando shell
  !feedback +  - L'ultima risposta e' stata utile
  !feedback -  - L'ultima risposta NON e' stata utile
  !exit        - Esci

${chalk.yellow('Instradamento automatico:')}
  Scrivendo un task senza scegliere un preset a mano, Chimera suggerisce
  quello piu' adatto e chiede conferma prima di usarlo (Fase 1, vedi
  PIANO-SVILUPPO.md).
                `);
                break;
            }

            case '!health':
                console.log(chalk.yellow('\n🩺 Verifica disponibilità modelli...\n'));
                const { results, deadModels } = await agent.checkAllModels();
                results.forEach(r => {
                    const icon = r.alive ? '✅' : '❌';
                    console.log(`  ${icon} ${r.name.padEnd(12)} ${r.model}`);
                    if (!r.alive) {
                        console.log(`     ${chalk.red(r.error?.substring(0, 100))}`);
                    } else if (r.qualityWarning) {
                        console.log(`     ${chalk.yellow(`[vivo ma qualita' scarsa] ${Math.round(r.qualityRatio * 100)}% feedback positivo su ${r.qualityFeedbackCount} valutazioni`)}`);
                    }
                });
                if (deadModels.length > 0) {
                    console.log(`\n${chalk.yellow('⚠️  Modelli non disponibili:')} ${deadModels.join(', ')}`);
                    console.log(chalk.yellow('🔍 Cerco alternative gratuite...\n'));
                    const alternatives = await agent.findAllFreeModels();
                    if (alternatives.length > 0) {
                        console.log(chalk.bold('Modelli free disponibili:'));
                        alternatives.slice(0, 10).forEach(alt => {
                            console.log(`  🔹 ${chalk.cyan(alt.id)}`);
                        });
                    }
                } else {
                    console.log(`\n${chalk.green('✅ Tutti i modelli sono attivi!')}`);
                }
                console.log('');
                break;
                
            case '!current':
                console.log(`\n🎭 Attuale: /${agent.getCurrentPresetName()}`);
                console.log(`   Modello: ${agent.currentModel}\n`);
                break;
                
            case '!clear':
                agent.clearHistory();
                console.clear();
                console.log(banner);
                break;
                
            case '!shell':
                const cmdText = args.join(' ');
                if (!cmdText) {
                    console.log(chalk.red('Uso: !shell <comando>'));
                } else {
                    const { exec } = await import('child_process');
                    const { promisify } = await import('util');
                    try {
                        const { stdout, stderr } = await promisify(exec)(cmdText, { timeout: 30000 });
                        console.log(stdout || stderr || '(ok)');
                    } catch (e) {
                        console.log(chalk.red(e.message));
                    }
                }
                break;
                
            case '!feedback': {
                const rating = args[0];
                if (rating !== '+' && rating !== '-') {
                    console.log(chalk.red('Uso: !feedback + oppure !feedback -'));
                } else {
                    console.log(chalk.gray(agent.logQualityFeedback(rating)));
                }
                break;
            }

            case '!exit':
                console.log(chalk.green('\n👋 Chimera si ritira...'));
                console.log(chalk.gray(`Token totali: ${totalTokens.toLocaleString()}`));
                process.exit(0);
                
            default:
                console.log(chalk.red(`Comando sconosciuto: ${cmd}`));
        }
        rl.prompt();
        return;
    }
    
    if (justSetPresetManually) {
        // Scelta manuale appena fatta: ha priorita', il suggerimento non la
        // sovrascrive per questo task. Si consuma qui: dal prossimo task il
        // suggerimento torna a funzionare normalmente.
        justSetPresetManually = false;
    } else {
        const suggested = agent.suggestPreset(trimmed);
        const current = agent.getCurrentPresetName();

        if (suggested && suggested !== current) {
            const answer = await new Promise(resolve => {
                rl.question(
                    chalk.cyan(`Task rilevato come ${suggested} → uso /${suggested}? [invio per confermare, o scrivi un altro preset]: `),
                    a => resolve(a.trim())
                );
            });

            if (answer === '') {
                console.log(chalk.green(agent.switchModel(suggested)));
            } else {
                const chosen = answer.replace(/^\//, '').toLowerCase();
                if (agent.config.presets[chosen]) {
                    console.log(chalk.green(agent.switchModel(chosen)));
                } else {
                    console.log(chalk.gray(`Preset "${answer}" non riconosciuto, resto su /${current}.`));
                }
            }
        }
    }

    process.stdout.write(chalk.gray('Pensando... '));
    
    try {
        const result = await agent.think(trimmed);
        totalTokens += result.tokens;
        console.log('\n' + chalk.gray('-'.repeat(50)));
        console.log(result.reply);
        console.log(chalk.gray('-'.repeat(50)));
        console.log(chalk.gray(`🎭 ${agent.getCurrentPresetName()} | ${result.tokens} token | Totale: ${totalTokens.toLocaleString()}`));
    } catch (error) {
        console.log(chalk.red(`Errore: ${error.message}`));
    }
    
    rl.prompt();
});

rl.on('SIGINT', () => { 
    console.log(chalk.green('\n👋 Ciao Gino!'));
    process.exit(0); 
});

console.log(chalk.gray('Pronto.\n'));
rl.prompt();
