import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

import ts from 'typescript';
import * as vscode from 'vscode';

import type { FindCustomDefinition } from './tsserver-plugin.cts';

const require = createRequire(import.meta.url);
const semanticResolver = require('./tsserver-plugin.cjs') as {
    findCustomDefinition?: FindCustomDefinition;
};

const SUPPORTED_LANGUAGES = new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact']);

const linkDecorationType = vscode.window.createTextEditorDecorationType({
    textDecoration: 'underline',
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

type LiteralCandidate = {
    range: vscode.Range;
    positions: vscode.Position[];
};

type CachedDecoration = {
    key: string;
    option: vscode.DecorationOptions;
};

type DecorationCacheEntry = {
    documentVersion: number;
    decorations: Map<string, CachedDecoration>;
};

type DefinitionLookupOptions = {
    allowExternalFallback?: boolean;
    cancellationToken?: vscode.CancellationToken;
    trace?: DefinitionTrace;
};

type DefinitionTrace = {
    id: number;
    fileName: string;
    origin: string;
    startedAt: number;
};

type ProgramCacheEntry = {
    program: ts.Program;
    expiresAt: number;
};

type StringJumpSettings = {
    hideDeclaration: boolean;
    hideImports: boolean;
};

type TypeScriptExtensionApi = {
    configurePlugin?: (pluginId: string, configuration: Record<string, unknown>) => void;
};

type TypeScriptExtensionExports = {
    getAPI?: (version: number) => TypeScriptExtensionApi | undefined;
};

const TSSERVER_PLUGIN_ID = 'string-jump-tsserver-plugin';
const TYPESCRIPT_EXTENSION_ID = 'vscode.typescript-language-features';

const builtAt = '[TO-REPLACE-WITH-BUILD-TIME]';
const builtAtLong = '[TO-REPLACE-WITH-BUILD-DATE-TIME]';
const testFile = '[TO-REPLACE-TEST-FILE]';
const testFileLine = '[TO-REPLACE-TEST-FILE-LINE]';
const testFileColumn = '[TO-REPLACE-TEST-FILE-COLUMN]';
const testLogFile = '[TO-REPLACE-TEST-LOG-FILE]';
const MAX_DECORATED_LITERALS = 200;
const PROGRAM_CACHE_TTL_MS = 15000;
let nextDefinitionTraceId = 0;
let outputChannel: vscode.OutputChannel | null = null;
let loggingEnabled = true;
const logHistory: string[] = [];
const documentProgramCache = new Map<string, ProgramCacheEntry>();
const externalProgramCache = new Map<string, ProgramCacheEntry>();
let tsServerRestartTriggered = false;
const log = (message: string): void => {
    if (!loggingEnabled) {
        return;
    }

    const msg = `[string-jump v${builtAt}] ${message}`;
    console.log(msg);
    outputChannel?.appendLine(msg);
    logHistory.push(msg);
};

function now(): number {
    return Date.now();
}

function createDefinitionTrace(document: vscode.TextDocument, position: vscode.Position, origin: string): DefinitionTrace {
    return {
        id: ++nextDefinitionTraceId,
        fileName: document.uri.fsPath,
        origin: `${origin}@${position.line + 1}:${position.character + 1}`,
        startedAt: now(),
    };
}

function traceLog(trace: DefinitionTrace | undefined, message: string): void {
    if (!trace) {
        return;
    }

    log(`[lookup ${trace.id}] ${message}`);
}

function isLookupCancelled(token: vscode.CancellationToken | undefined): boolean {
    return token?.isCancellationRequested ?? false;
}

function getCachedProgram(cache: Map<string, ProgramCacheEntry>, cacheKey: string): ts.Program | undefined {
    const entry = cache.get(cacheKey);
    if (!entry) {
        return undefined;
    }

    if (entry.expiresAt <= now()) {
        cache.delete(cacheKey);
        return undefined;
    }

    return entry.program;
}

function setCachedProgram(cache: Map<string, ProgramCacheEntry>, cacheKey: string, program: ts.Program): ts.Program {
    cache.set(cacheKey, {
        program,
        expiresAt: now() + PROGRAM_CACHE_TTL_MS,
    });

    return program;
}

function clearProgramCachesForFile(fileName: string): void {
    const normalizedFileName = normalizeFileName(fileName);

    for (const key of documentProgramCache.keys()) {
        if (key.startsWith(`${normalizedFileName}|`)) {
            documentProgramCache.delete(key);
        }
    }

    for (const key of externalProgramCache.keys()) {
        if (key.includes(`|${normalizedFileName}|`)) {
            externalProgramCache.delete(key);
        }
    }
}

async function runAutoTest(): Promise<void> {
    if (!testFile || !testFileLine || !testFileColumn) {
        return;
    }

    const line = Math.max(parseInt(testFileLine, 10) || 0, 0);
    const column = Math.max(parseInt(testFileColumn, 10) || 0, 0);
    await goToDefinitionAtPosition(vscode.Uri.file(testFile), new vscode.Position(line, column));

    if (testLogFile) {
        const content = logHistory.join('\n');
        log(`writing logs to ${testLogFile}`);
        await vscode.workspace.fs.writeFile(vscode.Uri.file(testLogFile), Buffer.from(content, 'utf-8'));
    }
}

export function activate(context: vscode.ExtensionContext): void {
    loggingEnabled = context.extensionMode !== vscode.ExtensionMode.Test;
    outputChannel = loggingEnabled ? vscode.window.createOutputChannel('String Jump') : null;
    log('extension activated. The extension was built at ' + builtAtLong);
    const enableDecorations = context.extensionMode !== vscode.ExtensionMode.Test;

    const activateDecorator = (): void => {
        if (enableDecorations) {
            context.subscriptions.push(new StringLiteralLinkDecorator(linkDecorationType));
        }
    };

    context.subscriptions.push(linkDecorationType);
    void configureTsServerPlugin({ restartServer: true });
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('string-jump.hide-declaration') || event.affectsConfiguration('string-jump.hide-imports')) {
                void configureTsServerPlugin({ restartServer: true, forceRestart: true });
            }
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('string-jump.goToDefinition', async () => {
            await forceGoToDefinition();
        })
    );
    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(
            [
                { language: 'typescript', scheme: 'file' },
                { language: 'typescriptreact', scheme: 'file' },
                { language: 'javascript', scheme: 'file' },
                { language: 'javascriptreact', scheme: 'file' },
            ],
            {
                provideDefinition(document, position, token) {
                    return provideFallbackDefinition(document, position, token);
                },
            }
        )
    );

    if (testFile) {
        setTimeout(() => {
            void runAutoTest()
                .catch((error) => {
                    log(`auto test failed: ${error instanceof Error ? error.message : String(error)}`);
                })
                .finally(() => {
                    activateDecorator();
                });
        }, 250);
    } else {
        activateDecorator();
    }
}

