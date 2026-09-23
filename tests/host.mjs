// Runs the real dist/extension.js in Node against the stub `vscode` API, so decoration behaviour can be
// tested without a window: which literals get underlined, what survives edits and interruptions, and what
// happens when the extension host's own program fails.
import * as fs from 'node:fs';
import { createRequire, register } from 'node:module';
import * as path from 'node:path';

import { fixtureFile, projectRoot } from './program.mjs';

register(new URL('./loader.mjs', import.meta.url));

const vscode = await import('./vscode-stub.mjs');
const { Location, Position, Range, Selection, Uri, fireEvent } = vscode;

export { fixtureFile };

// The extension host resolves literals through the same built plugin the TS server uses, so wrapping it
// here is how a test makes the host's own lookups fail or come up empty.
const plugin = createRequire(path.join(projectRoot, 'package.json'))(path.join(projectRoot, 'dist', 'tsserver-plugin.cjs'));
const realFindCustomDefinition = plugin.findCustomDefinition;

const injected = { failLine: 0, blindLine: 0 };

export const state = {
    paints: 0,
    serverQueries: 0,
    localLookups: 0,
};

/** Makes the host's own lookup throw for every literal on `line` (1-based). */
export function failLocalLookupOn(line) {
    injected.failLine = line;
}

/** Makes the host's own lookup return nothing for every literal on `line`, as a stale program would. */
export function blindLocalLookupOn(line) {
    injected.blindLine = line;
}

function lineOfLookup(program, fileName, position) {
    const sourceFile = program?.getSourceFile(fileName);
    return sourceFile ? sourceFile.getLineAndCharacterOfPosition(position).line + 1 : 0;
}

plugin.findCustomDefinition = (tsModule, program, fileName, position, options) => {
    state.localLookups += 1;
    const line = lineOfLookup(program, fileName, position);

    if (injected.failLine && line === injected.failLine) {
        throw new Error(`injected local lookup failure on line ${line}`);
    }

    if (injected.blindLine && line === injected.blindLine) {
        return {};
    }

    return realFindCustomDefinition(tsModule, program, fileName, position, options);
};

export function resetState() {
    state.paints = 0;
    state.serverQueries = 0;
    state.localLookups = 0;
    injected.failLine = 0;
    injected.blindLine = 0;
    vscode.window.outputChannelLines.length = 0;
}

export function outputLines() {
    return [...vscode.window.outputChannelLines];
}

export function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits until an editor has been painted and then stops being repainted: passes are debounced and yield
 * every few milliseconds, so a fixed sleep either races the pass or wastes time.
 */
export async function settle(editor, { quietMs = 150, timeoutMs = 5000 } = {}) {
    const deadline = Date.now() + timeoutMs;

    while (editor.paints === 0 && Date.now() < deadline) {
        await wait(25);
    }

    let lastPaints = editor.paints;
    let quietSince = Date.now();

    while (Date.now() < deadline) {
        if (editor.paints !== lastPaints) {
            lastPaints = editor.paints;
            quietSince = Date.now();
        } else if (Date.now() - quietSince >= quietMs) {
            return;
        }

        await wait(25);
    }
}

/** A TextDocument stand-in with real line/offset maths and a version the extension can cache against. */
export function createDocument(filePath, { languageId = 'typescript', text, scheme = 'file', version = 1 } = {}) {
    const lines = (text ?? fs.readFileSync(filePath, 'utf-8')).split('\n');
    const fileName = filePath;

    const document = {
        uri: new Uri(filePath, scheme),
        fileName,
        languageId,
        version,
        isDirty: false,
        lineCount: lines.length,
        getText: () => lines.join('\n'),
        lineAt: (line) => ({
            text: lines[line] ?? '',
            range: new Range(new Position(line, 0), new Position(line, (lines[line] ?? '').length)),
        }),
        offsetAt: (position) => {
            let offset = 0;
            for (let index = 0; index < position.line; index += 1) {
                offset += (lines[index] ?? '').length + 1;
            }
            return offset + position.character;
        },
        positionAt: (offset) => {
            let remaining = offset;
            for (let line = 0; line < lines.length; line += 1) {
                const length = lines[line].length + 1;
                if (remaining < length) {
                    return new Position(line, remaining);
                }
                remaining -= length;
            }
            return new Position(lines.length - 1, 0);
        },
        getWordRangeAtPosition: () => undefined,
        /** Simulates typing: new text plus the version bump VS Code does. */
        appendText(extra) {
            lines.push(extra);
            document.version += 1;
            document.lineCount = lines.length;
        },
    };

    return document;
}

/** An editor showing `document` around `line`, recording every setDecorations call on itself. */
export function createEditor(document, { line = 1, span = 12 } = {}) {
    const editor = {
        document,
        decorations: [],
        paints: 0,
        selection: new Selection(new Position(line - 1, 0), new Position(line - 1, 0)),
        visibleRanges: [new Range(new Position(Math.max(line - span, 0), 0), new Position(line + span, 0))],
        setDecorations: (type, options) => {
            state.paints += 1;
            editor.paints += 1;
            editor.decorations = options.map((option) => ({
                line: option.range.start.line + 1,
                start: option.range.start.character,
                text: document.lineAt(option.range.start.line).text.slice(option.range.start.character, option.range.end.character),
            }));
        },
        revealRange: () => {},
    };

    return editor;
}

let activated;

/** Activates the built extension once; later calls only re-point the stub window at `editor`. */
export async function activate(editor) {
    vscode.window.activeTextEditor = editor;
    vscode.window.visibleTextEditors = [editor];

    if (!activated) {
        const extension = await import(path.join(projectRoot, 'dist', 'extension.js'));
        activated = Promise.resolve(extension.activate({ subscriptions: [], extensionMode: vscode.ExtensionMode.Production }));
    }

    await activated;
}

export function showEditor(editor) {
    vscode.window.activeTextEditor = editor;
    vscode.window.visibleTextEditors = [editor];
}

export function fireVisibleRange(editor) {
    fireEvent('visibleRanges', { textEditor: editor });
}

export function fireActiveEditor(editor) {
    fireEvent('activeEditor', editor);
}

export function fireTextChange(document) {
    fireEvent('changeTextDocument', { document });
}

/** Which files the workspace glob returns, as VS Code's findFiles would. */
export function setWorkspaceFiles(files) {
    vscode.workspace.findFiles.impl = async () => files.map((file) => Uri.file(file));
}

/** Open documents the extension can see, used for unsaved buffer text. */
export function setOpenDocuments(documents) {
    vscode.workspace.textDocuments = documents;
}

/** Answers `vscode.executeDefinitionProvider` the way the TS server and its plugin would. */
export function setDefinitionServer(query) {
    vscode.commands.executeCommand.impl = async (command, uri, position) => {
        if (command !== 'vscode.executeDefinitionProvider') {
            return undefined;
        }

        state.serverQueries += 1;
        return query(uri, position) ?? [];
    };
}

export function location(filePath, line, character = 1) {
    return new Location(Uri.file(filePath), new Range(new Position(line - 1, character - 1), new Position(line - 1, character)));
}

/** Sorted `line:"text"` labels for what an editor currently shows as underlined. */
export const underlined = (editor) => editor.decorations.map((decoration) => `${decoration.line}:"${decoration.text}"`).sort();
