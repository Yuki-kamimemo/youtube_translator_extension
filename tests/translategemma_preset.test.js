const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
let detected = { isReliable: true, languages: [{ language: 'en', percentage: 99 }] };
let runtimeMessageListener = null;
const storage = { sync: {}, local: {} };
const storageArea = area => ({
    get(keys, callback) {
        let result = {};
        if (typeof keys === 'object' && !Array.isArray(keys)) result = { ...keys, ...storage[area] };
        else if (Array.isArray(keys)) keys.forEach(key => { if (key in storage[area]) result[key] = storage[area][key]; });
        else if (typeof keys === 'string' && keys in storage[area]) result[keys] = storage[area][keys];
        callback(result);
    },
    remove() {},
});
const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    fetch: async () => { throw new Error('not used'); },
    preprocessForYouTubeChat: async text => text,
    preprocessWithDictionary: text => text,
    postprocessJapanese: result => result,
    translateWithGoogle: async text => ({ translation: `G:${text}` }),
    chrome: {
        runtime: { onMessage: { addListener(listener) { runtimeMessageListener = listener; } }, lastError: null },
        storage: { sync: storageArea('sync'), local: storageArea('local') },
        tabs: { onRemoved: { addListener() {} } },
        action: { onClicked: { addListener() {} } },
        i18n: { detectLanguage(text, callback) { callback(detected); } },
    },
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const read = expression => vm.runInContext(expression, sandbox);

assert.strictEqual(read("isTranslateGemmaModel('mradermacher/translategemma-4b-it-Q4_K_S.gguf')"), true);
assert.strictEqual(read("isTranslateGemmaModel('google_translate-gemma.4b.it.Q4-K-M')"), false);
assert.strictEqual(read("isTranslateGemmaModel('qwen2.5-7b-instruct')"), false);

const request = read("buildTranslateGemmaRequest('translategemma-4b-it.Q4_K_S', 'hello', 'en')");
assert.strictEqual(request.messages.length, 1);
assert.strictEqual(request.messages[0].role, 'user');
assert.strictEqual(typeof request.messages[0].content, 'string');
assert(request.messages[0].content.includes('YouTube live chat message from English (en) to Japanese (ja)'));
assert(request.messages[0].content.includes('concise, natural, casual Japanese'));
assert(request.messages[0].content.includes('Preserve names, handles, titles, abbreviations'));
assert(request.messages[0].content.includes('Copy names, handles, and mixed-case or stylized tokens exactly as written'));
assert(request.messages[0].content.includes('Do not add subjects, honorifics, definitions, explanations'));
assert(request.messages[0].content.includes('Do not expand abbreviations or give multiple dictionary meanings'));
assert(!request.messages[0].content.includes('professional'));
assert(!request.messages[0].content.includes('cultural sensitivities'));
assert(request.messages[0].content.endsWith('hello'));
assert.strictEqual(request.response_format, undefined);
assert.strictEqual(request.max_tokens, 128);

const defaultRequest = read("buildDefaultLmstudioRequest('qwen2.5-7b-instruct', 'hello')");
assert.strictEqual(defaultRequest.input, 'hello');
assert(defaultRequest.system_prompt.includes('concise, natural, casual Japanese'));
assert(defaultRequest.system_prompt.includes('Preserve names, handles, titles, abbreviations'));
assert(defaultRequest.system_prompt.includes('Do not add subjects, honorifics, definitions, explanations'));
assert(!defaultRequest.system_prompt.includes('For short reactions use'));
assert.strictEqual(defaultRequest.reasoning, 'off');
assert.strictEqual(defaultRequest.store, false);
assert.strictEqual(defaultRequest.max_output_tokens, 80);
assert.strictEqual(defaultRequest.response_format, undefined);

const compatibilityRequest = read("buildDefaultLmstudioCompatibilityRequest('qwen2.5-7b-instruct', 'hello')");
assert.deepStrictEqual(JSON.parse(JSON.stringify(compatibilityRequest.messages.map(message => message.role))), ['system', 'user']);
assert.strictEqual(compatibilityRequest.response_format.type, 'json_schema');
assert.strictEqual(compatibilityRequest.response_format.json_schema.strict, true);

assert.strictEqual(read("getQuickChatTranslation('OH NICE!!!')"), '\u304a\u3001\u3044\u3044\u306d\uff01\uff01\uff01');
assert.strictEqual(read("getQuickChatTranslation('CUTE!!!!!')"), '\u304b\u308f\u3044\u3044\uff01\uff01\uff01\uff01\uff01');
assert.strictEqual(read("getQuickChatTranslation('hmm maybe')"), '\u3046\u30fc\u3093\u3001\u305d\u3046\u304b\u3082');
assert.strictEqual(read("getQuickChatTranslation('makes sense')"), '\u306a\u308b\u307b\u3069');
assert.strictEqual(read("getQuickChatTranslation('oh nice hat')"), null);
assert.strictEqual(read("getQuickChatTranslation('maybe later')"), null);
assert.strictEqual(read("getQuickChatTranslation('take the L')"), null);