export function deactivate(): void {}

async function goToDefinitionAtPosition(uri: vscode.Uri, position: vscode.Position): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const targets = await getDefinitionTargetsAtPosition(document, position);

    if (targets.length === 0) {
        const targetFile = `${uri.fsPath}:${position.line + 1}:${position.character + 1}`;
        const shift = 10;
        const widerRange = new vscode.Range(position.translate(0, position.character >= shift ? -shift : 0), position.translate(0, shift + 1));
        const widerText = document.getText(widerRange);
        let text = document.getText(new vscode.Range(position, position.translate(0, 1)));
        if (position.character >= shift) {
            text = text.padStart(shift + text.length, ' ');
        }

        log(`exact jump found no definition target for \n\t\t\ttext: ${text}\n\t\t\twrap: ${widerText}\n\t\t\tfile: ${targetFile}`);
        return;
    }

    if (targets.length > 1) {
        log(`exact jump resolved to ${targets.length} target(s)`);
        await vscode.commands.executeCommand(
            'editor.action.goToLocations',
            editor.document.uri,
            position,
            targets,
            'peek',
            'String Jump: no definition target found at the current cursor position.'
        );
        return;
    }

    const [target] = targets;
    log(`exact jump resolved to ${target.uri.fsPath}:${target.range.start.line + 1}:${target.range.start.character + 1}`);

    const targetEditor = await vscode.window.showTextDocument(target.uri, { preview: false });
    targetEditor.selection = new vscode.Selection(target.range.start, target.range.end);
    targetEditor.revealRange(target.range, vscode.TextEditorRevealType.InCenter);
}

async function forceGoToDefinition(uri?: vscode.Uri, positionOrRange?: vscode.Position | vscode.Range): Promise<void> {
    const activeEditor = vscode.window.activeTextEditor;
    const targetUri = uri ?? activeEditor?.document.uri;

    if (!targetUri) {
        log('force jump aborted: no active editor');
        return;
    }

    let editor = activeEditor;
    if (!editor || editor.document.uri.toString() !== targetUri.toString()) {
        const document = await vscode.workspace.openTextDocument(targetUri);
        editor = await vscode.window.showTextDocument(document, { preview: false });
    }

    const candidatePositions = getCandidatePositions(editor, positionOrRange);
    log(`force jump requested for ${targetUri.fsPath} with ${candidatePositions.length} candidate position(s)`);

    const targets = await findDefinitionTargets(editor.document, candidatePositions);
    if (targets.length === 0) {
        log('force jump found no definition target');
        void vscode.window.showInformationMessage('String Jump: no definition target found at the current cursor position.');
        return;
    }

    if (targets.length > 1) {
        log(`force jump resolved to ${targets.length} target(s)`);
        await vscode.commands.executeCommand(
            'editor.action.goToLocations',
            editor.document.uri,
            editor.selection.active,
            targets,
            'peek',
            'String Jump: no definition target found at the current cursor position.'
        );
        return;
    }

    const [target] = targets;

    log(`force jump resolved to ${target.uri.fsPath}:${target.range.start.line + 1}:${target.range.start.character + 1}`);

    const targetEditor = await vscode.window.showTextDocument(target.uri, { preview: false });
    targetEditor.selection = new vscode.Selection(target.range.start, target.range.end);
    targetEditor.revealRange(target.range, vscode.TextEditorRevealType.InCenter);
}

async function getDefinitionTargetsAtPosition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Location[]> {
    const program = createProgramForDocument(document);
    const customTargets = await provideCustomDefinitionsNearPosition(document, position, program, undefined, { allowExternalFallback: false });
    if (customTargets.length > 0) {
        return filterDefinitionTargets(document, position, customTargets);
    }

    const externalFallbackTargets = await provideExternalCustomDefinitionsNearPosition(document, position);
    if (externalFallbackTargets.length > 0) {
        return filterDefinitionTargets(document, position, externalFallbackTargets);
    }

    const definitions = (await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, position)) as Array<vscode.Location | vscode.LocationLink>;
    const targets = definitions.map(toLocation).filter((location): location is vscode.Location => location !== undefined);
    return filterDefinitionTargets(document, position, dedupeLocations(targets));
}

async function findDefinitionTargets(document: vscode.TextDocument, positions: readonly vscode.Position[]): Promise<vscode.Location[]> {
    for (const position of positions) {
        log(`trying definition lookup at ${document.uri.fsPath}:${position.line + 1}:${position.character + 1}`);
        const targets = await getDefinitionTargetsAtPosition(document, position);
        if (targets.length > 0) {
            return targets;
        }
    }

    return [];
}

function getCandidatePositions(editor: vscode.TextEditor, positionOrRange?: vscode.Position | vscode.Range): vscode.Position[] {
    const positions: vscode.Position[] = [];
    const addPosition = (position: vscode.Position | undefined): void => {
        if (!position) {
            return;
        }

        if (position.line < 0 || position.line >= editor.document.lineCount) {
            return;
        }

        const line = editor.document.lineAt(position.line);
        if (position.character < 0 || position.character > line.text.length) {
            return;
        }

        positions.push(position);
    };

    const addRangeCandidates = (range: vscode.Range | undefined): void => {
        if (!range) {
            return;
        }

        addPosition(range.start);
        addPosition(positionBefore(editor.document, range.end));

        const wordRange = editor.document.getWordRangeAtPosition(range.start, /[A-Za-z0-9_$]+/);
        if (wordRange) {
            addPosition(wordRange.start);
            addPosition(positionBefore(editor.document, wordRange.end));
        }
    };

    if (positionOrRange instanceof vscode.Range) {
        addRangeCandidates(positionOrRange);
    } else {
        addPosition(positionOrRange);
    }

    addRangeCandidates(editor.selection);
    addPosition(editor.selection.active);
    addPosition(positionBefore(editor.document, editor.selection.active.translate(0, 1)));
    addPosition(positionBefore(editor.document, editor.selection.active));

    return dedupePositions(positions);
}

function positionBefore(document: vscode.TextDocument, position: vscode.Position): vscode.Position | undefined {
    if (position.line === 0 && position.character === 0) {
        return undefined;
    }

    const offset = document.offsetAt(position);
    if (offset === 0) {
        return undefined;
    }

    return document.positionAt(offset - 1);
}

function dedupePositions(positions: vscode.Position[]): vscode.Position[] {
    const seen = new Set<string>();
    const unique: vscode.Position[] = [];

    for (const position of positions) {
        const key = `${position.line}:${position.character}`;
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        unique.push(position);
    }

    return unique;
}

