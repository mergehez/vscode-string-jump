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
    // border: '1px solid',

    border: '1px solid rgb(255 255 255 / 60%)',
    borderWidth: '0px 0px 1px 0px',
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
    /** Literals the server also refused, so a pass does not ask again for the same document version. */
    withoutTarget: Set<string>;
};

type DefinitionLookupOptions = {
    allowExternalFallback?: boolean;
    allowReverse?: boolean;
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
    stamp?: string;
};

type CachedSourceFile = {
    text: string;
    sourceFile: ts.SourceFile;
};

type CachedDocumentSourceFile = {
    version: number;
    sourceFile: ts.SourceFile;
};

type StringJumpSettings = {
    hideDeclaration: boolean;
    hideImports: boolean;
    trace: boolean;
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
// The harness rewrites these placeholders after compiling, so they are only empty at runtime.
const instrumentedBuild = Boolean(testFile);
const MAX_DECORATED_LITERALS = 2000;
const DECORATION_DEBOUNCE_MS = 80;
const DECORATION_YIELD_INTERVAL_MS = 8;
const MAX_DECORATION_SERVER_FALLBACKS = 60;
const PROGRAM_CACHE_TTL_MS = 15000;
const DECORATOR_STARTUP_DELAY_MS = 1200;
const MAX_LOG_HISTORY = 1000;
const MAX_CACHED_SOURCE_FILES = 3000;
const MAX_CACHED_SOURCE_FILE_BYTES = 48 * 1024 * 1024;
const MAX_CACHED_DOCUMENT_SOURCE_FILES = 20;
const MAX_REUSED_PROGRAMS = 3;
const MAX_CACHED_PROGRAMS = 20;
let nextDefinitionTraceId = 0;
let outputChannel: vscode.OutputChannel | null = null;
let loggingEnabled = true;
let traceEnabled = false;
let tsServerPluginConfigured = false;
let delegatingDefinitionLookup = false;
const logHistory: string[] = [];
const documentProgramCache = new Map<string, ProgramCacheEntry>();
const externalProgramCache = new Map<string, ProgramCacheEntry>();
const sourceFileCache = new Map<string, CachedSourceFile>();
const documentSourceFileCache = new Map<string, CachedDocumentSourceFile>();
const previousProgramCache = new Map<string, ts.Program>();
const skippedDocumentReport = new Set<string>();
let cachedSourceFileBytes = 0;
let tsServerRestartTriggered = false;
const log = (message: string): void => {
    if (!loggingEnabled) {
        return;
    }

    const msg = `[string-jump v${builtAt}] ${message}`;
    console.log(msg);
    outputChannel?.appendLine(msg);
    logHistory.push(msg);

    if (logHistory.length > MAX_LOG_HISTORY) {
        logHistory.splice(0, logHistory.length - MAX_LOG_HISTORY);
    }
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
    if (!trace || !traceEnabled) {
        return;
    }

    log(`[lookup ${trace.id}] ${message}`);
}

function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

function isLookupCancelled(token: vscode.CancellationToken | undefined): boolean {
    return token?.isCancellationRequested ?? false;
}

function getCachedProgram(cache: Map<string, ProgramCacheEntry>, cacheKey: string, validateStamp = false): ts.Program | undefined {
    const entry = cache.get(cacheKey);
    if (!entry) {
        return undefined;
    }

    if (entry.expiresAt <= now() || (validateStamp && entry.stamp !== undefined && entry.stamp !== programStamp(entry.program))) {
        cache.delete(cacheKey);
        return undefined;
    }

    return entry.program;
}

function setCachedProgram(cache: Map<string, ProgramCacheEntry>, cacheKey: string, program: ts.Program, stamp?: string): ts.Program {
    cache.delete(cacheKey);
    cache.set(cacheKey, {
        program,
        expiresAt: now() + PROGRAM_CACHE_TTL_MS,
        stamp,
    });

    while (cache.size > MAX_CACHED_PROGRAMS) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey === undefined) {
            break;
        }

        cache.delete(oldestKey);
    }

    return program;
}

