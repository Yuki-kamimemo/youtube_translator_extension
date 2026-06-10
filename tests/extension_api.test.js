/**
 * extension_api.js のNodeテスト
 * Orion等の実機を用意せずに検証できる範囲として、
 * storage syncフォールバック・状態キー解決・TTL破棄・sendMessage正規化を確認する。
 *
 * 実行: node tests\extension_api.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

function makeChromeMock({ syncFails = false, tabId = null } = {}) {
    const stores = { sync: {}, local: {} };
    const chromeObj = {
        runtime: {
            id: 'test-extension-id',
            lastError: undefined,
            getURL: (p) => `chrome-extension://test-extension-id/${p}`,
            sendMessage(message, cb) {
                if (message && message.action === 'getTabId') {
                    cb({ tabId });
                    return;
                }
                cb(undefined);
            },
            onMessage: { addListener() {} },
        },
        storage: {
            onChanged: { addListener() {} },
        },
    };
    const failCall = (cb) => {
        chromeObj.runtime.lastError = { message: 'storage unavailable' };
        cb();
        chromeObj.runtime.lastError = undefined;
    };
    const makeArea = (store, opts = {}) => ({
        get(arg, cb) {
            if (opts.fail) return failCall(cb);
            let result = {};
            if (arg === null || arg === undefined) result = { ...store };
            else if (typeof arg === 'string') { if (arg in store) result[arg] = store[arg]; }
            else if (Array.isArray(arg)) { for (const k of arg) { if (k in store) result[k] = store[k]; } }
            else {
                result = { ...arg };
                for (const k of Object.keys(arg)) { if (k in store) result[k] = store[k]; }
            }
            cb(result);
        },
        set(values, cb) {
            if (opts.fail) return failCall(cb);
            Object.assign(store, values);
            cb();
        },
        remove(keys, cb) {
            if (opts.fail) return failCall(cb);
            for (const k of [].concat(keys)) delete store[k];
            cb();
        },
    });
    chromeObj.storage.sync = makeArea(stores.sync, { fail: syncFails });
    chromeObj.storage.local = makeArea(stores.local);
    return { chromeObj, stores };
}

function loadYlcApi(chromeObj, { search = '', referrer = '' } = {}) {
    const code = fs.readFileSync(path.join(__dirname, '..', 'extension_api.js'), 'utf8');
    const windowObj = {
        location: { search },
        addEventListener() {},
    };
    windowObj.parent = windowObj;
    const sandbox = {
        chrome: chromeObj,
        window: windowObj,
        document: { referrer },
        navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0', maxTouchPoints: 0 },
        URL,
        URLSearchParams,
        console,
        Date,
        Promise,
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.ylcApi;
}

async function run() {
    // 1. sync利用可能環境: 設定はsyncへ保存され、エリア名はsync
    {
        const { chromeObj, stores } = makeChromeMock();
        const api = loadYlcApi(chromeObj);
        const loaded = await api.settingsGet({ translator: 'google', fontSize: 24 });
        assert.strictEqual(loaded.translator, 'google');
        assert.strictEqual(api.settingsAreaName(), 'sync');
        await api.settingsSet({ fontSize: 30 });
        assert.strictEqual(stores.sync.fontSize, 30);
        assert.strictEqual(stores.local.fontSize, undefined);
        console.log('OK: sync利用可能環境の保存・読込');
    }

    // 2. sync不可環境: localへフォールバックし、エリア名はlocal
    {
        const { chromeObj, stores } = makeChromeMock({ syncFails: true });
        const api = loadYlcApi(chromeObj);
        await api.settingsSet({ translator: 'google' });
        assert.strictEqual(api.settingsAreaName(), 'local');
        assert.strictEqual(stores.local.translator, 'google');
        assert.strictEqual(stores.local.ylcMigratedFromSync, true);
        const loaded = await api.settingsGet({ translator: 'x', fontSize: 24 });
        assert.strictEqual(loaded.translator, 'google');
        console.log('OK: sync不可環境のlocalフォールバック');
    }

    // 3. 状態キー解決: タブIDあり → tabState
    {
        const { chromeObj } = makeChromeMock({ tabId: 42 });
        const api = loadYlcApi(chromeObj);
        assert.strictEqual(await api.resolveStateKey(), 'tabState_42');
        console.log('OK: 状態キー解決（tabState）');
    }

    // 4. 状態キー解決: タブIDなし＋vパラメータあり → sessionState
    {
        const { chromeObj } = makeChromeMock({ tabId: null });
        const api = loadYlcApi(chromeObj, { search: '?v=abc123' });
        assert.strictEqual(await api.resolveStateKey(), 'sessionState_abc123');
        console.log('OK: 状態キー解決（sessionState）');
    }

    // 5. 状態キー解決: 手掛かりなし → globalState、明示指定は最優先
    {
        const { chromeObj } = makeChromeMock({ tabId: null });
        const api = loadYlcApi(chromeObj);
        assert.strictEqual(await api.resolveStateKey(), 'globalState');
        assert.strictEqual(await api.resolveStateKey('tabState_7'), 'tabState_7');
        console.log('OK: 状態キー解決（globalState・明示指定）');
    }

    // 6. 状態の保存・読込とTTL破棄
    {
        const { chromeObj, stores } = makeChromeMock({ tabId: null });
        const api = loadYlcApi(chromeObj);
        await api.updateTabState('sessionState_v1', { enableFlowComments: false });
        let state = await api.readTabState('sessionState_v1');
        assert.strictEqual(state.enableFlowComments, false);
        assert.ok(state.updatedAt > 0);

        // 13時間前の状態は読み込み時に破棄される
        stores.local.sessionState_old = { enableFlowComments: true, updatedAt: Date.now() - 13 * 60 * 60 * 1000 };
        state = await api.readTabState('sessionState_old');
        assert.strictEqual(Object.keys(state).length, 0);

        // 掃除で期限切れsessionStateが消える
        stores.local.sessionState_old2 = { updatedAt: Date.now() - 13 * 60 * 60 * 1000 };
        await api.cleanupStaleSessionStates();
        assert.strictEqual(stores.local.sessionState_old2, undefined);
        assert.ok(stores.local.sessionState_v1);
        console.log('OK: 状態TTL破棄と掃除');
    }

    // 7. sendMessage正規化: runtime喪失時もrejectせず{ok:false}
    {
        const { chromeObj } = makeChromeMock();
        chromeObj.runtime.sendMessage = undefined;
        const api = loadYlcApi(chromeObj);
        const res = await api.sendMessage({ action: 'getTabId' });
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.reason, 'no-runtime');
        console.log('OK: sendMessage正規化（runtime喪失）');
    }

    // 7b. runtime.idが無くてもsendMessageが使えれば動く（Orion対策）
    {
        const { chromeObj } = makeChromeMock({ tabId: 5 });
        chromeObj.runtime.id = undefined;
        const api = loadYlcApi(chromeObj);
        assert.strictEqual(api.hasRuntime(), true);
        const res = await api.sendMessage({ action: 'getTabId' });
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.data.tabId, 5);
        console.log('OK: runtime.id無し環境でのsendMessage');
    }

    // 8. 内部キー判定
    {
        const { chromeObj } = makeChromeMock();
        const api = loadYlcApi(chromeObj);
        assert.ok(api.isInternalKey('tabState_1'));
        assert.ok(api.isInternalKey('sessionState_x'));
        assert.ok(api.isInternalKey('globalState'));
        assert.ok(api.isInternalKey('ylcProbe'));
        assert.ok(api.isInternalKey('ylcDiagProbe'));
        assert.ok(!api.isInternalKey('translator'));
        console.log('OK: 内部キー判定');
    }

    console.log('\nすべてのテストに合格');
}

run().catch((e) => {
    console.error('テスト失敗:', e);
    process.exit(1);
});