class StringLiteralLinkDecorator implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];
    private readonly pendingUpdates = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly updateVersions = new Map<string, number>();
    private readonly decorationCache = new Map<string, DecorationCacheEntry>();

    constructor(private readonly decorationType: vscode.TextEditorDecorationType) {
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                if (editor) {
                    this.scheduleUpdate(editor);
                }
            }),
            vscode.window.onDidChangeVisibleTextEditors((editors) => {
                for (const editor of editors) {
                    this.scheduleUpdate(editor);
                }
            }),
            vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
                this.scheduleUpdate(event.textEditor);
            }),
            vscode.workspace.onDidChangeTextDocument((event) => {
                const key = event.document.uri.toString();
                this.decorationCache.delete(key);
                clearProgramCachesForFile(event.document.uri.fsPath);

                for (const editor of vscode.window.visibleTextEditors) {
                    if (editor.document.uri.toString() === event.document.uri.toString()) {
                        this.scheduleUpdate(editor);
                    }
                }
            }),
            vscode.workspace.onDidOpenTextDocument((document) => {
                clearProgramCachesForFile(document.uri.fsPath);
                const editor = vscode.window.visibleTextEditors.find((candidate) => candidate.document.uri.toString() === document.uri.toString());

                if (editor) {
                    this.scheduleUpdate(editor);
                }
            }),
            vscode.workspace.onDidCloseTextDocument((document) => {
                const key = document.uri.toString();
                const timer = this.pendingUpdates.get(key);
                if (timer) {
                    clearTimeout(timer);
                    this.pendingUpdates.delete(key);
                }

                this.updateVersions.delete(key);
                this.decorationCache.delete(key);
                clearProgramCachesForFile(document.uri.fsPath);
            })
        );

        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            this.scheduleUpdate(activeEditor);
        }
    }

    dispose(): void {
        for (const timer of this.pendingUpdates.values()) {
            clearTimeout(timer);
        }

        this.pendingUpdates.clear();
        this.updateVersions.clear();
        this.decorationCache.clear();
        vscode.window.visibleTextEditors.forEach((editor) => editor.setDecorations(this.decorationType, []));
        this.disposables.forEach((disposable) => disposable.dispose());
    }

    private scheduleUpdate(editor: vscode.TextEditor): void {
        if (!shouldProcessDocument(editor.document)) {
            editor.setDecorations(this.decorationType, []);
            return;
        }

        const key = editor.document.uri.toString();
        const existingTimer = this.pendingUpdates.get(key);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        const version = (this.updateVersions.get(key) ?? 0) + 1;
        this.updateVersions.set(key, version);

        const timer = setTimeout(() => {
            this.pendingUpdates.delete(key);
            void this.updateEditor(editor, key, version);
        }, 80);

        this.pendingUpdates.set(key, timer);
    }

    private async updateEditor(editor: vscode.TextEditor, key: string, version: number): Promise<void> {
        if (!shouldProcessDocument(editor.document)) {
            editor.setDecorations(this.decorationType, []);
            return;
        }

        const cacheEntry = this.getDecorationCacheEntry(editor.document);
        const literals = collectVisibleLiteralCandidates(editor);
        const pendingLiterals = literals.filter((literal) => !cacheEntry.decorations.has(rangeCacheKey(literal.range)));

        if (pendingLiterals.length === 0) {
            editor.setDecorations(
                this.decorationType,
                Array.from(cacheEntry.decorations.values()).map((entry) => entry.option)
            );
            return;
        }

        const program = createProgramForDocument(editor.document);

        for (const literal of pendingLiterals) {
            const targets = await provideCustomDefinitions(editor.document, literal.positions[0], program, { allowExternalFallback: false });
            const decorationTarget = targets.find((target) => !isNodeModulesUri(target.uri));
            if (!decorationTarget) {
                continue;
            }

            if (this.updateVersions.get(key) !== version) {
                return;
            }

            const cacheKey = rangeCacheKey(literal.range);
            cacheEntry.decorations.set(cacheKey, {
                key: cacheKey,
                option: {
                    range: literal.range,
                },
            });
        }

        if (this.updateVersions.get(key) !== version) {
            return;
        }

        editor.setDecorations(
            this.decorationType,
            Array.from(cacheEntry.decorations.values()).map((entry) => entry.option)
        );
    }

    private getDecorationCacheEntry(document: vscode.TextDocument): DecorationCacheEntry {
        const key = document.uri.toString();
        const existing = this.decorationCache.get(key);
        if (existing && existing.documentVersion === document.version) {
            return existing;
        }

        const next: DecorationCacheEntry = {
            documentVersion: document.version,
            decorations: new Map<string, CachedDecoration>(),
        };
        this.decorationCache.set(key, next);
        return next;
    }
}

function shouldProcessDocument(document: vscode.TextDocument): boolean {
    return SUPPORTED_LANGUAGES.has(document.languageId) && document.uri.scheme === 'file';
}