(async () => {
    const response = ({ ok = true, status = 200, json = {}, text = '' }) => ({
        ok,
        status,
        async json() { return json; },
        async text() { return text; },
    });
    const normalSettings = { lmstudioModel: 'gemma-4-e2b-it-qat' };
    let calls = [];
    sandbox.fetch = async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        return response({ json: { output: [{ type: 'message', content: '\u5927\u4e08\u592b\u3060\u3088' }] } });
    };
    let translated = await read('translateWithLmstudio')('It is okay', normalSettings);
    assert.strictEqual(translated.translation, '\u5927\u4e08\u592b\u3060\u3088');
    assert.strictEqual(calls.length, 1);
    assert(calls[0].url.endsWith('/api/v1/chat'));
    assert.strictEqual(calls[0].body.reasoning, 'off');
    assert.strictEqual(calls[0].body.store, false);

    calls = [];
    sandbox.fetch = async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        if (calls.length === 1) return response({ ok: false, status: 400, text: 'reasoning setting unsupported' });
        return response({ json: { choices: [{ message: { content: '{"translation":"\u5927\u4e08\u592b"}' } }] } });
    };
    translated = await read('translateWithLmstudio')('It is fine', normalSettings);
    assert.strictEqual(translated.translation, '\u5927\u4e08\u592b');
    assert.strictEqual(calls.length, 2);
    assert(calls[0].url.endsWith('/api/v1/chat'));
    assert(calls[1].url.endsWith('/v1/chat/completions'));
    assert.strictEqual(calls[1].body.response_format.type, 'json_schema');

    calls = [];
    sandbox.fetch = async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        return response({ ok: false, status: 400, text: 'invalid model' });
    };
    await assert.rejects(read('translateWithLmstudio')('hello there', normalSettings), /invalid model/);
    assert.strictEqual(calls.length, 1);

    calls = [];
    sandbox.fetch = async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        return response({ json: { choices: [{ message: { content: '\u3053\u3093\u306b\u3061\u306f' } }] } });
    };
    translated = await read('translateWithLmstudio')('hello there', { lmstudioModel: 'translategemma-4b-it-Q4_K_S' }, 'en');
    assert.strictEqual(translated.translation, '\u3053\u3093\u306b\u3061\u306f');
    assert.strictEqual(calls.length, 1);
    assert(calls[0].url.endsWith('/v1/chat/completions'));
    assert.strictEqual(calls[0].body.reasoning, undefined);

    storage.local.ylcSettingsArea = 'local';
    storage.local.translator = 'lmstudio';
    storage.local.lmstudioModel = 'translategemma-4b-it-Q4_K_S';
    storage.local.lmstudioModelActive = true;
    const localSettings = await read('loadTranslationSettings')();
    assert.strictEqual(localSettings.translator, 'lmstudio');

    const settings = { translator: 'lmstudio', lmstudioModelActive: true, lmstudioModel: 'translategemma-4b-it-Q4_K_S', enableGoogleTranslateFallback: true };
    let route = await read('resolveTranslationRoute')("hello world", settings);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(route)), { route: 'lmstudio', sourceLanguage: 'en' });

    detected = { isReliable: false, languages: [{ language: 'en', percentage: 51 }] };
    route = await read('resolveTranslationRoute')("new uncertain input", settings);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(route)), { route: 'lmstudio', sourceLanguage: 'en' });

    detected = { isReliable: false, languages: [{ language: 'en', percentage: 99 }] };
    route = await read('resolveTranslationRoute')("short but high confidence", settings);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(route)), { route: 'lmstudio', sourceLanguage: 'en' });

    detected = { isReliable: false, languages: [{ language: 'es', percentage: 1 }] };
    route = await read('resolveTranslationRoute')("¿", settings);
    assert.strictEqual(route.route, 'google');

    detected = { isReliable: false, languages: [] };
    route = await read('resolveTranslationRoute')("今日はOK", settings);
    assert.strictEqual(route.route, 'google');

    detected = { isReliable: false, languages: [{ language: 'ru', percentage: 80 }] };
    route = await read('resolveTranslationRoute')("plain latin text", settings);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(route)), { route: 'lmstudio', sourceLanguage: 'en' });

    detected = { isReliable: false, languages: [{ language: 'en', percentage: 80 }] };
    route = await read('resolveTranslationRoute')("Привет мир", settings);
    assert.strictEqual(route.route, 'google');

    detected = { isReliable: false, languages: [{ language: 'sr', percentage: 80 }] };
    route = await read('resolveTranslationRoute')("Dobar dan", settings);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(route)), { route: 'lmstudio', sourceLanguage: 'sr' });

    const scriptCases = [
        ['am', '\u1230\u120b\u121d'], ['bn', '\u09ac\u09be\u0982\u09b2\u09be'], ['el', '\u03b3\u03b5\u03b9\u03ac'],
        ['gu', '\u0a97\u0ac1\u0a9c\u0ab0\u0abe\u0aa4\u0ac0'], ['he', '\u05e9\u05dc\u05d5\u05dd'], ['kn', '\u0c95\u0ca8\u0ccd\u0ca8\u0ca1'],
        ['ml', '\u0d2e\u0d32\u0d2f\u0d3e\u0d33\u0d02'], ['pa', '\u0a2a\u0a70\u0a1c\u0a3e\u0a2c\u0a40'], ['ta', '\u0ba4\u0bae\u0bbf\u0bb4\u0bcd'],
        ['te', '\u0c24\u0c46\u0c32\u0c41\u0c17\u0c41']
    ];
    for (const [language, sample] of scriptCases) {
        detected = { isReliable: true, languages: [{ language, percentage: 99 }] };
        route = await read('resolveTranslationRoute')(sample, settings);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(route)), { route: 'lmstudio', sourceLanguage: language });
    }

    detected = { isReliable: true, languages: [{ language: 'zh', percentage: 99 }] };
    route = await read('resolveTranslationRoute')('\u4f60\u597d', settings);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(route)), { route: 'lmstudio', sourceLanguage: 'zh' });

    detected = { isReliable: true, languages: [{ language: 'en', percentage: 99 }] };
    route = await read('resolveTranslationRoute')('I love \u521d\u97f3\u30df\u30af', settings);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(route)), { route: 'lmstudio', sourceLanguage: 'en' });

    detected = { isReliable: false, languages: [{ language: 'bn', percentage: 1 }] };
    route = await read('resolveTranslationRoute')('Vox \u09ac\u09be\u0982\u09b2\u09be', settings);
    assert.strictEqual(route.route, 'google');

    detected = { isReliable: false, languages: [] };
    route = await read('resolveTranslationRoute')("?", { ...settings, enableGoogleTranslateFallback: false });
    assert.strictEqual(route.route, 'unavailable');

    const keyA = read('buildTranslationCacheKey')("hello", { lmstudioModel: 'a', dictionary: 'x,y' }, 'lmstudio', 'en');
    const keyB = read('buildTranslationCacheKey')("hello", { lmstudioModel: 'b', dictionary: 'x,y' }, 'lmstudio', 'en');
    const keyC = read('buildTranslationCacheKey')("hello", { lmstudioModel: 'a', dictionary: 'x,z' }, 'lmstudio', 'en');
    assert.notStrictEqual(keyA, keyB);
    assert.notStrictEqual(keyA, keyC);

    const dispatch = request => new Promise(resolve => {
        assert.strictEqual(runtimeMessageListener(request, {}, resolve), true);
    });
    storage.local.translator = 'google';
    storage.local.lmstudioModelActive = false;
    let googleCalls = 0;
    let releaseGoogle;
    sandbox.translateWithGoogle = async text => {
        googleCalls++;
        await new Promise(resolve => { releaseGoogle = resolve; });
        return { translation: `G:${text}` };
    };
    const concurrentOne = dispatch({ action: 'translate', text: 'concurrent request' });
    while (!releaseGoogle) await new Promise(resolve => setTimeout(resolve, 0));
    const concurrentTwo = dispatch({ action: 'translate', text: 'concurrent request' });
    releaseGoogle();
    const [firstConcurrent, secondConcurrent] = await Promise.all([concurrentOne, concurrentTwo]);
    assert.strictEqual(googleCalls, 1);
    assert.strictEqual(firstConcurrent.translation, 'G:concurrent request');
    assert.strictEqual(secondConcurrent.translation, 'G:concurrent request');
    assert.strictEqual(secondConcurrent.result, undefined);

    storage.local.translator = 'lmstudio';
    storage.local.lmstudioModel = 'qwen2.5-7b-instruct';
    storage.local.lmstudioModelActive = true;
    storage.local.enableGoogleTranslateFallback = true;
    sandbox.translateWithGoogle = async text => ({ translation: `G:${text}` });
    let lmCalls = 0;
    sandbox.fetch = async () => {
        lmCalls++;
        if (lmCalls === 1) return response({ ok: false, status: 500, text: 'temporary failure' });
        return response({ json: { output: [{ type: 'message', content: '\u5fa9\u65e7\u6e08\u307f' }] } });
    };
    const fallbackResult = await dispatch({ action: 'translate', text: 'recovery request' });
    const recoveredResult = await dispatch({ action: 'translate', text: 'recovery request' });
    assert.strictEqual(fallbackResult.translation, 'G:recovery request');
    assert.strictEqual(recoveredResult.translation, '\u5fa9\u65e7\u6e08\u307f');
    assert.strictEqual(lmCalls, 2);
    console.log('PASS: TranslateGemma preset, language fallback, and cache isolation');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
