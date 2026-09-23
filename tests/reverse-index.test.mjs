// The reverse lookup (a declaration name -> the literals that refer to it) must survive edits: unchanged
// files keep their indexed references, so asking again after an edit cannot cost a whole-program walk.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';

import { resolveIdentifier, ts } from './program.mjs';

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'string-jump-index-'));
const modelsFile = path.join(projectRoot, 'models.ts');
const controllersFile = path.join(projectRoot, 'controllers.ts');
const modelCount = 200;
const declarationLine = 14;

// The lookup goes through a query-builder call, the shape the resolver supports for column references.
const modelsSource = (indent) =>
    [
        'export class ModelQueryBuilderContract {',
        '    where(column: string, value: unknown): this {',
        '        void column;',
        '        void value;',
        '        return this;',
        '    }',
        '}',
        '',
        'export class Model {',
        indent + 'static query(): ModelQueryBuilderContract {',
        indent + '    return new ModelQueryBuilderContract();',
        indent + '}',
        '',
        indent + 'declare key_0: number;',
        '}',
        '',
    ].join('\n');

const controllersSource = [
    "import { Model } from './models';",
    '',
    ...Array.from({ length: modelCount }, (_, index) => `export const value${index} = Model.query().where('key_0', ${index});`),
    '',
].join('\n');

/** A program over the generated project, optionally serving different text for one file. */
function buildProgram({ textOverrides = {}, oldProgram } = {}) {
    const options = { strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true };
    const host = ts.createCompilerHost(options, true);
    const baseGetSourceFile = host.getSourceFile.bind(host);
    const previousFiles = new Map((oldProgram?.getSourceFiles() ?? []).map((sourceFile) => [sourceFile.fileName, sourceFile]));
    const baseReadFile = host.readFile.bind(host);
    host.readFile = (fileName) => textOverrides[fileName] ?? baseReadFile(fileName);
    host.getSourceFile = (fileName, languageVersion, onError) => {
        const override = textOverrides[fileName];
        if (override !== undefined) {
            return ts.createSourceFile(fileName, override, languageVersion, true);
        }

        // Incremental hosts hand back the file they already have when it did not change.
        const previous = previousFiles.get(fileName);
        if (previous && !previous.redirectInfo && !previous.isDeclarationFile) {
            return previous;
        }

        return baseGetSourceFile(fileName, languageVersion, onError);
    };

    const program = ts.createProgram({ rootNames: [modelsFile, controllersFile], options, host, oldProgram });
    program.getTypeChecker();
    return program;
}

/** The declaration's current line, so a test can move it around without moving the lookup. */
function referencesOfKey(program) {
    const sourceFile = program.getSourceFile(modelsFile);
    const line = sourceFile.text.slice(0, sourceFile.text.indexOf('key_0')).split('\n').length;
    return resolveIdentifier(program, modelsFile, line, 'key_0').targets.map((target) => `${target.relativeFileName}:${target.line}`);
}

before(() => {
    fs.writeFileSync(modelsFile, modelsSource('    '));
    fs.writeFileSync(controllersFile, controllersSource);
});

after(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('the reverse lookup finds every literal, then stays fast after an edit', () => {
    const program = buildProgram();
    const startedCold = performance.now();
    const cold = referencesOfKey(program);
    const coldMs = performance.now() - startedCold;

    assert.equal(cold.length, modelCount, 'every controller literal should be a reference');
    assert.ok(coldMs > 0);

    // An edit somewhere else: the unchanged files keep their index, so this must not re-walk the project.
    const edited = buildProgram({
        oldProgram: program,
        textOverrides: { [controllersFile]: `// an edit\n${controllersSource}` },
    });
    const startedAfterEdit = performance.now();
    const afterEdit = referencesOfKey(edited);
    const afterEditMs = performance.now() - startedAfterEdit;

    assert.equal(afterEdit.length, modelCount);
    assert.ok(afterEditMs < coldMs / 3 || afterEditMs < 250, `a lookup after an edit should reuse the index (cold ${coldMs.toFixed(0)}ms, after edit ${afterEditMs.toFixed(0)}ms)`);
});

test('an edit that moves the declaration still finds the references', () => {
    const program = buildProgram();
    const before = referencesOfKey(program);

    // Inserting a line shifts the declaration, so its position-based identity changes.
    const moved = buildProgram({
        oldProgram: program,
        textOverrides: { [modelsFile]: modelsSource('    ').replace('export class Model {', '// a comment\nexport class Model {') },
    });
    assert.deepEqual(referencesOfKey(moved), before, 'references must not depend on the declaration staying put');
});

test('a new reference is picked up right after the edit that adds it', () => {
    const program = buildProgram();
    const before = referencesOfKey(program).length;

    const withReference = buildProgram({
        oldProgram: program,
        textOverrides: { [controllersFile]: `${controllersSource}export const extra = Model.query().where('key_0', 999);\n` },
    });

    assert.equal(referencesOfKey(withReference).length, before + 1);
});