// Disk-based programs stay valid only while every file they loaded keeps its timestamp, so a
// save in any imported file invalidates them instead of waiting for the TTL.
function programStamp(program: ts.Program): string {
    let stamp = '';

    for (const sourceFile of program.getSourceFiles()) {
        stamp += `${ts.sys.getModifiedTime?.(sourceFile.fileName)?.getTime() ?? 0}|`;
    }

    return stamp;
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
    // Instrumented builds (the test harness) always trace; otherwise it is opt-in.
    traceEnabled = instrumentedBuild || getStringJumpSettings().trace;
    log('extension activated. The extension was built at ' + builtAtLong);
    const enableDecorations = context.extensionMode !== vscode.ExtensionMode.Test;
    let decoratorStartupTimer: ReturnType<typeof setTimeout> | undefined;

    const activateDecorator = (): void => {
        if (enableDecorations) {
            context.subscriptions.push(new StringLiteralLinkDecorator(linkDecorationType));
        }
    };

    const scheduleDecoratorActivation = (): void => {
        if (!enableDecorations || decoratorStartupTimer) {
            return;
        }

        decoratorStartupTimer = setTimeout(() => {
            decoratorStartupTimer = undefined;
            activateDecorator();
        }, DECORATOR_STARTUP_DELAY_MS);
    };

    context.subscriptions.push(linkDecorationType);
    context.subscriptions.push(
        new vscode.Disposable(() => {
            if (decoratorStartupTimer) {
                clearTimeout(decoratorStartupTimer);
                decoratorStartupTimer = undefined;
            }
        })
    );
    void configureTsServerPlugin();
    context.subscriptions.push(
        vscode.workspace.onDidCreateFiles(() => forgetWorkspaceSourceFiles()),
        vscode.workspace.onDidDeleteFiles(() => forgetWorkspaceSourceFiles()),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('string-jump.trace')) {
                traceEnabled = instrumentedBuild || getStringJumpSettings().trace;
            }

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
                    scheduleDecoratorActivation();
                });
        }, 250);
    } else {
        scheduleDecoratorActivation();
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

    if (candidatePositions.some((position) => isNativeModuleSpecifierPosition(editor.document, position))) {
        log('force jump delegating to native VS Code definition for module specifier');
        await vscode.commands.executeCommand('editor.action.revealDefinition');
        return;
    }

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
    if (isNativeModuleSpecifierPosition(document, position)) {
        const definitions = (await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, position)) as Array<vscode.Location | vscode.LocationLink>;
        const targets = definitions.map(toLocation).filter((location): location is vscode.Location => location !== undefined);
        return dedupeLocations(targets);
    }

    // With the plugin installed the server answers both directions against its own incremental
    // program, so ask it before building a local one.
    if (tsServerPluginConfigured) {
        const serverTargets = await queryServerDefinitionTargets(document, position);
        if (serverTargets.length > 0) {
            return filterDefinitionTargets(document, position, serverTargets);
        }
    }

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

