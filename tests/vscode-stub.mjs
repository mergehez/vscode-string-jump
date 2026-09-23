// The slice of the `vscode` API the extension host touches, enough to run the real
// dist/extension.js outside VS Code. Records what the extension draws and logs.

export class Position {
    constructor(line, character) {
        this.line = line;
        this.character = character;
    }

    translate(lineDelta = 0, characterDelta = 0) {
        return new Position(this.line + lineDelta, this.character + characterDelta);
    }

    isBefore(other) {
        return this.line < other.line || (this.line === other.line && this.character < other.character);
    }

    isEqual(other) {
        return this.line === other.line && this.character === other.character;
    }

    with(line, character) {
        return new Position(line ?? this.line, character ?? this.character);
    }
}

export class Range {
    constructor(startOrLine, endOrCharacter, endLine, endCharacter) {
        if (startOrLine instanceof Position) {
            this.start = startOrLine;
            this.end = endOrCharacter;
        } else {
            this.start = new Position(startOrLine, endOrCharacter);
            this.end = new Position(endLine, endCharacter);
        }
    }

    contains(position) {
        return !position.isBefore(this.start) && !this.end.isBefore(position);
    }

    get isEmpty() {
        return this.start.isEqual(this.end);
    }
}

export class Selection extends Range {
    constructor(anchorOrStart, activeOrEnd, endLine, endCharacter) {
        super(anchorOrStart, activeOrEnd, endLine, endCharacter);
        this.anchor = this.start;
        this.active = this.end;
    }
}

export class Uri {
    constructor(fsPath, scheme = 'file') {
        this.fsPath = fsPath;
        this.scheme = scheme;
    }

    static file(fsPath) {
        return new Uri(fsPath);
    }

    toString() {
        return `${this.scheme}://${this.fsPath}`;
    }
}

export class Location {
    constructor(uri, range) {
        this.uri = uri;
        this.range = range;
    }
}

export class Disposable {
    constructor(callback) {
        this.dispose = callback ?? (() => {});
    }
}

export const DecorationRangeBehavior = { ClosedClosed: 0, OpenOpen: 1 };
export const ExtensionMode = { Production: 1, Test: 2, Development: 3 };
export const TextEditorRevealType = { AtTop: 0, InCenter: 1 };

export const recorded = { listeners: {} };

function disposableEvent(name) {
    recorded.listeners[name] = recorded.listeners[name] ?? [];
    return (listener) => {
        recorded.listeners[name].push(listener);
        return new Disposable();
    };
}

/** Fires an event the way VS Code would, so the extension reacts as it does in a real window. */
export function fireEvent(name, ...args) {
    for (const listener of recorded.listeners[name] ?? []) {
        listener(...args);
    }
}

export const window = {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    createTextEditorDecorationType: () => ({ key: 'string-jump', dispose() {} }),
    createOutputChannel: () => ({ appendLine: (line) => window.outputChannelLines.push(line), dispose() {} }),
    onDidChangeActiveTextEditor: disposableEvent('activeEditor'),
    onDidChangeVisibleTextEditors: disposableEvent('visibleEditors'),
    onDidChangeTextEditorVisibleRanges: disposableEvent('visibleRanges'),
    showTextDocument: async (document) => ({ document, selection: undefined, revealRange() {} }),
    showInformationMessage: () => undefined,
    outputChannelLines: [],
};

export const workspace = {
    getConfiguration: () => ({ get: (key, fallback) => (key === 'trace' ? true : fallback) }),
    openTextDocument: async (uri) => workspace.openTextDocument.impl(uri),
    onDidChangeConfiguration: disposableEvent('configuration'),
    onDidChangeTextDocument: disposableEvent('changeTextDocument'),
    onDidOpenTextDocument: disposableEvent('openTextDocument'),
    onDidCloseTextDocument: disposableEvent('closeTextDocument'),
    onDidCreateFiles: disposableEvent('createFiles'),
    onDidDeleteFiles: disposableEvent('deleteFiles'),
    textDocuments: [],
    /** Set by a test: which files the workspace glob would return, and how many at most. */
    findFiles: async (include, exclude, maxResults) => workspace.findFiles.impl(include, exclude, maxResults),
    fs: { writeFile: async () => {} },
};

workspace.findFiles.impl = () => [];

export const languages = {
    /** Captures the definition provider so tests can invoke the real lookup path. */
    registerDefinitionProvider: (selector, provider) => {
        languages.definitionProvider = provider;
        return new Disposable();
    },
    definitionProvider: undefined,
};

export const commands = {
    registerCommand: () => new Disposable(),
    executeCommand: async (...args) => commands.executeCommand.impl?.(...args),
};

export const extensions = {
    // Pretend the TypeScript extension is present, so the plugin counts as configured.
    getExtension: (id) => (id === 'vscode.typescript-language-features' ? { isActive: true, exports: { getAPI: () => ({ configurePlugin: () => {} }) } } : undefined),
};
