const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

async function testIframeVisibilityRace() {
    const documentListeners = new Map();
    const windowListeners = new Map();
    const document = {
        hidden: false,
        documentElement: {},
        querySelector() { return null; },
        addEventListener(type, listener) { documentListeners.set(type, listener); },
    };
    const window = {
        ylcEnhancerLoaded: true,
        addEventListener(type, listener) { windowListeners.set(type, listener); },
    };
    const sandbox = {
        console,
        document,
        window,
        location: { pathname: '/live_chat' },
        navigator: { userAgent: 'Chrome', maxTouchPoints: 0 },
        MutationObserver: class { observe() {} disconnect() {} },
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        URL,
        URLSearchParams,
        chrome: { runtime: { getURL: () => '' } },
        ylcApi: {
            postToParent() {},
            resolveStateKey: async () => 'globalState',
            settingsGet: async defaults => defaults,
            readTabState: async () => ({}),
            onStorageChanged() {},
            onFrameMessage() {},
            settingsAreaName: () => 'sync',
            isInternalKey: () => false,
            sendMessage: async () => ({ ok: false }),
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(read('translation.js'), sandbox);
    vm.runInContext(read('chat_observer.js'), sandbox);

    let releaseFirstWait;
    let waitCalls = 0;
    let observerStarts = 0;
    sandbox.__wait = () => {
        waitCalls++;
        if (waitCalls === 1) return new Promise(resolve => { releaseFirstWait = resolve; });
        return Promise.resolve({ querySelector() { return null; } });
    };
    sandbox.__start = () => { observerStarts++; };
    vm.runInContext('waitForElement = __wait; startChatObserver = __start;', sandbox);

    const firstInitialization = vm.runInContext('initializeIframe()', sandbox);
    document.hidden = true;
    documentListeners.get('visibilitychange')();
    document.hidden = false;
    documentListeners.get('visibilitychange')();
    releaseFirstWait({});
    await firstInitialization;
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.strictEqual(observerStarts, 1, 'visibility recovery restarts iframe observation');
    assert.strictEqual(vm.runInContext('isInitialized', sandbox), true);
    vm.runInContext('clearManagedTimeouts()', sandbox);
}

function testFlowCleanupRuntime() {
    const cleared = [];
    const flowContainer = {
        childCount: 2,
        replaceChildren() { this.childCount = 0; },
    };
    const sandbox = {
        console,
        settings: {},
        flowContainer,
        window: { innerWidth: 1280 },
        document: { createElement() { return { content: {} }; } },
        clearTimeout(id) { cleared.push(id); },
        setTimeout,
        requestAnimationFrame(callback) { callback(); },
    };
    vm.createContext(sandbox);
    vm.runInContext(read('flow.js'), sandbox);
    vm.runInContext('flowRemovalTimers.add(11); flowRemovalTimers.add(22); lanes.set(0, 1); clearFlowComments();', sandbox);
    assert.deepStrictEqual(cleared, [11, 22]);
    assert.strictEqual(vm.runInContext('flowRemovalTimers.size', sandbox), 0);
    assert.strictEqual(vm.runInContext('lanes.size', sandbox), 0);
    assert.strictEqual(flowContainer.childCount, 0);
}

async function testStaleTranslationResultIsDiscarded() {
    let resolveOld;
    let sendCount = 0;
    const document = {
        hidden: false,
        addEventListener() {},
        querySelector() { return null; },
    };
    const sandbox = {
        console,
        document,
        window: { ylcEnhancerLoaded: true, addEventListener() {} },
        location: { href: 'https://www.youtube.com/watch?v=a', pathname: '/watch' },
        navigator: { userAgent: 'Chrome', maxTouchPoints: 0 },
        MutationObserver: class { observe() {} disconnect() {} },
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        requestAnimationFrame: callback => callback(),
        URL,
        URLSearchParams,
        chrome: { runtime: { getURL: () => '' } },
        ylcApi: {
            sendMessage() {
                sendCount++;
                if (sendCount === 1) return new Promise(resolve => { resolveOld = resolve; });
                return Promise.resolve({ ok: true, data: { translation: '新', translator: 'google' } });
            },
            onFrameMessage() {},
            onStorageChanged() {},
            settingsAreaName: () => 'sync',
            isInternalKey: () => false,
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(read('translation.js'), sandbox);
    vm.runInContext(read('content_script.js'), sandbox);
    vm.runInContext("settings = { translator: 'google', dictionary: '' };", sandbox);

    let oldCallbacks = 0;
    let newCallbacks = 0;
    sandbox.__oldCallback = () => { oldCallbacks++; };
    sandbox.__newCallback = result => {
        if (result?.translation === '新') newCallbacks++;
    };
    vm.runInContext("enqueueTranslation('old', __oldCallback); pageStateGeneration++; translationQueue.length = 0;", sandbox);
    resolveOld({ ok: true, data: { translation: '古', translator: 'google' } });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.strictEqual(oldCallbacks, 0, 'an active result from the previous page generation is discarded');

    vm.runInContext("enqueueTranslation('new', __newCallback);", sandbox);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.strictEqual(newCallbacks, 1, 'the current page generation still receives results');
}

function testFlowRemovalPathsRuntime() {
    const rafQueue = [];
    const timerCallbacks = new Map();
    const cleared = [];
    let nextTimer = 1;
    const elements = [];
    const flowContainer = {
        childElementCount: 0,
        offsetWidth: 800,
        offsetHeight: 450,
        appendChild(el) { elements.push(el); this.childElementCount++; el.isConnected = true; },
        contains(el) { return el.isConnected; },
        replaceChildren() { for (const el of elements) el.isConnected = false; this.childElementCount = 0; },
    };
    const createElement = tag => {
        if (tag === 'template') return { content: { childNodes: [] }, innerHTML: '' };
        const listeners = new Map();
        return {
            style: {},
            classList: { add() {} },
            appendChild() {},
            offsetWidth: 120,
            isConnected: false,
            addEventListener(type, listener) { listeners.set(type, listener); },
            remove() { this.isConnected = false; flowContainer.childElementCount--; },
            __listeners: listeners,
        };
    };
    const sandbox = {
        console,
        settings: {
            enableFlowComments: true, flowContent: 'translation', flowTime: 1,
            fontSize: 24, opacity: 1, position: 'top_priority', flowMarginTop: 0,
            flowMarginBottom: 0, strokeWidth: 0, normalColor: '#fff',
        },
        flowContainer,
        window: { innerWidth: 1280 },
        document: { hidden: false, createElement, createDocumentFragment: () => ({ appendChild() {} }) },
        Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
        URL,
        clearTimeout(id) { cleared.push(id); timerCallbacks.delete(id); },
        setTimeout(callback) { const id = nextTimer++; timerCallbacks.set(id, callback); return id; },
        requestAnimationFrame(callback) { rafQueue.push(callback); },
    };
    vm.createContext(sandbox);
    vm.runInContext(read('flow.js'), sandbox);
    vm.runInContext("createSafeContent = () => ({})", sandbox);

    const renderOne = () => {
        vm.runInContext("flowComment({ translated: '訳', html: 'source', userType: 'normal' })", sandbox);
        rafQueue.shift()();
        rafQueue.shift()();
        return elements[elements.length - 1];
    };
    const transitionElement = renderOne();
    assert.strictEqual(vm.runInContext('flowRemovalTimers.size', sandbox), 1);
    transitionElement.__listeners.get('transitionend')();
    assert.strictEqual(vm.runInContext('flowRemovalTimers.size', sandbox), 0);
    assert.strictEqual(transitionElement.isConnected, false);

    const timeoutElement = renderOne();
    const timeoutId = [...timerCallbacks.keys()][0];
    timerCallbacks.get(timeoutId)();
    assert.strictEqual(vm.runInContext('flowRemovalTimers.size', sandbox), 0);
    assert.strictEqual(timeoutElement.isConnected, false);
    assert.ok(cleared.length >= 2, 'both removal paths clear their insurance timer');
}

(async () => {
    await testIframeVisibilityRace();
    await testStaleTranslationResultIsDiscarded();
    testFlowCleanupRuntime();
    testFlowRemovalPathsRuntime();
    console.log('PASS: runtime lifecycle, stale translation, and flow cleanup');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
