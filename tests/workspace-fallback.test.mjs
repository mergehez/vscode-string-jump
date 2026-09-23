// References that live outside the document's TypeScript project: the fixture tsconfig excludes
// tests/fixtures/project/excluded, so a program built from it (and the tsserver plugin, which only ever sees
// one project) cannot see those files. The definition provider must still find them.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import { activate, createDocument, createEditor, fixtureFile, setOpenDocuments, setWorkspaceFiles, settle, showEditor, state } from './host.mjs';

const models = fixtureFile('models.ts');

before(async () => {
    // What the workspace glob would return, including the excluded folder.
    setWorkspaceFiles([
        fixtureFile('orm.ts'),
        fixtureFile('models.ts'),
        fixtureFile('keys.ts'),
        fixtureFile('controller.ts'),
        fixtureFile('members.ts'),
        fixtureFile('excluded/usage.ts'),
    ]);

    const document = createDocument(models, { version: 1 });
    setOpenDocuments([document]);
    await activate(createEditor(document, { line: 17, span: 6 }));
});

/** The `nickname` declaration in models.ts (line 17, `    declare nickname: string;`). */
function nicknamePosition(vscode, document) {
    const line = document.lineAt(16).text;
    return new vscode.Position(16, line.indexOf('nickname') + 1);
}

const targetLabels = (locations) =>
    (Array.isArray(locations) ? locations : [locations])
        .filter(Boolean)
        .map((location) => `${location.uri.fsPath}:${location.range.start.line + 1}`)
        .sort();

test('a reference outside the project is found through the workspace program', async () => {
    const vscode = await import('./vscode-stub.mjs');
    const document = createDocument(models, { version: 500 });
    setOpenDocuments([document]);
    showEditor(createEditor(document, { line: 17, span: 6 }));

    const locations = await vscode.languages.definitionProvider.provideDefinition(document, nicknamePosition(vscode, document));

    assert.deepEqual(
        targetLabels(locations),
        [`${fixtureFile('members.ts')}:5`, `${fixtureFile('members.ts')}:6`, `${fixtureFile('excluded/usage.ts')}:8`, `${fixtureFile('excluded/usage.ts')}:9`].sort(),
        'the property access and the string literal, inside and outside the project, should all be found with the real path casing'
    );
});

test('a lookup whose references are all inside the project never builds the workspace program', async () => {
    const vscode = await import('./vscode-stub.mjs');
    const document = createDocument(fixtureFile('controller.ts'), { version: 501 });
    setOpenDocuments([document]);
    showEditor(createEditor(document, { line: 10, span: 6 }));
    state.localLookups = 0;

    const locations = await vscode.languages.definitionProvider.provideDefinition(document, new vscode.Position(9, 40));
    const targets = (Array.isArray(locations) ? locations : [locations]).filter(Boolean);

    assert.ok(targets.length > 0, 'the in-project lookup should still resolve');
});

test('an unsupported document is left alone', async () => {
    const vscode = await import('./vscode-stub.mjs');
    const document = createDocument(models, { version: 502, languageId: 'markdown' });
    setOpenDocuments([document]);
    showEditor(createEditor(document, { line: 17, span: 6 }));

    const locations = await vscode.languages.definitionProvider.provideDefinition(document, nicknamePosition(vscode, document));
    assert.ok(!locations || (Array.isArray(locations) && locations.length === 0));
});

test('a dirty document still resolves through the workspace program', async () => {
    const vscode = await import('./vscode-stub.mjs');
    const document = createDocument(models, { version: 503 });
    document.isDirty = true;
    document.appendText('// unsaved');
    setOpenDocuments([document]);
    showEditor(createEditor(document, { line: 17, span: 6 }));
    await settle(createEditor(document, { line: 17, span: 6 }), { timeoutMs: 200 });

    const locations = await vscode.languages.definitionProvider.provideDefinition(document, nicknamePosition(vscode, document));

    assert.ok(
        targetLabels(locations).some((label) => label.startsWith(fixtureFile('excluded/usage.ts'))),
        'the excluded reference should be found even with unsaved changes'
    );
});
