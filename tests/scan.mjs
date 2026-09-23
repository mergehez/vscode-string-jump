#!/usr/bin/env node
// Prints the target the built resolver finds for every string literal in the given files:
//   node tests/scan.mjs <file...> [--forward]
// Handy for checking a real project: literals with no target print "-".
import * as path from 'node:path';

import { createProgram, fixturesRoot, literalsOf, resolveAt, sourceFileOf } from './program.mjs';

const args = process.argv.slice(2);
const forwardOnly = args.includes('--forward');
const files = args.filter((arg) => !arg.startsWith('--')).map((file) => path.resolve(file));

if (files.length === 0) {
    console.error('Usage: node tests/scan.mjs <file...> [--forward]');
    process.exit(1);
}

const program = createProgram(files);
program.getTypeChecker();

let underlined = 0;
let total = 0;

for (const file of files) {
    const sourceFile = sourceFileOf(program, file);

    for (const literal of literalsOf(sourceFile)) {
        const { targets } = resolveAt(program, file, literal.lookupOffset, { reverse: !forwardOnly });
        total += 1;

        if (targets.length === 0) {
            console.log(`${path.relative(process.cwd(), file)}:${literal.line} "${literal.text}" -`);
            continue;
        }

        underlined += 1;
        for (const target of targets) {
            const targetFile = program.getSourceFile(target.fileName);
            console.log(
                `${path.relative(process.cwd(), file)}:${literal.line} "${literal.text}" -> ${path.relative(fixturesRoot, target.fileName)}:${target.line} ${target.name} (${targets.length} target(s))${targetFile ? '' : ' [not in program]'}`
            );
        }
    }
}

console.log(`\n${underlined} of ${total} literal(s) resolved to a target.`);
