// Underline behaviour of the real dist/extension.js, run outside VS Code against the stub API. Each case
// uses its own document version so the extension's per-version caches start clean.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import {
    activate,
    blindLocalLookupOn,
    createDocument,
    createEditor,
    failLocalLookupOn,
    fireActiveEditor,
    fireTextChange,
    fireVisibleRange,
    fixtureFile,
    location,
    outputLines,
    resetState,
    setDefinitionServer,
    settle,
    showEditor,
    state,
    underlined,
    wait,
} from './host.mjs';

const controller = fixtureFile('controller.ts');
const models = fixtureFile('models.ts');

// Literals in the fixture that the resolver can resolve forward: every one of them should be underlined.
// The range covers the quotes, as the literal scan does.
const RESOLVABLE = [
    `10:"'receiver_id'"`,
    `11:"'id'"`,
    `11:"'id'"`,
    `12:"'creator'"`,
    `13:"'creator'"`,
    `13:"'id'"`,
    `13:"'username'"`,
    `13:"'avatar'"`,
    `14:"'topics'"`,
    `18:"'title'"`,
    `19:"'user_id'"`,
].sort();

let version = 100;

function editorFor(options = {}) {
    version += 1;
    const document = createDocument(controller, { version, ...options });
    return createEditor(document, { line: 12, span: 40 });
}

before(async () => {
    await activate(editorFor());
    // The decorator only starts after its startup delay.
    await wait(1600);
});

// No case except the server fallback should get definitions from the server.
beforeEach(() => setDefinitionServer(() => []));

after(() => {
    setDefinitionServer(() => []);
});

test('underlines every literal it can resolve in the visible range', async () => {
    resetState();
    const editor = editorFor();
    showEditor(editor);
    fireActiveEditor(editor);
    await settle(editor);

    assert.deepEqual(underlined(editor), RESOLVABLE);
    assert.ok(state.paints > 0, 'the pass should paint at least once');
});

test('underlines survive an edit', async () => {
    resetState();
    const editor = editorFor();
    showEditor(editor);
    fireActiveEditor(editor);
    await settle(editor);

    editor.document.appendText('// an edit');
    fireTextChange(editor.document);
    fireVisibleRange(editor);
    await settle(editor);

    assert.deepEqual(underlined(editor), RESOLVABLE);
});

test('a pass still runs while the visible range keeps changing', async () => {
    resetState();
    const editor = editorFor();
    showEditor(editor);
    fireActiveEditor(editor);

    // A user scrolling fires visible-range events, which used to postpone the pending pass forever.
    const scrolling = setInterval(() => fireVisibleRange(editor), 4);
    await wait(500);
    clearInterval(scrolling);

    assert.ok(state.localLookups > 0, 'a pass should have started while scrolling');
    assert.ok(state.paints > 0, 'something should have been painted while scrolling');
});

test('one failing lookup does not cost the pass its other underlines', async () => {
    resetState();
    failLocalLookupOn(13);
    const editor = editorFor();
    showEditor(editor);
    fireActiveEditor(editor);
    await settle(editor);

    // Only the three column-list literals go through the failing lookup: the relation name next to them is
    // resolved by the extension's own key fallback, which runs before the resolver.
    assert.deepEqual(
        underlined(editor),
        RESOLVABLE.filter((entry) => !['13:"\'id\'"', '13:"\'username\'"', '13:"\'avatar\'"'].includes(entry))
    );
    assert.ok(
        outputLines().some((line) => line.includes('decoration lookup failed')),
        'the failure should be reported to the output channel'
    );
});

test('falls back to the server when the host program finds nothing, once per version', async () => {
    resetState();
    blindLocalLookupOn(13);
    setDefinitionServer((uri, position) => (position.line + 1 === 13 ? [location(models, 11)] : []));

    const editor = editorFor();
    showEditor(editor);
    fireActiveEditor(editor);
    await settle(editor);

    assert.deepEqual(underlined(editor), RESOLVABLE, 'the server should supply the four line-13 literals');
    assert.ok(state.serverQueries > 0, 'the server should have been asked');

    const queriesAfterFirstPass = state.serverQueries;
    fireVisibleRange(editor);
    await settle(editor);
    assert.equal(state.serverQueries, queriesAfterFirstPass, 'a second pass must not re-ask for the same literals');
});

test('a document that is not TypeScript in a file is left alone', async () => {
    resetState();
    const document = createDocument(controller, { languageId: 'markdown', version: ++version });
    const editor = createEditor(document, { line: 12, span: 40 });
    showEditor(editor);
    fireActiveEditor(editor);
    await wait(300);

    assert.deepEqual(underlined(editor), []);
    assert.ok(
        outputLines().some((line) => line.includes('no decorations for')),
        'the skipped document should be reported once'
    );
});