function collectVisibleLiteralCandidates(editor: vscode.TextEditor): LiteralCandidate[] {
    const candidates: LiteralCandidate[] = [];
    const seen = new Set<string>();

    for (const visibleRange of editor.visibleRanges) {
        for (let lineNumber = visibleRange.start.line; lineNumber <= visibleRange.end.line; lineNumber++) {
            const line = editor.document.lineAt(lineNumber);
            let startCharacter = 0;
            let endCharacter = line.text.length;

            if (lineNumber === visibleRange.start.line) {
                startCharacter = visibleRange.start.character;
            }

            if (lineNumber === visibleRange.end.line) {
                endCharacter = visibleRange.end.character;
            }

            const slice = line.text.slice(startCharacter, endCharacter);
            const literalRegex = /(["'])(?:\\.|(?!\1)[^\\\n])*\1/g;
            let match: RegExpExecArray | null;

            while ((match = literalRegex.exec(slice)) !== null) {
                const start = startCharacter + match.index;
                const end = start + match[0].length;
                const range = new vscode.Range(lineNumber, start, lineNumber, end);
                const key = `${lineNumber}:${start}:${end}`;
                if (seen.has(key)) {
                    continue;
                }

                seen.add(key);
                candidates.push({
                    range,
                    positions: [buildLiteralLookupPosition(editor.document, range)],
                });

                if (candidates.length >= MAX_DECORATED_LITERALS) {
                    return candidates;
                }
            }
        }
    }

    return candidates;
}

function buildLiteralLookupPosition(document: vscode.TextDocument, range: vscode.Range): vscode.Position {
    const startOffset = document.offsetAt(range.start);
    const endOffset = document.offsetAt(range.end);

    if (endOffset - startOffset <= 2) {
        return range.start;
    }

    return document.positionAt(startOffset + 1);
}

function getLiteralCandidatePositions(document: vscode.TextDocument, position: vscode.Position): vscode.Position[] {
    const positions = [position, positionBefore(document, position.translate(0, 1)), positionBefore(document, position)];
    const literalRange = findStringLiteralRangeAtPosition(document, position);

    if (literalRange) {
        positions.push(literalRange.start);
        positions.push(buildLiteralLookupPosition(document, literalRange));
        positions.push(positionBefore(document, literalRange.end));
    }

    return dedupePositions(positions.filter((value): value is vscode.Position => value !== undefined));
}

function findStringLiteralRangeAtPosition(document: vscode.TextDocument, position: vscode.Position): vscode.Range | undefined {
    const line = document.lineAt(position.line).text;
    const literalRegex = /(["'])(?:\\.|(?!\1)[^\\\n])*\1/g;
    let match: RegExpExecArray | null;

    while ((match = literalRegex.exec(line)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (position.character < start || position.character >= end) {
            continue;
        }

        return new vscode.Range(position.line, start, position.line, end);
    }

    return undefined;
}

function findDeclarationNameRangeAtPosition(document: vscode.TextDocument, position: vscode.Position): vscode.Range | undefined {
    const line = document.lineAt(position.line).text;
    const character = Math.min(position.character, line.length);
    const leftChar = character > 0 ? line[character - 1] : '';
    const currentChar = character < line.length ? line[character] : '';

    if (!/[A-Za-z0-9_$]/.test(leftChar) && !/[A-Za-z0-9_$]/.test(currentChar)) {
        return undefined;
    }

    const sourceFile = ts.createSourceFile(document.fileName, document.getText(), ts.ScriptTarget.Latest, true, scriptKindFor(document));
    const node = findTsNodeAtOffset(ts, sourceFile, document.offsetAt(position));
    if (!node) {
        return undefined;
    }

    for (let current: ts.Node | undefined = node; current; current = current.parent) {
        if (!ts.isIdentifier(current) && !ts.isPrivateIdentifier(current)) {
            continue;
        }

        const parent = current.parent as (ts.Node & { name?: ts.Node }) | undefined;
        if (!parent || parent.name !== current || !isSupportedReverseDeclarationNode(parent)) {
            continue;
        }

        if (ts.isParameter(parent)) {
            return undefined;
        }

        if (ts.isVariableDeclaration(parent)) {
            const declarationList = parent.parent;
            if (ts.isVariableDeclarationList(declarationList) && (declarationList.flags & ts.NodeFlags.Const) !== 0) {
                return undefined;
            }
        }

        return new vscode.Range(document.positionAt(current.getStart(sourceFile)), document.positionAt(current.getEnd()));
    }

    return undefined;
}

function shouldUseExtensionDefinitionProvider(document: vscode.TextDocument, position: vscode.Position): boolean {
    const candidates = [position, positionBefore(document, position.translate(0, 1)), positionBefore(document, position)];

    for (const candidate of candidates) {
        if (candidate && findStringLiteralRangeAtPosition(document, candidate)) {
            return true;
        }

        if (candidate && findDeclarationNameRangeAtPosition(document, candidate)) {
            return true;
        }
    }

    return false;
}

function isSupportedReverseDeclarationNode(node: ts.Node): node is ts.Declaration & { name: ts.Node } {
    return (
        ts.isBindingElement(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isEnumMember(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isMethodSignature(node) ||
        ts.isModuleDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isPropertyAssignment(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isPropertySignature(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isShorthandPropertyAssignment(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isTypeParameterDeclaration(node) ||
        ts.isVariableDeclaration(node)
    );
}

function rangeCacheKey(range: vscode.Range): string {
    return `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
}

function isNodeModulesUri(uri: vscode.Uri): boolean {
    return uri.fsPath.includes(`${path.sep}node_modules${path.sep}`);
}

function toLocation(result: vscode.Location | vscode.LocationLink): vscode.Location | undefined {
    if (result instanceof vscode.Location) {
        return result;
    }

    if ('targetUri' in result) {
        return new vscode.Location(result.targetUri, result.targetSelectionRange ?? result.targetRange);
    }

    return undefined;
}

async function provideFallbackDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    cancellationToken?: vscode.CancellationToken
): Promise<vscode.Location | vscode.Location[] | undefined> {
    if (!shouldProcessDocument(document)) {
        return undefined;
    }

    if (!shouldUseExtensionDefinitionProvider(document, position)) {
        return undefined;
    }

    if (isLookupCancelled(cancellationToken)) {
        return undefined;
    }

    const trace = createDefinitionTrace(document, position, 'provideDefinition');
    traceLog(trace, `start ${trace.origin} ${trace.fileName}`);

    const programStart = now();
    const program = createProgramForDocument(document, trace);
    traceLog(trace, `createProgramForDocument took ${now() - programStart}ms (${program ? 'ok' : 'none'})`);

    if (isLookupCancelled(cancellationToken)) {
        traceLog(trace, `cancelled after createProgramForDocument in ${now() - trace.startedAt}ms`);
        return undefined;
    }

    const customLookupStart = now();
    const locations = await provideCustomDefinitionsNearPosition(document, position, program, trace, {
        allowExternalFallback: false,
        cancellationToken,
    });
    traceLog(trace, `provideCustomDefinitionsNearPosition took ${now() - customLookupStart}ms and returned ${locations.length} result(s)`);
    if (locations.length === 0) {
        traceLog(trace, `finished with no custom result in ${now() - trace.startedAt}ms`);
        return undefined;
    }

    const filteredLocations = await filterDefinitionTargets(document, position, locations);
    if (filteredLocations.length === 0) {
        traceLog(trace, `finished with no filtered custom result in ${now() - trace.startedAt}ms`);
        return undefined;
    }

    traceLog(trace, `finished with ${filteredLocations.length} filtered result(s) in ${now() - trace.startedAt}ms`);
    return filteredLocations.length === 1 ? filteredLocations[0] : filteredLocations;
}

async function provideCustomDefinitions(
    document: vscode.TextDocument,
    position: vscode.Position,
    program?: ts.Program,
    options: DefinitionLookupOptions = {}
): Promise<vscode.Location[]> {
    const trace = options.trace;
    const cancellationToken = options.cancellationToken;

    if (isLookupCancelled(cancellationToken)) {
        return [];
    }

    const localFallbackStart = now();
    const localFallback = await provideQueryBuilderKeyFallback(document, position, program, trace);
    traceLog(
        trace,
        `provideQueryBuilderKeyFallback at ${position.line + 1}:${position.character + 1} took ${now() - localFallbackStart}ms and returned ${localFallback.length} result(s)`
    );
    if (localFallback.length > 0) {
        return localFallback;
    }

    if (isLookupCancelled(cancellationToken)) {
        return [];
    }

    const allowExternalFallback = options.allowExternalFallback ?? true;

    const resolver = semanticResolver.findCustomDefinition;
    if (!resolver || !program) {
        if (document.isDirty || !allowExternalFallback) {
            return [];
        }

        const diskLocations = await provideCustomDefinitionsFromDisk(document, position, trace);
        if (diskLocations.length > 0 || isLookupCancelled(cancellationToken)) {
            return diskLocations;
        }

        return provideCustomDefinitionsFromProbe(document, position, trace);
    }

    const resolverStart = now();
    const state = resolver(ts, program, document.uri.fsPath, document.offsetAt(position));
    const definitions = state.definitions ?? (state.definition ? [state.definition] : []);
    traceLog(
        trace,
        `semanticResolver.findCustomDefinition at ${position.line + 1}:${position.character + 1} took ${now() - resolverStart}ms and returned ${definitions.length} definition(s)`
    );
    if (definitions.length === 0) {
        if (document.isDirty || !allowExternalFallback) {
            return [];
        }

        if (isLookupCancelled(cancellationToken)) {
            return [];
        }

        const diskLocations = await provideCustomDefinitionsFromDisk(document, position, trace);
        if (diskLocations.length > 0 || isLookupCancelled(cancellationToken)) {
            return diskLocations;
        }

        return provideCustomDefinitionsFromProbe(document, position, trace);
    }

    if (isLookupCancelled(cancellationToken)) {
        return [];
    }

    const locationConversionStart = now();
    const locations = await Promise.all(definitions.map((definition) => definitionInfoToLocation(definition, trace)));
    traceLog(trace, `definitionInfoToLocation conversion took ${now() - locationConversionStart}ms`);
    return dedupeLocations(locations.filter((location): location is vscode.Location => location !== undefined));
}

async function provideQueryBuilderKeyFallback(document: vscode.TextDocument, position: vscode.Position, program?: ts.Program, trace?: DefinitionTrace): Promise<vscode.Location[]> {
    if (!program) {
        return [];
    }

    const sourceFile = program.getSourceFile(document.uri.fsPath);
    if (!sourceFile) {
        return [];
    }

    const offset = document.offsetAt(position);
    const node = findTsNodeAtOffset(ts, sourceFile, offset);
    if (!node || (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node))) {
        return [];
    }

    const callExpression = node.parent;
    if (!callExpression || !ts.isCallExpression(callExpression) || !ts.isPropertyAccessExpression(callExpression.expression)) {
        return [];
    }

    if (callExpression.arguments[0] !== node) {
        return [];
    }

    if (!unwrapQueryBuilderBaseExpression(ts, callExpression.expression.expression)) {
        return [];
    }

    const checker = program.getTypeChecker();
    const baseExpression = unwrapQueryBuilderBaseExpression(ts, callExpression.expression.expression);
    if (!baseExpression) {
        return [];
    }

    const symbol = resolveExpressionSymbolLocal(ts, checker, baseExpression);
    if (!symbol) {
        return [];
    }

    for (const declaration of symbol.declarations ?? []) {
        if (!ts.isClassDeclaration(declaration) && !ts.isClassExpression(declaration)) {
            continue;
        }

        for (const member of declaration.members) {
            if (hasStaticModifierLocal(ts, member)) {
                continue;
            }

            if (getPropertyNameTextLocal(ts, member.name) !== node.text) {
                continue;
            }

            const location = await definitionInfoToLocation(
                {
                    fileName: member.getSourceFile().fileName,
                    textSpan: {
                        start: member.name ? member.name.getStart(member.getSourceFile()) : member.getStart(member.getSourceFile()),
                        length: member.name ? member.name.getWidth(member.getSourceFile()) : member.getWidth(member.getSourceFile()),
                    },
                },
                trace
            );

            return location ? [location] : [];
        }
    }

    return [];
}

async function provideCustomDefinitionsNearPosition(
    document: vscode.TextDocument,
    position: vscode.Position,
    program?: ts.Program,
    trace?: DefinitionTrace,
    options: DefinitionLookupOptions = {}
): Promise<vscode.Location[]> {
    const candidates = getLiteralCandidatePositions(document, position);
    traceLog(trace, `checking ${candidates.length} candidate position(s) around ${position.line + 1}:${position.character + 1}`);

    for (const candidatePosition of candidates) {
        if (isLookupCancelled(options.cancellationToken)) {
            return [];
        }

        const candidateStart = now();
        const locations = await provideCustomDefinitions(document, candidatePosition, program, { ...options, trace });
        traceLog(trace, `candidate ${candidatePosition.line + 1}:${candidatePosition.character + 1} took ${now() - candidateStart}ms and returned ${locations.length} result(s)`);
        if (locations.length > 0) {
            return locations;
        }
    }

    return [];
}

async function provideExternalCustomDefinitionsNearPosition(
    document: vscode.TextDocument,
    position: vscode.Position,
    trace?: DefinitionTrace,
    cancellationToken?: vscode.CancellationToken
): Promise<vscode.Location[]> {
    if (document.isDirty) {
        return [];
    }

    if (isLookupCancelled(cancellationToken)) {
        return [];
    }

    const candidates = getLiteralCandidatePositions(document, position);
    const resolver = semanticResolver.findCustomDefinition;
    if (!resolver) {
        return [];
    }

    traceLog(trace, `running shared external fallback for ${candidates.length} candidate position(s)`);

    const diskProgramStart = now();
    const diskProgram = createProgramForFilePath(document.uri.fsPath, document.languageId);
    traceLog(trace, `shared createProgramForFilePath took ${now() - diskProgramStart}ms (${diskProgram ? 'ok' : 'none'})`);
    if (diskProgram) {
        const diskSourceText = readFileSync(document.uri.fsPath, 'utf-8');
        for (const candidatePosition of candidates) {
            if (isLookupCancelled(cancellationToken)) {
                return [];
            }

            const diskCandidateStart = now();
            const diskLocations = await provideCustomDefinitionsFromExistingProgram(document, candidatePosition, diskProgram, diskSourceText, trace, 'disk');
            traceLog(
                trace,
                `shared disk candidate ${candidatePosition.line + 1}:${candidatePosition.character + 1} took ${now() - diskCandidateStart}ms and returned ${diskLocations.length} result(s)`
            );
            if (diskLocations.length > 0) {
                return diskLocations;
            }
        }
    }

    const probeProgramStart = now();
    const probeProgram = createProgramForProbe(document.uri.fsPath);
    traceLog(trace, `shared createProgramForProbe took ${now() - probeProgramStart}ms (${probeProgram ? 'ok' : 'none'})`);
    if (!probeProgram) {
        return [];
    }

    const probeSourceText = readFileSync(document.uri.fsPath, 'utf-8');
    for (const candidatePosition of candidates) {
        if (isLookupCancelled(cancellationToken)) {
            return [];
        }

        const probeCandidateStart = now();
        const probeLocations = await provideCustomDefinitionsFromExistingProgram(document, candidatePosition, probeProgram, probeSourceText, trace, 'probe');
        traceLog(
            trace,
            `shared probe candidate ${candidatePosition.line + 1}:${candidatePosition.character + 1} took ${now() - probeCandidateStart}ms and returned ${probeLocations.length} result(s)`
        );
        if (probeLocations.length > 0) {
            return probeLocations;
        }
    }

    return [];
}

async function provideCustomDefinitionsFromExistingProgram(
    document: vscode.TextDocument,
    position: vscode.Position,
    program: ts.Program,
    sourceText: string,
    trace: DefinitionTrace | undefined,
    sourceLabel: 'disk' | 'probe'
): Promise<vscode.Location[]> {
    const resolver = semanticResolver.findCustomDefinition;
    if (!resolver) {
        return [];
    }

    const resolverStart = now();
    const state = resolver(ts, program, document.uri.fsPath, offsetAtPositionInText(sourceText, position));
    const definitions = state.definitions ?? (state.definition ? [state.definition] : []);
    traceLog(trace, `${sourceLabel} resolver lookup took ${now() - resolverStart}ms and returned ${definitions.length} definition(s)`);
    if (definitions.length === 0) {
        return [];
    }

    const locationConversionStart = now();
    const locations = await Promise.all(definitions.map((definition) => definitionInfoToLocation(definition, trace)));
    traceLog(trace, `${sourceLabel} definitionInfoToLocation conversion took ${now() - locationConversionStart}ms`);
    return dedupeLocations(locations.filter((location): location is vscode.Location => location !== undefined));
}

async function provideCustomDefinitionsFromDisk(document: vscode.TextDocument, position: vscode.Position, trace?: DefinitionTrace): Promise<vscode.Location[]> {
    const resolver = semanticResolver.findCustomDefinition;

    const programStart = now();
    const program = createProgramForFilePath(document.uri.fsPath, document.languageId);
    traceLog(trace, `createProgramForFilePath took ${now() - programStart}ms (${program ? 'ok' : 'none'})`);
    if (!resolver || !program) {
        return [];
    }

    const sourceText = readFileSync(document.uri.fsPath, 'utf-8');

    const resolverStart = now();
    const state = resolver(ts, program, document.uri.fsPath, offsetAtPositionInText(sourceText, position));
    const definitions = state.definitions ?? (state.definition ? [state.definition] : []);
    traceLog(trace, `disk resolver lookup took ${now() - resolverStart}ms and returned ${definitions.length} definition(s)`);
    if (definitions.length === 0) {
        return [];
    }

    const locationConversionStart = now();
    const locations = await Promise.all(definitions.map((definition) => definitionInfoToLocation(definition, trace)));
    traceLog(trace, `disk definitionInfoToLocation conversion took ${now() - locationConversionStart}ms`);
    return dedupeLocations(locations.filter((location): location is vscode.Location => location !== undefined));
}

async function provideCustomDefinitionsFromProbe(document: vscode.TextDocument, position: vscode.Position, trace?: DefinitionTrace): Promise<vscode.Location[]> {
    const resolver = semanticResolver.findCustomDefinition;

    const programStart = now();
    const program = createProgramForProbe(document.uri.fsPath);
    traceLog(trace, `createProgramForProbe took ${now() - programStart}ms (${program ? 'ok' : 'none'})`);
    if (!resolver || !program) {
        return [];
    }

    const sourceText = readFileSync(document.uri.fsPath, 'utf-8');

    const resolverStart = now();
    const state = resolver(ts, program, document.uri.fsPath, offsetAtPositionInText(sourceText, position));
    const definitions = state.definitions ?? (state.definition ? [state.definition] : []);
    traceLog(trace, `probe resolver lookup took ${now() - resolverStart}ms and returned ${definitions.length} definition(s)`);
    if (definitions.length === 0) {
        return [];
    }

    const locationConversionStart = now();
    const locations = await Promise.all(definitions.map((definition) => definitionInfoToLocation(definition, trace)));
    traceLog(trace, `probe definitionInfoToLocation conversion took ${now() - locationConversionStart}ms`);
    return dedupeLocations(locations.filter((location): location is vscode.Location => location !== undefined));
}

function dedupeLocations(locations: readonly vscode.Location[]): vscode.Location[] {
    const seen = new Set<string>();
    const unique: vscode.Location[] = [];

    for (const location of locations) {
        const key = `${location.uri.toString()}:${location.range.start.line}:${location.range.start.character}:${location.range.end.line}:${location.range.end.character}`;
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        unique.push(location);
    }

    return unique;
}

function findTsNodeAtOffset(tsModule: typeof ts, sourceFile: ts.SourceFile, offset: number): ts.Node | undefined {
    let current: ts.Node | undefined;

    const visit = (node: ts.Node): void => {
        if (offset < node.getFullStart() || offset >= node.getEnd()) {
            return;
        }

        current = node;
        tsModule.forEachChild(node, visit);
    };

    visit(sourceFile);
    return current;
}

function unwrapQueryBuilderBaseExpression(tsModule: typeof ts, expression: ts.Expression): ts.Expression | undefined {
    const target = skipOuterExpressionsLocal(tsModule, expression);
    if (!tsModule.isCallExpression(target)) {
        return undefined;
    }

    const callee = skipOuterExpressionsLocal(tsModule, target.expression);
    if (tsModule.isPropertyAccessExpression(callee) && callee.name.text === 'query') {
        return callee.expression;
    }

    if (tsModule.isPropertyAccessExpression(callee)) {
        return unwrapQueryBuilderBaseExpression(tsModule, callee.expression);
    }

    return undefined;
}

function resolveExpressionSymbolLocal(tsModule: typeof ts, checker: ts.TypeChecker, expression: ts.Expression): ts.Symbol | undefined {
    const target = skipOuterExpressionsLocal(tsModule, expression);
    const expressionType = checker.getTypeAtLocation(target) as ts.Type & { aliasSymbol?: ts.Symbol };
    const apparentType = checker.getApparentType(expressionType);
    const candidateSymbols = [checker.getSymbolAtLocation(target), expressionType.aliasSymbol, expressionType.getSymbol(), apparentType.getSymbol()];

    for (const candidate of candidateSymbols) {
        if (!candidate) {
            continue;
        }

        const symbol = (candidate.flags & tsModule.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(candidate) : candidate;
        if (symbol?.declarations?.length) {
            return symbol;
        }
    }

    return undefined;
}

function skipOuterExpressionsLocal(tsModule: typeof ts, expression: ts.Expression): ts.Expression {
    let current = expression;
    while (tsModule.isParenthesizedExpression(current) || tsModule.isAsExpression(current) || tsModule.isSatisfiesExpression(current) || tsModule.isNonNullExpression(current)) {
        current = current.expression;
    }

    return current;
}

function hasStaticModifierLocal(tsModule: typeof ts, node: ts.Node): boolean {
    return tsModule.canHaveModifiers(node) ? (tsModule.getModifiers(node)?.some((modifier) => modifier.kind === tsModule.SyntaxKind.StaticKeyword) ?? false) : false;
}

function getPropertyNameTextLocal(tsModule: typeof ts, name: ts.PropertyName | ts.PrivateIdentifier | undefined): string | undefined {
    if (!name || tsModule.isPrivateIdentifier(name)) {
        return undefined;
    }

    if (tsModule.isIdentifier(name) || tsModule.isStringLiteral(name) || tsModule.isNumericLiteral(name)) {
        return name.text;
    }

    return undefined;
}

function createProgramForDocument(document: vscode.TextDocument, trace?: DefinitionTrace): ts.Program | undefined {
    const fileName = document.uri.fsPath;
    const normalizedFileName = normalizeFileName(fileName);
    const cacheKey = `${normalizedFileName}|${document.version}|${document.languageId}`;
    const cachedProgram = getCachedProgram(documentProgramCache, cacheKey);
    if (cachedProgram) {
        traceLog(trace, 'createProgramForDocument cache hit');
        return cachedProgram;
    }

    const configPath = ts.findConfigFile(path.dirname(fileName), ts.sys.fileExists);

    let rootNames = [fileName];
    let options: ts.CompilerOptions = {
        strict: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.Node16,
        moduleResolution: ts.ModuleResolutionKind.Node16,
        allowJs: isJavaScriptDocument(document.languageId),
        checkJs: false,
        skipLibCheck: true,
    };

    if (configPath) {
        const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
        if (configFile.error) {
            return undefined;
        }

        const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));

        rootNames = parsedConfig.fileNames.includes(fileName) ? parsedConfig.fileNames : [...parsedConfig.fileNames, fileName];
        options = {
            ...parsedConfig.options,
            allowJs: parsedConfig.options.allowJs ?? isJavaScriptDocument(document.languageId),
        };
    }

    const host = ts.createCompilerHost(options, true);
    const documentText = document.getText();

    host.fileExists = (candidate) => {
        if (normalizeFileName(candidate) === normalizedFileName) {
            return true;
        }

        return ts.sys.fileExists(candidate);
    };

    host.readFile = (candidate) => {
        if (normalizeFileName(candidate) === normalizedFileName) {
            return documentText;
        }

        return ts.sys.readFile(candidate);
    };

    host.getSourceFile = (candidate, languageVersion, onError) => {
        if (normalizeFileName(candidate) === normalizedFileName) {
            return ts.createSourceFile(candidate, documentText, languageVersion, true, scriptKindFor(document));
        }

        const sourceText = ts.sys.readFile(candidate);
        if (sourceText === undefined) {
            onError?.(`File not found: ${candidate}`);
            return undefined;
        }

        return ts.createSourceFile(candidate, sourceText, languageVersion, true, scriptKindForFileName(candidate));
    };

    return setCachedProgram(documentProgramCache, cacheKey, ts.createProgram({ rootNames, options, host }));
}

function createProgramForFilePath(fileName: string, languageId?: string, trace?: DefinitionTrace): ts.Program | undefined {
    const normalizedFileName = normalizeFileName(fileName);
    const cacheKey = `disk|${normalizedFileName}|${languageId ?? ''}`;
    const cachedProgram = getCachedProgram(externalProgramCache, cacheKey);
    if (cachedProgram) {
        traceLog(trace, 'createProgramForFilePath cache hit');
        return cachedProgram;
    }

    const configPath = ts.findConfigFile(path.dirname(fileName), ts.sys.fileExists);

    let rootNames = [fileName];
    let options: ts.CompilerOptions = {
        strict: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.Node16,
        moduleResolution: ts.ModuleResolutionKind.Node16,
        allowJs: languageId ? isJavaScriptDocument(languageId) : /\.(?:c?jsx?)$/i.test(fileName),
        checkJs: false,
        skipLibCheck: true,
    };

    if (configPath) {
        const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
        if (configFile.error) {
            return undefined;
        }

        const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));
        rootNames = parsedConfig.fileNames.includes(fileName) ? parsedConfig.fileNames : [...parsedConfig.fileNames, fileName];
        options = {
            ...parsedConfig.options,
            allowJs: parsedConfig.options.allowJs ?? (languageId ? isJavaScriptDocument(languageId) : /\.(?:c?jsx?)$/i.test(fileName)),
        };
    }

    return setCachedProgram(externalProgramCache, cacheKey, ts.createProgram({ rootNames, options }));
}

function createProgramForProbe(fileName: string, trace?: DefinitionTrace): ts.Program | undefined {
    const normalizedFileName = normalizeFileName(fileName);
    const cacheKey = `probe|${normalizedFileName}`;
    const cachedProgram = getCachedProgram(externalProgramCache, cacheKey);
    if (cachedProgram) {
        traceLog(trace, 'createProgramForProbe cache hit');
        return cachedProgram;
    }

    const configPath = ts.findConfigFile(path.dirname(fileName), ts.sys.fileExists);

    let rootNames = [fileName];
    let options: ts.CompilerOptions = {
        strict: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.Node16,
        moduleResolution: ts.ModuleResolutionKind.Node16,
        skipLibCheck: true,
    };

    if (configPath) {
        const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
        if (configFile.error) {
            return undefined;
        }

        const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));
        rootNames = parsedConfig.fileNames.includes(fileName) ? parsedConfig.fileNames : [...parsedConfig.fileNames, fileName];
        options = parsedConfig.options;
    }

    return setCachedProgram(externalProgramCache, cacheKey, ts.createProgram({ rootNames, options }));
}

function isJavaScriptDocument(languageId: string): boolean {
    return languageId === 'javascript' || languageId === 'javascriptreact';
}

function scriptKindFor(document: vscode.TextDocument): ts.ScriptKind {
    switch (document.languageId) {
        case 'javascript':
            return ts.ScriptKind.JS;
        case 'javascriptreact':
            return ts.ScriptKind.JSX;
        case 'typescriptreact':
            return ts.ScriptKind.TSX;
        default:
            return ts.ScriptKind.TS;
    }
}

function scriptKindForFileName(fileName: string): ts.ScriptKind {
    const extension = path.extname(fileName).toLowerCase();

    switch (extension) {
        case '.js':
        case '.cjs':
            return ts.ScriptKind.JS;
        case '.jsx':
            return ts.ScriptKind.JSX;
        case '.tsx':
            return ts.ScriptKind.TSX;
        case '.json':
            return ts.ScriptKind.JSON;
        default:
            return ts.ScriptKind.TS;
    }
}

function normalizeFileName(fileName: string): string {
    return ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase();
}

function getStringJumpSettings(): StringJumpSettings {
    const configuration = vscode.workspace.getConfiguration('string-jump');
    return {
        hideDeclaration: configuration.get<boolean>('hide-declaration', true),
        hideImports: configuration.get<boolean>('hide-imports', true),
    };
}

async function configureTsServerPlugin(options: { restartServer?: boolean; forceRestart?: boolean } = {}): Promise<void> {
    try {
        const settings = getStringJumpSettings();
        const extension = vscode.extensions.getExtension<TypeScriptExtensionExports>(TYPESCRIPT_EXTENSION_ID);
        if (!extension) {
            log(`failed to configure TypeScript plugin: extension '${TYPESCRIPT_EXTENSION_ID}' not found`);
            return;
        }

        const exports = extension.isActive ? extension.exports : await extension.activate();
        const api = exports?.getAPI?.(0);
        if (!api?.configurePlugin) {
            log('failed to configure TypeScript plugin: TypeScript extension API does not expose configurePlugin');
            return;
        }

        api.configurePlugin(TSSERVER_PLUGIN_ID, {
            hideDeclaration: settings.hideDeclaration,
            hideImports: settings.hideImports,
        });
        log(`configured TypeScript plugin ${TSSERVER_PLUGIN_ID} with hideDeclaration=${settings.hideDeclaration} hideImports=${settings.hideImports}`);

        if (options.restartServer && (options.forceRestart || !tsServerRestartTriggered)) {
            await vscode.commands.executeCommand('typescript.restartTsServer');
            tsServerRestartTriggered = true;
            log('restarted TypeScript server to apply String Jump plugin changes');
        }
    } catch (error) {
        log(`failed to configure TypeScript plugin: ${error instanceof Error ? error.message : String(error)}`);
    }
}

async function filterDefinitionTargets(document: vscode.TextDocument, position: vscode.Position, targets: readonly vscode.Location[]): Promise<vscode.Location[]> {
    const settings = getStringJumpSettings();
    const filtered: vscode.Location[] = [];

    for (const target of targets) {
        if (settings.hideDeclaration && isDeclarationTargetAtPosition(document, position, target)) {
            continue;
        }

        if (settings.hideImports && (await isImportLocation(target))) {
            continue;
        }

        filtered.push(target);
    }

    return filtered;
}

function isDeclarationTargetAtPosition(document: vscode.TextDocument, position: vscode.Position, target: vscode.Location): boolean {
    return document.uri.toString() === target.uri.toString() && target.range.contains(position);
}

async function isImportLocation(location: vscode.Location): Promise<boolean> {
    try {
        const document = await vscode.workspace.openTextDocument(location.uri);
        const sourceFile = ts.createSourceFile(document.fileName, document.getText(), ts.ScriptTarget.Latest, true, scriptKindFor(document));
        const node = findTsNodeAtOffset(ts, sourceFile, document.offsetAt(location.range.start));
        if (!node) {
            return false;
        }

        for (let current: ts.Node | undefined = node; current; current = current.parent) {
            if (
                ts.isImportDeclaration(current) ||
                ts.isImportClause(current) ||
                ts.isImportSpecifier(current) ||
                ts.isNamespaceImport(current) ||
                ts.isNamespaceExport(current) ||
                ts.isImportEqualsDeclaration(current)
            ) {
                return true;
            }
        }

        return false;
    } catch {
        return false;
    }
}

async function definitionInfoToLocation(
    definition: { fileName: string; textSpan: { start: number; length: number } },
    trace?: DefinitionTrace
): Promise<vscode.Location | undefined> {
    const targetLabel = `${path.basename(definition.fileName)}:${definition.textSpan.start}:${definition.textSpan.length}`;
    const totalStart = now();

    try {
        const openStart = now();
        const uri = vscode.Uri.file(definition.fileName);
        const document = await vscode.workspace.openTextDocument(uri);
        const openDuration = now() - openStart;

        const rangeStart = now();
        const start = document.positionAt(definition.textSpan.start);
        const end = document.positionAt(definition.textSpan.start + definition.textSpan.length);
        const rangeDuration = now() - rangeStart;

        const totalDuration = now() - totalStart;
        if (totalDuration >= 50 || openDuration >= 50 || rangeDuration >= 50) {
            traceLog(trace, `definitionInfoToLocation ${targetLabel} openTextDocument=${openDuration}ms positionAt=${rangeDuration}ms total=${totalDuration}ms`);
        }

        return new vscode.Location(uri, new vscode.Range(start, end));
    } catch {
        try {
            const readStart = now();
            const text = readFileSync(definition.fileName, 'utf-8');
            const readDuration = now() - readStart;

            const rangeStart = now();
            const start = positionAtOffsetInText(text, definition.textSpan.start);
            const end = positionAtOffsetInText(text, definition.textSpan.start + definition.textSpan.length);
            const rangeDuration = now() - rangeStart;

            const totalDuration = now() - totalStart;
            if (totalDuration >= 50 || readDuration >= 50 || rangeDuration >= 50) {
                traceLog(trace, `definitionInfoToLocation fallback ${targetLabel} readFile=${readDuration}ms positionAt=${rangeDuration}ms total=${totalDuration}ms`);
            }

            return new vscode.Location(vscode.Uri.file(definition.fileName), new vscode.Range(start, end));
        } catch {
            traceLog(trace, `definitionInfoToLocation failed for ${targetLabel} after ${now() - totalStart}ms`);
            return undefined;
        }
    }
}

function positionAtOffsetInText(text: string, offset: number): vscode.Position {
    const boundedOffset = Math.max(0, Math.min(offset, text.length));
    let line = 0;
    let lineStart = 0;

    for (let index = 0; index < boundedOffset; index += 1) {
        if (text.charCodeAt(index) === 10) {
            line += 1;
            lineStart = index + 1;
        }
    }

    return new vscode.Position(line, boundedOffset - lineStart);
}

function offsetAtPositionInText(text: string, position: vscode.Position): number {
    const lines = text.split('\n');
    let offset = 0;

    for (let index = 0; index < position.line; index += 1) {
        offset += (lines[index] ?? '').length + 1;
    }

    return offset + position.character;
}