async function queryServerDefinitionTargets(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Location[]> {
    delegatingDefinitionLookup = true;

    try {
        const definitions = (await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, position)) as Array<vscode.Location | vscode.LocationLink>;
        return dedupeLocations(definitions.map(toLocation).filter((location): location is vscode.Location => location !== undefined));
    } catch {
        return [];
    } finally {
        delegatingDefinitionLookup = false;
    }
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
        const version = (this.updateVersions.get(key) ?? 0) + 1;
        this.updateVersions.set(key, version);

        // A pass that is already scheduled is not postponed: it reads the newest version when it fires, so a
        // burst of scroll events cannot keep the decorations away.
        if (this.pendingUpdates.has(key)) {
            return;
        }

        this.pendingUpdates.set(
            key,
            setTimeout(() => {
                this.pendingUpdates.delete(key);
                const latestVersion = this.updateVersions.get(key) ?? version;

                // Editors are looked up now rather than captured: the same document can be open in several
                // editors, and a closed one must not swallow the update for the others.
                for (const candidate of vscode.window.visibleTextEditors) {
                    if (candidate.document.uri.toString() === key) {
                        void this.updateEditor(candidate, key, latestVersion);
                    }
                }
            }, DECORATION_DEBOUNCE_MS)
        );
    }

    private async updateEditor(editor: vscode.TextEditor, key: string, version: number): Promise<void> {
        try {
            await this.runDecorationPass(editor, key, version);
        } catch (error) {
            // A failing pass must still paint what it already knows: an exception here would otherwise
            // leave the whole file without underlines, silently.
            log(`decoration pass failed for ${editor.document.uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`);

            try {
                this.applyDecorations(editor);
            } catch {
                // The editor itself is gone; there is nothing left to paint.
            }
        }
    }

    private applyDecorations(editor: vscode.TextEditor): void {
        const entry = this.decorationCache.get(editor.document.uri.toString());
        if (!entry) {
            editor.setDecorations(this.decorationType, []);
            return;
        }

        // VS Code throws and drops the whole call when one range is out of bounds, so filter first.
        const options = Array.from(entry.decorations.values())
            .map((cached) => cached.option)
            .filter((option) => isValidDecorationRange(editor.document, option.range));
        editor.setDecorations(this.decorationType, options);
    }

    private async runDecorationPass(editor: vscode.TextEditor, key: string, version: number): Promise<void> {
        if (!shouldProcessDocument(editor.document)) {
            editor.setDecorations(this.decorationType, []);
            return;
        }

        const trace = createDefinitionTrace(editor.document, editor.selection.active, 'decorate');
        const cacheEntry = this.getDecorationCacheEntry(editor.document);
        const literals = collectVisibleLiteralCandidates(editor);
        const pendingLiterals = literals.filter((literal) => !cacheEntry.decorations.has(rangeCacheKey(literal.range)));
        traceLog(
            trace,
            `${editor.document.languageId}/${editor.document.uri.scheme} v${editor.document.version}: ${editor.visibleRanges.length} visible range(s), ${literals.length} literal(s), ${pendingLiterals.length} pending`
        );

        if (pendingLiterals.length === 0) {
            this.applyDecorations(editor);
            return;
        }

        const program = createProgramForDocument(editor.document, trace);
        traceLog(trace, `program ${program ? `with ${program.getSourceFiles().length} file(s)` : 'unavailable'}`);
        let underlined = 0;
        let withoutTarget = 0;
        let failed = 0;
        let serverFallbacks = 0;
        let lastYieldAt = now();

        for (const literal of pendingLiterals) {
            if (now() - lastYieldAt >= DECORATION_YIELD_INTERVAL_MS) {
                await yieldToEventLoop();
                lastYieldAt = now();

                if (this.updateVersions.get(key) !== version) {
                    traceLog(trace, `superseded after ${underlined} underline(s)`);
                    this.paintIfDocumentUnchanged(editor, cacheEntry);
                    return;
                }
            }

            let targets: vscode.Location[] = [];
            try {
                targets = await provideCustomDefinitions(editor.document, literal.positions[0], program, {
                    allowExternalFallback: false,
                    allowReverse: false,
                    trace,
                });
            } catch (error) {
                // One unlucky literal must not cost the whole pass its decorations.
                failed += 1;
                log(`decoration lookup failed at ${literal.range.start.line + 1}:${literal.range.start.character + 1}: ${error instanceof Error ? error.message : String(error)}`);
            }

            let decorationTarget = targets.find((target) => !isNodeModulesUri(target.uri));
            if (!decorationTarget) {
                withoutTarget += 1;
                const withinFallbackBudget = serverFallbacks < MAX_DECORATION_SERVER_FALLBACKS;
                if (withinFallbackBudget) {
                    serverFallbacks += 1;
                }

                decorationTarget = await this.findServerDecorationTarget(editor.document, literal, cacheEntry, withinFallbackBudget, trace);

                if (!decorationTarget) {
                    traceLog(
                        trace,
                        `no decoration target for ${literal.range.start.line + 1}:${literal.range.start.character + 1} (${targets.length} result(s), all in node_modules: ${targets.length > 0})`
                    );
                    continue;
                }
            }

            if (this.updateVersions.get(key) !== version) {
                traceLog(trace, `superseded after ${underlined} underline(s)`);
                this.paintIfDocumentUnchanged(editor, cacheEntry);
                return;
            }

            const cacheKey = rangeCacheKey(literal.range);
            cacheEntry.decorations.set(cacheKey, {
                key: cacheKey,
                option: {
                    range: literal.range,
                },
            });
            underlined += 1;
        }

        if (this.updateVersions.get(key) !== version) {
            traceLog(trace, `superseded after ${underlined} underline(s)`);
            this.paintIfDocumentUnchanged(editor, cacheEntry);
            return;
        }

        this.applyDecorations(editor);
        traceLog(trace, `done: ${underlined} underlined (${serverFallbacks} from the server), ${withoutTarget} without target, ${failed} failed`);
    }

    // A superseded pass is not wasted when the text itself did not change: the ranges it computed are still
    // exact, and dropping them is what leaves a scrolled file empty until the user stops moving.
    private paintIfDocumentUnchanged(editor: vscode.TextEditor, entry: DecorationCacheEntry): void {
        if (entry.documentVersion === editor.document.version) {
            this.applyDecorations(editor);
        }
    }

    /**
     * Underlines come from this host's own program while F12 with the plugin installed goes through the
     * server, so the two can disagree. When the local program finds nothing, ask the server - the same
     * query F12 makes - instead of silently leaving the literal without an underline.
     */
    private async findServerDecorationTarget(
        document: vscode.TextDocument,
        literal: LiteralCandidate,
        entry: DecorationCacheEntry,
        allowedByBudget: boolean,
        trace?: DefinitionTrace
    ): Promise<vscode.Location | undefined> {
        const position = literal.positions[0];
        const cacheKey = rangeCacheKey(literal.range);

        if (!tsServerPluginConfigured || !allowedByBudget || entry.withoutTarget.has(cacheKey)) {
            return undefined;
        }

        // Module specifiers resolve natively, which is not what a string link means here.
        if (isNativeModuleSpecifierPosition(document, position)) {
            return undefined;
        }

        const targets = await queryServerDefinitionTargets(document, position);
        const target = targets.find((candidate) => !isNodeModulesUri(candidate.uri));
        if (!target) {
            entry.withoutTarget.add(cacheKey);
            return undefined;
        }

        traceLog(trace, `server resolved ${literal.range.start.line + 1}:${literal.range.start.character + 1} to ${target.uri.fsPath}:${target.range.start.line + 1}`);
        return target;
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
            withoutTarget: new Set<string>(),
        };
        this.decorationCache.set(key, next);
        return next;
    }
}

