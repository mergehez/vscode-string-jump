import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('..', import.meta.url));
export const fixturesRoot = path.join(projectRoot, 'tests', 'fixtures');

/** A file inside the shared fixture project. */
export const fixtureFile = (name) => path.join(fixturesRoot, 'project', name);

const require = createRequire(path.join(projectRoot, 'package.json'));

export const ts = require('typescript');

const builtPlugin = require(path.join(projectRoot, 'dist', 'tsserver-plugin.cjs'));

if (typeof builtPlugin.findCustomDefinition !== 'function') {
    throw new Error('dist/tsserver-plugin.cjs does not export findCustomDefinition - run npm run compile first.');
}

export const findCustomDefinition = builtPlugin.findCustomDefinition;

/** Builds a program the way the extension does: through the nearest tsconfig, with defaults as fallback. */
export function createProgram(files) {
    const [first] = files;
    const configPath = ts.findConfigFile(path.dirname(first), ts.sys.fileExists);
    const options = {
        strict: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.Node16,
        moduleResolution: ts.ModuleResolutionKind.Node16,
        skipLibCheck: true,
    };

    if (!configPath) {
        return ts.createProgram({ rootNames: files, options });
    }

    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) {
        throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
    }

    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
    const rootNames = parsed.fileNames.includes(first) ? parsed.fileNames : [...parsed.fileNames, first];
    return ts.createProgram({ rootNames, options: parsed.options });
}

/** Every string literal in a source file, with the offset a lookup should use. */
export function literalsOf(sourceFile) {
    const literals = [];

    const visit = (node) => {
        if (ts.isStringLiteralLike(node)) {
            const start = node.getStart(sourceFile);
            literals.push({
                text: node.text,
                line: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
                start,
                end: node.getEnd(),
                lookupOffset: start + 1 < node.getEnd() ? start + 1 : start,
            });
        }

        ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return literals;
}

/** The literal at `line` whose text is `text`; `occurrence` picks between repeats on one line. */
export function findLiteral(sourceFile, line, text, occurrence = 0) {
    const matches = literalsOf(sourceFile).filter((literal) => literal.line === line && literal.text === text);
    if (!matches[occurrence]) {
        throw new Error(`Expected at least ${occurrence + 1} "${text}" literal(s) on line ${line} of ${sourceFile.fileName}, found ${matches.length}.`);
    }

    return matches[occurrence];
}

/** The identifier at `line` whose text is `text`, for lookups that start on a declaration name. */
export function findIdentifier(sourceFile, line, text) {
    const matches = [];

    const visit = (node) => {
        if (ts.isIdentifier(node) && node.text === text && sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 === line) {
            matches.push({ start: node.getStart(sourceFile), lookupOffset: node.getStart(sourceFile) + 1 });
        }

        ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    if (matches.length !== 1) {
        throw new Error(`Expected exactly one "${text}" identifier on line ${line} of ${sourceFile.fileName}, found ${matches.length}.`);
    }

    return matches[0];
}

export function sourceFileOf(program, fileName) {
    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) {
        throw new Error(`${fileName} is not part of the program.`);
    }

    return sourceFile;
}

/** Resolves a literal the way the plugin does, and normalises the result to file:line:name. */
export function resolveAt(program, fileName, offset, options = {}) {
    const state = findCustomDefinition(ts, program, fileName, offset, options) ?? {};
    const definitions = state.definitions ?? (state.definition ? [state.definition] : []);

    return {
        mode: state.mode,
        targets: definitions.map((definition) => {
            const targetFile = program.getSourceFile(definition.fileName) ?? sourceFileOf(program, definition.fileName);
            const position = targetFile.getLineAndCharacterOfPosition(definition.textSpan.start);
            return {
                name: definition.name,
                fileName: definition.fileName,
                line: position.line + 1,
                character: position.character + 1,
                relativeFileName: path.relative(fixturesRoot, definition.fileName),
            };
        }),
    };
}

/** Resolves the literal named by line + text, which is how the tests describe positions. */
export function resolveLiteral(program, fileName, line, text, options = {}) {
    const sourceFile = sourceFileOf(program, fileName);
    const literal = findLiteral(sourceFile, line, text, options.occurrence ?? 0);
    return { literal, ...resolveAt(program, fileName, literal.lookupOffset, options) };
}

/** Resolves a declaration name, which is what a user puts the cursor on for the reverse direction. */
export function resolveIdentifier(program, fileName, line, text, options = {}) {
    const sourceFile = sourceFileOf(program, fileName);
    const identifier = findIdentifier(sourceFile, line, text);
    return resolveAt(program, fileName, identifier.lookupOffset, options);
}
