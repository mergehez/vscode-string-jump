// What the built resolver finds for each string literal shape the extension supports, on the fixture
// project in tests/fixtures/project. Assertions stay on "the target is the declaration whose name is the
// literal", so they do not break when a fixture line moves.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import { createProgram, fixtureFile, resolveIdentifier, resolveLiteral } from './program.mjs';

const controller = fixtureFile('controller.ts');
const keys = fixtureFile('keys.ts');
const models = fixtureFile('models.ts');

let program;

before(() => {
    program = createProgram([controller, keys, models]);
    program.getTypeChecker();
});

const resolve = (file, line, text, options) => resolveLiteral(program, file, line, text, options);

function assertResolvesTo(file, line, text, expected, options) {
    const { targets } = resolve(file, line, text, options);
    assert.equal(targets.length, 1, `"${text}" on ${file.split('/').pop()}:${line} should have exactly one target`);
    assert.equal(targets[0].relativeFileName, expected.file);
    assert.equal(targets[0].name, expected.name);
}

function assertNoTarget(file, line, text, options) {
    const { targets } = resolve(file, line, text, options);
    assert.deepEqual(targets, [], `"${text}" on ${file.split('/').pop()}:${line} should not resolve`);
}

test('a column argument jumps to the model property', () => {
    assertResolvesTo(controller, 10, 'receiver_id', { file: 'project/models.ts', name: 'receiver_id' });
    assertResolvesTo(controller, 11, 'id', { file: 'project/models.ts', name: 'id' }, { occurrence: 0 });
});

test('a relation argument jumps to the relation property', () => {
    assertResolvesTo(controller, 12, 'creator', { file: 'project/models.ts', name: 'creator' });
    assertResolvesTo(controller, 14, 'topics', { file: 'project/models.ts', name: 'topics' });
});

test('a column list jumps to the related model, not to the querying model', () => {
    // The columns of preload('creator', [...]) belong to the relation's model.
    assertResolvesTo(controller, 13, 'creator', { file: 'project/models.ts', name: 'creator' });
    assertResolvesTo(controller, 13, 'username', { file: 'project/models.ts', name: 'username' });
    assertResolvesTo(controller, 13, 'avatar', { file: 'project/models.ts', name: 'avatar' });
});

test('columns inside a related builder callback jump to the related model', () => {
    assertResolvesTo(controller, 18, 'title', { file: 'project/models.ts', name: 'title' });
    assertResolvesTo(controller, 19, 'user_id', { file: 'project/models.ts', name: 'user_id' });
});

test('a union member string jumps to the member that declares it', () => {
    assertResolvesTo(keys, 8, 'key0', { file: 'project/keys.ts', name: 'Keys' });
    assertResolvesTo(keys, 9, 'key1', { file: 'project/keys.ts', name: 'Keys' });
});

test('a key of an object argument jumps to the property, not to the type that admits it', () => {
    const { targets } = resolveLiteral(program, keys, 26, 'greeting');

    assert.equal(targets.length, 1);
    assert.equal(targets[0].relativeFileName, 'project/keys.ts');
    assert.equal(targets[0].name, 'greeting');
    assert.equal(targets[0].line, 15, 'the property declaration, not the MessageKeyOrObject alias');
});

test('strings without a declaration are left alone', () => {
    assertNoTarget(controller, 11, 'asc');
    assertNoTarget(controller, 15, 'not_a_column');
    assertNoTarget(controller, 18, 'x');
    assertNoTarget(controller, 19, 'desc');
    assertNoTarget(keys, 11, 'key2');
    assertNoTarget(keys, 12, 'not-a-key');
});

test('a declaration name lists the literals that refer to it', () => {
    const receiver = resolveIdentifier(program, models, 13, 'receiver_id');
    assert.equal(receiver.mode, 'reverse');
    assert.deepEqual(
        receiver.targets.map((target) => `${target.relativeFileName}:${target.name}`),
        ["project/controller.ts:'receiver_id'"]
    );

    const creator = resolveIdentifier(program, models, 15, 'creator');
    assert.equal(creator.targets.length, 2, 'both the relation argument and the column list start with "creator"');
    assert.ok(creator.targets.every((target) => target.relativeFileName === 'project/controller.ts'));
});
test('a member is found through property access and string literals alike', () => {
    const { targets } = resolveIdentifier(program, models, 17, 'nickname');

    assert.deepEqual(
        targets.map((target) => `${target.relativeFileName}:${target.line}:${target.name}`).sort(),
        ['project/members.ts:5:nickname', "project/members.ts:6:'nickname'"].sort()
    );
});
test('forward-only lookups skip the reverse search', () => {
    // The decoration pass asks for forward lookups only, and that has to stay cheap: a declaration name
    // must not scan the program for references.
    const { targets } = resolveIdentifier(program, models, 13, 'receiver_id', { reverse: false });
    assert.deepEqual(targets, []);
});
