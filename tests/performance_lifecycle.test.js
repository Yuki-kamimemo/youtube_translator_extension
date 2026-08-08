const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const translationSource = fs.readFileSync(path.join(__dirname, '..', 'translation.js'), 'utf8');
const sandbox = { console, Set, Map, Math };
vm.createContext(sandbox);
vm.runInContext(translationSource, sandbox);
const collect = vm.runInContext('collectRecentChatNodes', sandbox);
const shouldSkip = vm.runInContext('shouldSkipTranslation', sandbox);
const createBatcher = vm.runInContext('createChatMutationBatcher', sandbox);

assert.strictEqual(shouldSkip('これは日本語です'), true);
assert.strictEqual(shouldSkip('Hello 草'), false);
assert.strictEqual(shouldSkip('안녕하세요'), false);
assert.strictEqual(shouldSkip('Привет'), false);

for (const sample of ['\u1230\u120b\u121d', '\u09ac\u09be\u0982\u09b2\u09be', '\u03b3\u03b5\u03b9\u03ac', '\u05e9\u05dc\u05d5\u05dd', '\u0ba4\u0bae\u0bbf\u0bb4\u0bcd']) {
    assert.strictEqual(shouldSkip(sample), false);
}
assert.strictEqual(shouldSkip('\u4f60\u597d'), false);
assert.strictEqual(shouldSkip('\u65e5\u672c\u8a9e\u3067\u3059'), true);

const nodes = Array.from({ length: 1000 }, (_, index) => ({
    nodeType: 1,
    tagName: 'yt-live-chat-text-message-renderer',
    index,
}));
const recent = collect([{ addedNodes: nodes }], 5);
assert.strictEqual(recent.length, 5);
assert.deepStrictEqual(Array.from(recent, node => node.index), [995, 996, 997, 998, 999]);

const scheduledFrames = [];
const processedAcrossCallbacks = [];
const batcher = createBatcher(5, node => processedAcrossCallbacks.push(node.index), callback => scheduledFrames.push(callback));
for (let index = 0; index < 100; index++) {
    batcher.push([{ addedNodes: [{ nodeType: 1, tagName: 'yt-live-chat-text-message-renderer', index }] }]);
}
assert.strictEqual(scheduledFrames.length, 1);
assert.strictEqual(batcher.pendingCount(), 5);
scheduledFrames.shift()();
assert.deepStrictEqual(Array.from(processedAcrossCallbacks), [95, 96, 97, 98, 99]);

const content = fs.readFileSync(path.join(__dirname, '..', 'content_script.js'), 'utf8');
const chat = fs.readFileSync(path.join(__dirname, '..', 'chat_observer.js'), 'utf8');
const flow = fs.readFileSync(path.join(__dirname, '..', 'flow.js'), 'utf8');

for (const source of [content, chat]) {
    assert(/MAX_CONCURRENT_TRANSLATIONS\s*=\s*3/.test(source));
    assert(/MAX_QUEUE_SIZE\s*=\s*50/.test(source));
    assert(/if \(document\.hidden\)/.test(source));
    assert(/createChatMutationBatcher\(/.test(source));
}
assert(/childElementCount\s*>=\s*MAX_ONSCREEN_COMMENTS/.test(flow));
assert(/flowRemovalTimers/.test(flow));
assert(/function clearFlowComments\(/.test(flow));
assert(/removeHiddenChat\(\);[\s\S]*clearFlowComments\(\)/.test(content));
assert(/pageStateGeneration\+\+;[\s\S]*chatObserver\.disconnect\(\)/.test(chat));
assert(/generation !== pageStateGeneration \|\| document\.hidden/.test(chat));

console.log('PASS: burst limits, queue limits, visibility guards, and flow cleanup');