function shouldProcessDocument(document: vscode.TextDocument): boolean {
    if (SUPPORTED_LANGUAGES.has(document.languageId) && document.uri.scheme === 'file') {
        return true;
    }

    reportSkippedDocument(document);
    return false;
}

// A file the decorator refuses is a silent no-underline, so report each distinct one once.
function reportSkippedDocument(document: vscode.TextDocument): void {
    const key = `${document.uri.toString()}|${document.languageId}|${document.uri.scheme}`;
    if (skippedDocumentReport.has(key)) {
        return;
    }

    skippedDocumentReport.add(key);
    log(`no decorations for ${document.uri.fsPath} (languageId="${document.languageId}", scheme=${document.uri.scheme})`);
}

function isValidDecorationRange(document: vscode.TextDocument, range: vscode.Range): boolean {
    if (range.start.line < 0 || range.end.line >= document.lineCount || range.end.line < range.start.line) {
        return false;
    }

    const endLineText = document.lineAt(range.end.line).text;
    if (range.start.character < 0 || range.end.character > endLineText.length) {
        return false;
    }

    return range.start.line !== range.end.line || range.end.character >= range.start.character;
}

function collectVisibleLiteralCandidates(editor: vscode.TextEditor): LiteralCandidate[] {
    const candidates: LiteralCandidate[] = [];
    const seen = new Set<string>();
    const lastLine = editor.document.lineCount - 1;

    for (const visibleRange of editor.visibleRanges) {
        for (let lineNumber = visibleRange.start.line; lineNumber <= Math.min(visibleRange.end.line, lastLine); lineNumber++) {
            if (lineNumber < 0) {
                continue;
            }

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

    const sourceFile = getDocumentSourceFile(document);
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
        if (candidate && findStringLiteralRangeAtPosition(document, candidate) && !isNativeModuleSpecifierPosition(document, candidate)) {
            return true;
        }

        if (candidate && findDeclarationNameRangeAtPosition(document, candidate)) {
            return true;
        }
    }

    return false;
}

function isNativeModuleSpecifierPosition(document: vscode.TextDocument, position: vscode.Position): boolean {
    const sourceFile = getDocumentSourceFile(document);
    const node = findTsNodeAtOffset(ts, sourceFile, document.offsetAt(position));
    if (!node || (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node))) {
        return false;
    }

    const parent = node.parent;
    if (!parent) {
        return false;
    }

    return (
        (ts.isImportDeclaration(parent) && parent.moduleSpecifier === node) ||
        (ts.isExportDeclaration(parent) && parent.moduleSpecifier === node) ||
        (ts.isExternalModuleReference(parent) && parent.expression === node) ||
        (ts.isCallExpression(parent) && parent.arguments[0] === node && parent.expression.kind === ts.SyntaxKind.ImportKeyword)
    );
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

    if (delegatingDefinitionLookup) {
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
    // The same fallback chain the F12 command uses: a declaration's references are not confined to the
    // project that owns the file, so cmd+click has to look at the workspace too.
    const locations = await provideCustomDefinitions(document, position, program, {
        allowExternalFallback: true,
        cancellationToken,
        trace,
    });
    traceLog(trace, `provideCustomDefinitions took ${now() - customLookupStart}ms and returned ${locations.length} result(s)`);
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
        if (!allowExternalFallback) {
            return [];
        }

        return provideExternalCustomDefinitionsNearPosition(document, position, trace, cancellationToken);
    }

    const resolverStart = now();
    // The reverse search checks the whole local program; when the tsserver plugin is loaded it
    // already answers these queries against the server's own incremental program.
    const state = resolver(ts, program, document.uri.fsPath, document.offsetAt(position), {
        reverse: options.allowReverse !== false && !tsServerPluginConfigured,
    });
    const definitions = state.definitions ?? (state.definition ? [state.definition] : []);
    traceLog(
        trace,
        `semanticResolver.findCustomDefinition at ${position.line + 1}:${position.character + 1} took ${now() - resolverStart}ms and returned ${definitions.length} definition(s)`
    );
    if (definitions.length === 0) {
        if (!allowExternalFallback) {
            return [];
        }

        return provideExternalCustomDefinitionsNearPosition(document, position, trace, cancellationToken);
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
    const resolver = semanticResolver.findCustomDefinition;
    if (!resolver) {
        return [];
    }

    const candidates = getLiteralCandidatePositions(document, position);
    if (candidates.length === 0) {
        return [];
    }

    traceLog(trace, `running shared external fallback for ${candidates.length} candidate position(s)`);

    // Programs read from disk can only be trusted while the buffer matches the file, but the workspace
    // program below is built from the buffers, so a dirty document is not a reason to give up.
    if (!document.isDirty) {
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
        if (probeProgram) {
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
        }
    }

    if (isLookupCancelled(cancellationToken)) {
        return [];
    }

    const workspaceProgramStart = now();
    const workspaceProgram = await createWorkspaceProgram(document, trace);
    traceLog(trace, `shared createWorkspaceProgram took ${now() - workspaceProgramStart}ms (${workspaceProgram ? 'ok' : 'none'})`);
    if (!workspaceProgram) {
        return [];
    }

    const documentText = document.getText();
    for (const candidatePosition of candidates) {
        if (isLookupCancelled(cancellationToken)) {
            return [];
        }

        const workspaceCandidateStart = now();
        const workspaceLocations = await provideCustomDefinitionsFromExistingProgram(document, candidatePosition, workspaceProgram, documentText, trace, 'workspace');
        traceLog(
            trace,
            `shared workspace candidate ${candidatePosition.line + 1}:${candidatePosition.character + 1} took ${now() - workspaceCandidateStart}ms and returned ${workspaceLocations.length} result(s)`
        );
        if (workspaceLocations.length > 0) {
            return workspaceLocations;
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
    sourceLabel: 'disk' | 'probe' | 'workspace'
): Promise<vscode.Location[]> {
    const resolver = semanticResolver.findCustomDefinition;
    if (!resolver) {
        return [];
    }

    const resolverStart = now();
    // The workspace program exists to answer what the server's project cannot see, so it always searches
    // both directions; the narrower programs leave the reverse direction to the plugin when it is loaded.
    const reverse = sourceLabel === 'workspace' ? true : !tsServerPluginConfigured;
    const state = resolver(ts, program, document.uri.fsPath, offsetAtPositionInText(sourceText, position), { reverse });
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

function dedupeLocations(locations: readonly vscode.Location[]): vscode.Location[] {
    const seen = new Set<string>();
    const unique: vscode.Location[] = [];

    for (const location of locations) {
        // Keyed with normalizeFileName so the same target found through two programs - or reported with a
        // different casing - collapses into one entry instead of showing up twice in the peek.
        const key = `${normalizeFileName(location.uri.fsPath)}:${location.range.start.line}:${location.range.start.character}:${location.range.end.line}:${location.range.end.character}`;
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        unique.push(location);
    }

    return unique;
}

function findTsNodeAtOffset(tsModule: typeof ts, sourceFile: ts.SourceFile, offset: number): ts.Node | undefined {
    if (offset < sourceFile.getFullStart() || offset >= sourceFile.getEnd()) {
        return undefined;
    }

    let current: ts.Node = sourceFile;

    while (true) {
        const child = findChildContainingOffset(tsModule, current, offset);
        if (!child) {
            return current;
        }

        current = child;
    }
}

// Sibling ranges never overlap, so descending one level at a time replaces walking every
// descendant of the file for each lookup.
function findChildContainingOffset(tsModule: typeof ts, parent: ts.Node, offset: number): ts.Node | undefined {
    let match: ts.Node | undefined;

    tsModule.forEachChild(parent, (child) => {
        if (offset >= child.getFullStart() && offset < child.getEnd()) {
            match = child;
        }
    });

    return match;
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

/**
 * Serves the document from its buffer (unsaved edits included) and everything else from disk, preferring
 * the buffer of any other open document so a lookup never runs against text the user has already changed.
 */
function createDocumentCompilerHost(document: vscode.TextDocument, options: ts.CompilerOptions): ts.CompilerHost {
    const normalizedFileName = normalizeFileName(document.uri.fsPath);
    const documentText = document.getText();
    const host = ts.createCompilerHost(options, true);

    const textFor = (candidate: string): string | undefined => {
        if (normalizeFileName(candidate) === normalizedFileName) {
            return documentText;
        }

        return openDocumentText(candidate) ?? ts.sys.readFile(candidate);
    };

    host.fileExists = (candidate) => normalizeFileName(candidate) === normalizedFileName || openDocumentText(candidate) !== undefined || ts.sys.fileExists(candidate);
    host.readFile = (candidate) => textFor(candidate);
    host.getSourceFile = (candidate, languageVersion, onError) => {
        const sourceText = textFor(candidate);
        if (sourceText === undefined) {
            onError?.(`File not found: ${candidate}`);
            return undefined;
        }

        const reusableSourceFile = getReusableSourceFile(candidate, sourceText);
        if (reusableSourceFile) {
            return reusableSourceFile;
        }

        const scriptKind = normalizeFileName(candidate) === normalizedFileName ? scriptKindFor(document) : scriptKindForFileName(candidate);
        return rememberSourceFile(candidate, sourceText, ts.createSourceFile(candidate, sourceText, languageVersion, true, scriptKind));
    };

    return host;
}

function openDocumentText(fileName: string): string | undefined {
    const normalized = normalizeFileName(fileName);

    for (const open of vscode.workspace.textDocuments) {
        if (normalizeFileName(open.uri.fsPath) === normalized) {
            return open.getText();
        }
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

    const host = createDocumentCompilerHost(document, options);

    const reuseKey = `${normalizedFileName}|${document.languageId}`;
    const hostStart = now();
    const program = ts.createProgram({ rootNames, options, host, oldProgram: previousProgramCache.get(reuseKey) });
    traceLog(trace, `ts.createProgram took ${now() - hostStart}ms reusing ${sourceFileCache.size} cached source file(s)`);
    rememberReusableProgram(reuseKey, program);
    return setCachedProgram(documentProgramCache, cacheKey, program);
}

function createProgramForFilePath(fileName: string, languageId?: string, trace?: DefinitionTrace): ts.Program | undefined {
    const normalizedFileName = normalizeFileName(fileName);
    const cacheKey = `disk|${normalizedFileName}|${languageId ?? ''}`;
    const cachedProgram = getCachedProgram(externalProgramCache, cacheKey, true);
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

    const program = ts.createProgram({ rootNames, options });
    return setCachedProgram(externalProgramCache, cacheKey, program, programStamp(program));
}

function createProgramForProbe(fileName: string, trace?: DefinitionTrace): ts.Program | undefined {
    const normalizedFileName = normalizeFileName(fileName);
    const cacheKey = `probe|${normalizedFileName}`;
    const cachedProgram = getCachedProgram(externalProgramCache, cacheKey, true);
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

    const program = ts.createProgram({ rootNames, options });
    return setCachedProgram(externalProgramCache, cacheKey, program, programStamp(program));
}

function isJavaScriptDocument(languageId: string): boolean {
    return languageId === 'javascript' || languageId === 'javascriptreact';
}

const WORKSPACE_SOURCE_GLOB = '**/*.{ts,tsx,mts,cts}';
const MAX_WORKSPACE_SOURCE_FILES = 4000;

let workspaceSourceFilesPromise: Thenable<string[]> | undefined;

/**
 * A program over the whole workspace rather than over the project that owns the document. A folder the
 * tsconfig excludes still contains files that reference the project's declarations, and the TypeScript
 * server plugin only ever sees one project, so a lookup that finds nothing in the document's own program is
 * retried against this one.
 */
async function createWorkspaceProgram(document: vscode.TextDocument, trace?: DefinitionTrace): Promise<ts.Program | undefined> {
    const fileName = document.uri.fsPath;
    const cacheKey = `workspace|${document.languageId}`;
    const cachedProgram = getCachedProgram(externalProgramCache, cacheKey, true);
    if (cachedProgram) {
        traceLog(trace, 'createWorkspaceProgram cache hit');
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
        rootNames = parsedConfig.fileNames;
        options = {
            ...parsedConfig.options,
            allowJs: parsedConfig.options.allowJs ?? isJavaScriptDocument(document.languageId),
        };
    }

    const workspaceFiles = await getWorkspaceSourceFiles();
    // Real casing here: these names end up in the locations we return, and a lowercased variant of an open
    // file is a different URI to VS Code, so the user sees the same target twice.
    const roots = new Set(rootNames);
    roots.add(fileName);
    for (const workspaceFile of workspaceFiles) {
        roots.add(workspaceFile);
    }

    const host = createDocumentCompilerHost(document, options);
    const reuseKey = `workspace|${document.languageId}`;
    const hostStart = now();
    const program = ts.createProgram({ rootNames: [...roots], options, host, oldProgram: previousProgramCache.get(reuseKey) });
    traceLog(trace, `workspace ts.createProgram over ${roots.size} file(s) took ${now() - hostStart}ms`);
    rememberReusableProgram(reuseKey, program);
    return setCachedProgram(externalProgramCache, cacheKey, program, programStamp(program));
}

function getWorkspaceSourceFiles(): Thenable<string[]> {
    workspaceSourceFilesPromise ??= vscode.workspace
        .findFiles(WORKSPACE_SOURCE_GLOB, '**/node_modules/**', MAX_WORKSPACE_SOURCE_FILES)
        .then((uris) => uris.map((uri) => uri.fsPath));

    return workspaceSourceFilesPromise;
}

function forgetWorkspaceSourceFiles(): void {
    workspaceSourceFilesPromise = undefined;
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

function getReusableSourceFile(fileName: string, text: string): ts.SourceFile | undefined {
    const key = normalizeFileName(fileName);
    const cached = sourceFileCache.get(key);
    if (!cached || cached.text !== text) {
        return undefined;
    }

    sourceFileCache.delete(key);
    sourceFileCache.set(key, cached);
    return cached.sourceFile;
}

function rememberSourceFile(fileName: string, text: string, sourceFile: ts.SourceFile): ts.SourceFile {
    const key = normalizeFileName(fileName);
    const previous = sourceFileCache.get(key);
    if (previous) {
        cachedSourceFileBytes -= previous.text.length;
        sourceFileCache.delete(key);
    }

    sourceFileCache.set(key, { text, sourceFile });
    cachedSourceFileBytes += text.length;

    while (sourceFileCache.size > MAX_CACHED_SOURCE_FILES || cachedSourceFileBytes > MAX_CACHED_SOURCE_FILE_BYTES) {
        const oldestKey = sourceFileCache.keys().next().value;
        if (oldestKey === undefined || oldestKey === key) {
            break;
        }

        const oldest = sourceFileCache.get(oldestKey);
        sourceFileCache.delete(oldestKey);
        cachedSourceFileBytes -= oldest?.text.length ?? 0;
    }

    return sourceFile;
}

function rememberReusableProgram(key: string, program: ts.Program): void {
    previousProgramCache.delete(key);
    previousProgramCache.set(key, program);

    while (previousProgramCache.size > MAX_REUSED_PROGRAMS) {
        const oldestKey = previousProgramCache.keys().next().value;
        if (oldestKey === undefined) {
            break;
        }

        previousProgramCache.delete(oldestKey);
    }
}

function getDocumentSourceFile(document: vscode.TextDocument): ts.SourceFile {
    const key = document.uri.toString();
    const cached = documentSourceFileCache.get(key);
    if (cached && cached.version === document.version) {
        return cached.sourceFile;
    }

    const sourceFile = ts.createSourceFile(document.fileName, document.getText(), ts.ScriptTarget.Latest, true, scriptKindFor(document));

    if (!documentSourceFileCache.has(key)) {
        while (documentSourceFileCache.size >= MAX_CACHED_DOCUMENT_SOURCE_FILES) {
            const oldestKey = documentSourceFileCache.keys().next().value;
            if (oldestKey === undefined) {
                break;
            }

            documentSourceFileCache.delete(oldestKey);
        }
    }

    documentSourceFileCache.set(key, { version: document.version, sourceFile });
    return sourceFile;
}

function getStringJumpSettings(): StringJumpSettings {
    const configuration = vscode.workspace.getConfiguration('string-jump');
    return {
        hideDeclaration: configuration.get<boolean>('hide-declaration', true),
        hideImports: configuration.get<boolean>('hide-imports', true),
        trace: configuration.get<boolean>('trace', false),
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
        tsServerPluginConfigured = true;
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
        const sourceFile = getDocumentSourceFile(document);
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
