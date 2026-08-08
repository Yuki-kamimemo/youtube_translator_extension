/**
 * translation.js の共有翻訳キャッシュ（getCachedTranslation / cacheTranslation）のテスト。
 * 既存テストと同じ素のNode + 手書きアサーション方式
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'translation.js'), 'utf8');
const sandbox = {
    chrome: { runtime: { getURL: () => '' } },
    fetch: () => Promise.reject(new Error('no network in test')),
    console,
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox);

let failures = 0;
function assert(cond, label) {
    if (cond) {
        console.log(`PASS: ${label}`);
    } else {
        failures++;
        console.error(`FAIL: ${label}`);
    }
}

assert(typeof sandbox.getCachedTranslation === 'function', 'getCachedTranslation が定義されている');
assert(typeof sandbox.cacheTranslation === 'function', 'cacheTranslation が定義されている');

assert(sandbox.getCachedTranslation('hello') === null, '未登録テキストは null');

sandbox.cacheTranslation('hello', 'こんにちは');
assert(sandbox.getCachedTranslation('hello') === 'こんにちは', '登録後は訳文が返る');

sandbox.cacheTranslation('', '空は無視');
assert(sandbox.getCachedTranslation('') === null, '空文字は登録されない');

sandbox.cacheTranslation('x', '');
assert(sandbox.getCachedTranslation('x') === null, '空訳文は登録されない');

// 上限超過で古いエントリから捨てられる（DIRECT_TRANSLATION_CACHE_MAX = 300）
for (let i = 0; i < 301; i++) sandbox.cacheTranslation(`text_${i}`, `訳_${i}`);
assert(sandbox.getCachedTranslation('text_0') === null, '上限超過で最古エントリが破棄される');
assert(sandbox.getCachedTranslation('text_300') === '訳_300', '最新エントリは保持される');

const inactiveContext = sandbox.getTranslationCacheContext({
    translator: 'lmstudio', lmstudioModel: 'model-a', lmstudioModelActive: false, dictionary: ''
});
const activeContext = sandbox.getTranslationCacheContext({
    translator: 'lmstudio', lmstudioModel: 'model-a', lmstudioModelActive: true, dictionary: ''
});
assert(inactiveContext !== activeContext, 'LM Studio active state changes the cache context');
sandbox.cacheTranslation('route-sensitive', 'google-result', inactiveContext);
assert(sandbox.getCachedTranslation('route-sensitive', activeContext) === null, 'Google fallback is not reused as an LM result');

vm.runInContext(`directTranslationCache.get(directTranslationCacheKey('route-sensitive', ${JSON.stringify(inactiveContext)})).timestamp = Date.now() - DIRECT_TRANSLATION_CACHE_TTL - 1`, sandbox);
assert(sandbox.getCachedTranslation('route-sensitive', inactiveContext) === null, 'expired content cache entry is discarded');

process.exit(failures ? 1 : 0);
