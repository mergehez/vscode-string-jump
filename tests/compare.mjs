#!/usr/bin/env node
// Diffs what the resolver answers for every string call argument in a project, between the built plugin
// and an older build:
//   node tests/compare.mjs <oldPlugin.cjs> <projectDir> [--new <path>] [--limit <n>]
// Useful to see the blast radius of a resolver change: "lost" must stay 0.
// Each build is evaluated in its own process - loading two builds in one process returns empty answers.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { projectRoot, ts } from './program.mjs';

const extensions = ['.ts', '.tsx', '.mts', '.cts'];
const defaultPlugin = path.join(projectRoot, 'dist', 'tsserver-plugin.cjs');

/** A program shaped like the extension's: the file's nearest tsconfig, plus every file sharing it. */
function programFor(configPath, files) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) {
        throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
    }

    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
    return ts.createProgram({ rootNames: [...new Set([...parsed.fileNames, ...files])], options: parsed.options });
}

function dump(pluginPath, projectDir) {
    const require = createRequire(path.join(projectRoot, 'package.json'));
    const plugin = require(pluginPath);
    const projectFiles = ts.sys.readDirectory(projectDir, extensions, ['node_modules', 'build'], undefined);
    const groups = new Map();

    for (const file of projectFiles) {
        const configPath = ts.findConfigFile(path.dirname(file), ts.sys.fileExists);
        if (!configPath) {
            continue;
        }

        if (!groups.has(configPath)) {
            groups.set(configPath, []);
        }

        groups.get(configPath).push(file);
    }

    const answers = {};
    for (const [configPath, files] of groups) {
        const program = programFor(configPath, files);
        program.getTypeChecker();

        for (const file of files) {
            const sourceFile = program.getSourceFile(file);
            if (!sourceFile) {
                continue;
            }

            const visit = (node) => {
                const isStringArgument = ts.isStringLiteral(node) && ts.isCallExpression(node.parent) && node.parent.arguments.includes(node);
                if (isStringArgument && node.text.length > 2) {
                    const state = plugin.findCustomDefinition(ts, program, file, node.getStart(sourceFile) + 1, {}) ?? {};
                    const definitions = state.definitions ?? (state.definition ? [state.definition] : []);
                    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
                    const key = `${path.relative(projectDir, file)}:${line}:${node.text}`;
                    answers[key] = definitions.length
                        ? definitions
                              .map((definition) => {
                                  const target = program.getSourceFile(definition.fileName);
                                  const at = target ? target.getLineAndCharacterOfPosition(definition.textSpan.start).line + 1 : '?';
                                  return `${path.relative(projectDir, definition.fileName)}:${at} ${definition.name}`;
                              })
                              .join(' | ')
                        : `${state.mode ?? 'none'}:`;
                }

                ts.forEachChild(node, visit);
            };

            visit(sourceFile);
        }
    }

    return answers;
}

function compare(before, after) {
    const changed = Object.keys(before).filter((key) => after[key] !== undefined && before[key] !== after[key]);
    const lost = changed.filter((key) => after[key].endsWith(':') && !before[key].endsWith(':'));
    const gained = changed.filter((key) => before[key].endsWith(':') && !after[key].endsWith(':'));

    return { changed, lost, gained, retargeted: changed.filter((key) => !lost.includes(key) && !gained.includes(key)) };
}

if (process.env.SJ_COMPARE_MODE === 'dump') {
    writeFileSync(process.env.SJ_COMPARE_OUT, JSON.stringify(dump(process.env.SJ_COMPARE_PLUGIN, process.env.SJ_COMPARE_PROJECT)));
    process.exit(0);
}

const args = process.argv.slice(2);
const flagValue = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const [oldPlugin, projectDir] = args.filter((arg, index) => !arg.startsWith('--') && !(index > 0 && args[index - 1].startsWith('--')));
const newPlugin = flagValue('--new') ?? defaultPlugin;
const limit = Number(flagValue('--limit') ?? 20);

if (!oldPlugin || !projectDir) {
    console.error('Usage: node tests/compare.mjs <oldPlugin.cjs> <projectDir> [--new <path>] [--limit <n>]');
    process.exit(1);
}

const workDir = mkdtempSync(path.join(tmpdir(), 'string-jump-compare-'));
const dumps = {};

for (const [label, pluginPath] of [
    ['before', oldPlugin],
    ['after', newPlugin],
]) {
    const out = path.join(workDir, `${label}.json`);
    const run = spawnSync(process.execPath, ['--max-old-space-size=8192', fileURLToPath(import.meta.url)], {
        env: { ...process.env, SJ_COMPARE_MODE: 'dump', SJ_COMPARE_PLUGIN: path.resolve(pluginPath), SJ_COMPARE_PROJECT: path.resolve(projectDir), SJ_COMPARE_OUT: out },
        stdio: ['ignore', 'inherit', 'inherit'],
    });

    if (run.status !== 0) {
        console.error(`resolver run "${label}" failed with status ${run.status}`);
        process.exit(1);
    }

    dumps[label] = JSON.parse(readFileSync(out, 'utf8'));
}

const before = dumps.before;
const after = dumps.after;
const missing = Object.keys(before).filter((key) => after[key] === undefined);
const result = compare(before, after);

const short = (pluginPath) => path.resolve(pluginPath).split(path.sep).slice(-3).join('/');

console.log(`${short(oldPlugin)}  ->  ${short(newPlugin)}`);
console.log(
    `${Object.keys(before).length} positions, ${result.changed.length} changed (lost: ${result.lost.length}, newly resolved: ${result.gained.length}, retargeted: ${result.retargeted.length})`
);
if (missing.length > 0) {
    console.log(`${missing.length} position(s) only present in the before run: ${missing.slice(0, 3).join(', ')}`);
}

for (const key of result.changed.slice(0, limit)) {
    console.log(`  ${key}\n     before: ${before[key]}\n     after:  ${after[key]}`);
}
