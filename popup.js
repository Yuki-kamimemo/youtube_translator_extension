document.addEventListener('DOMContentLoaded', () => {
    function debounce(func, delay) {
        let timeoutId;
        return function(...args) {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => {
                func.apply(this, args);
            }, delay);
        };
    }

    const elements = {
        translator: document.getElementById('translator'),
        lmstudioModel: document.getElementById('lmstudioModel'),
        refreshLmstudioModelsBtn: document.getElementById('refreshLmstudioModelsBtn'),
        lmstudioModelsStatus: document.getElementById('lmstudioModelsStatus'),
        lmstudioModelActive: document.getElementById('lmstudioModelActive'),
        lmstudioStatus: document.getElementById('lmstudioStatus'),
        lmstudioConfigGroup: document.getElementById('lmstudio-config-group'),
        enableGoogleTranslateFallback: document.getElementById('enableGoogleTranslateFallback'),
        enableInlineTranslation: document.getElementById('enableInlineTranslation'),
        enableFlowComments: document.getElementById('enableFlowComments'),
        flowContent: document.getElementById('flowContent'),
        flowTime: document.getElementById('flowTime'),
        fontSize: document.getElementById('fontSize'),
        opacity: document.getElementById('opacity'),
        opacityValue: document.getElementById('opacityValue'),
        position: document.getElementById('position'),
        strokeWidth: document.getElementById('strokeWidth'),
        strokeColor: document.getElementById('strokeColor'),
        flowFontFamily: document.getElementById('flowFontFamily'),
        customFontFamily: document.getElementById('customFontFamily'),
        flowMarginTop: document.getElementById('flowMarginTop'),
        flowMarginBottom: document.getElementById('flowMarginBottom'),
        normalColor: document.getElementById('normalColor'),
        memberColor: document.getElementById('memberColor'),
        moderatorColor: document.getElementById('moderatorColor'),
        superchatColor: document.getElementById('superchatColor'),
        membershipColorFlow: document.getElementById('membershipColorFlow'),
        overlayPosition: document.getElementById('overlayPosition'),
        dictionary: document.getElementById('dictionary'),
        ngUsers: document.getElementById('ngUsers'),
        ngWords: document.getElementById('ngWords'),
        profileName: document.getElementById('profileName'),
        saveProfileBtn: document.getElementById('saveProfileBtn'),
        deleteProfileBtn: document.getElementById('deleteProfileBtn'),
        profileSelector: document.getElementById('profileSelector'),
        loadProfileBtn: document.getElementById('loadProfileBtn'),
    };

    const defaults = {
        translator: 'google',
        lmstudioModel: '',
        lmstudioModelActive: false,
        ollamaEndpoint: 'http://localhost:11434',
        ollamaModel: 'youtube-translator:latest',
        ollamaModelActive: false,
        enableGoogleTranslateFallback: true, enableInlineTranslation: true, enableFlowComments: true,
        flowContent: 'translation', flowTime: 8, fontSize: 24, opacity: 0.9, position: 'top_priority',
        strokeWidth: 1.5, strokeColor: '#000000',
        flowFontFamily: "'ヒラギノ角ゴ Pro W3', 'Hiragino Kaku Gothic Pro', 'メイリオ', Meiryo, sans-serif",
        customFontFamily: '', flowMarginTop: 10, flowMarginBottom: 10,
        normalColor: '#FFFFFF', memberColor: '#28a745', moderatorColor: '#007bff',
        superchatColor: '#FFFFFF',
        membershipColorFlow: '#00e676',
        overlayPosition: 'top_right',
        dictionary: '',
        ngUsers: '', ngWords: '',
        profiles: {},
    };

    // 親ページ（content script）が解決した状態キーをクエリで受け取る。
    // タブIDが取れない環境でも親と同じキーを参照するための仕組み
    const urlStateKey = (() => {
        try { return new URLSearchParams(location.search).get('ylcStateKey') || null; } catch { return null; }
    })();

    // 実行文脈の判定: ページ内iframe（親=YouTubeページ）か、ツールバーポップアップ（トップレベル）か。
    // ポップアップ文脈ではwidth指定がないと極端なサイズになるためクラスで調整する
    const isToolbarPopup = (window.parent === window);
    if (isToolbarPopup) {
        document.body.classList.add('ylc-toolbar-popup');
    }
    let currentStateKey = null;
    // chrome.storageが使えない環境（Orion iOSのページ内iframe等）では
    // 設定の永続化を親ページ（content script）に代行させる
    let persistViaParent = false;
    let latestLmstudioModelRequestId = 0;
    let cachedLmstudioModels = [];

    // iOS/iPadOS相当環境ではlocalhostのLM Studioに到達できないため選択不可にする
    const lmstudioSupported = !ylcApi.isAppleTouchEnvironment();
    if (!lmstudioSupported && elements.translator) {
        const lmstudioOption = elements.translator.querySelector('option[value="lmstudio"]');
        if (lmstudioOption) {
            lmstudioOption.disabled = true;
            lmstudioOption.textContent += '（この環境では利用不可）';
        }
    }
    
    const tabs = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            tabContents.forEach(c => c.classList.remove('active'));
            document.getElementById(tab.dataset.tab).classList.add('active');
        });
    });

    function normalizeSettings(settings) {
        const normalized = { ...defaults, ...settings };
        if (normalized.translator === 'ollama') normalized.translator = 'lmstudio';
        if (!normalized.lmstudioModel && normalized.ollamaModel) normalized.lmstudioModel = normalized.ollamaModel;
        if (normalized.lmstudioModelActive === undefined && normalized.ollamaModelActive !== undefined) {
            normalized.lmstudioModelActive = normalized.ollamaModelActive;
        }
        normalized.lmstudioModel = normalized.lmstudioModel || defaults.lmstudioModel;
        normalized.lmstudioModelActive = normalized.lmstudioModelActive === true;
        return normalized;
    }

    function getSettingsFromForm() {
        const settings = {};
        Object.keys(defaults).filter(key => key !== 'profiles' && !key.startsWith('ollama')).forEach(key => {
            const element = elements[key];
            if (element) {
                switch (element.type) {
                    case 'checkbox': settings[key] = element.checked; break;
                    case 'number':
                    case 'range': settings[key] = parseFloat(element.value); break;
                    default: settings[key] = element.value;
                }
            }
        });
        return settings;
    }

    function saveSettingsNow() {
        const currentFormSettings = getSettingsFromForm();
        const tabStateKeys = ['enableInlineTranslation', 'enableFlowComments'];
        const tabState = {};
        const syncState = {};
        
        for (const [key, value] of Object.entries(currentFormSettings)) {
            if (tabStateKeys.includes(key)) {
                tabState[key] = value;
            } else {
                syncState[key] = value;
            }
        }
        
        if (!persistViaParent) {
            ylcApi.settingsSet(syncState);
            if (currentStateKey) {
                ylcApi.updateTabState(currentStateKey, tabState);
            }
        }

        // storage.onChangedが不安定な環境向け: 親ページ（watch）へ直接通知し、
        // 親がhidden live_chat iframeへも転送する。
        // persist=trueの場合は親が永続化も代行する
        ylcApi.postToParent({ type: 'YLC_SETTINGS_SAVED', settings: syncState, tabState, persist: persistViaParent });
    }

    const debouncedSaveSettings = debounce(saveSettingsNow, 300);

    function loadSettings(settings) {
        settings = normalizeSettings(settings);
        if (!['google', 'lmstudio'].includes(settings.translator)) {
            settings.translator = 'google';
        }
        // LM Studio非対応環境では保存値がlmstudioでもGoogle翻訳へ矯正する
        if (!lmstudioSupported && settings.translator === 'lmstudio') {
            settings.translator = 'google';
        }
        Object.keys(settings).filter(key => key !== 'profiles' && !key.startsWith('ollama')).forEach(key => {
            const element = elements[key];
            if (element) {
                if (key === 'lmstudioModel') setLmstudioModelOptions([], settings[key], '');
                else if (element.type === 'checkbox') element.checked = settings[key];
                else element.value = settings[key];
            }
        });
        if (elements.opacityValue && settings.opacity !== undefined) {
            elements.opacityValue.textContent = settings.opacity;
        }
        toggleLmstudioConfig(settings.translator);
        updateLmstudioStatusDisplay(settings.lmstudioModelActive);
        if (settings.translator === 'lmstudio') refreshLmstudioModels(settings.lmstudioModel);
    }

    function toggleLmstudioConfig(selected) {
        if (elements.lmstudioConfigGroup) {
            elements.lmstudioConfigGroup.style.display = (selected === 'lmstudio') ? 'block' : 'none';
        }
    }

    function updateLmstudioStatusDisplay(active) {
        if (!elements.lmstudioStatus) return;
        elements.lmstudioStatus.textContent = active ? '起動中' : '停止中';
        elements.lmstudioStatus.style.color = active ? '#4caf50' : '#888';
    }

    function setLmstudioModelsStatus(message, color = '#888') {
        if (!elements.lmstudioModelsStatus) return;
        elements.lmstudioModelsStatus.textContent = message;
        elements.lmstudioModelsStatus.style.color = color;
    }

    function setLmstudioModelOptions(models, selectedModel, statusMessage) {
        if (!elements.lmstudioModel) return;
        const currentValue = selectedModel || elements.lmstudioModel.value || defaults.lmstudioModel;
        const uniqueModels = [...new Set((models || []).filter(Boolean))];

        elements.lmstudioModel.innerHTML = '';
        if (currentValue && !uniqueModels.includes(currentValue)) {
            const savedOption = document.createElement('option');
            savedOption.value = currentValue;
            savedOption.textContent = `保存済み: ${currentValue}`;
            elements.lmstudioModel.appendChild(savedOption);
        }

        uniqueModels.forEach(model => {
            const option = document.createElement('option');
            option.value = model;
            option.textContent = model;
            elements.lmstudioModel.appendChild(option);
        });

        if (!elements.lmstudioModel.options.length) {
            const fallbackOption = document.createElement('option');
            fallbackOption.value = '';
            fallbackOption.textContent = 'モデルを選択してください';
            elements.lmstudioModel.appendChild(fallbackOption);
        }

        elements.lmstudioModel.value = currentValue;
        if (!elements.lmstudioModel.value && elements.lmstudioModel.options.length) {
            elements.lmstudioModel.value = elements.lmstudioModel.options[0].value;
        }
        setLmstudioModelsStatus(statusMessage || '');
    }

    function refreshLmstudioModels(selectedModel) {
        if (!elements.lmstudioModel) return;
        const requestId = ++latestLmstudioModelRequestId;
        const currentValue = selectedModel || elements.lmstudioModel.value || defaults.lmstudioModel;

        setLmstudioModelsStatus('モデル一覧を取得中...');
        if (elements.refreshLmstudioModelsBtn) elements.refreshLmstudioModelsBtn.disabled = true;

        ylcApi.sendMessage({ action: 'lmstudioListModels' }).then((messageResult) => {
            if (requestId !== latestLmstudioModelRequestId) return;
            if (elements.refreshLmstudioModelsBtn) elements.refreshLmstudioModelsBtn.disabled = false;

            if (!messageResult.ok) {
                cachedLmstudioModels = [];
                setLmstudioModelOptions([], currentValue, `エラー: ${messageResult.reason}`);
                setLmstudioModelsStatus(`エラー: ${messageResult.reason}`, '#f44336');
                return;
            }

            const res = messageResult.data;
            if (res?.ok) {
                const models = res.models || [];
                cachedLmstudioModels = models;
                const message = models.length ? `${models.length}件のモデルを取得` : '登録済みモデルがありません';
                setLmstudioModelOptions(models, currentValue, message);
                if (!currentValue && models.length) debouncedSaveSettings();
            } else {
                cachedLmstudioModels = [];
                setLmstudioModelOptions([], currentValue, `エラー: ${res?.error || '接続失敗'}`);
                setLmstudioModelsStatus(`エラー: ${res?.error || '接続失敗'}`, '#f44336');
            }
        });
    }

    function populateProfiles(profiles) {
        elements.profileSelector.innerHTML = '';
        const profileNames = Object.keys(profiles || {});
        if (profileNames.length === 0) {
            elements.profileSelector.innerHTML = '<option>保存されたプロファイルはありません</option>';
            return;
        }
        profileNames.forEach(name => {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            elements.profileSelector.appendChild(option);
        });
    }

    elements.saveProfileBtn.addEventListener('click', () => {
        const name = elements.profileName.value.trim();
        if (!name) { alert('プロファイル名を入力してください。'); return; }

        ylcApi.settingsGet('profiles').then((data) => {
            const profiles = data.profiles || {};
            profiles[name] = getSettingsFromForm();
            ylcApi.settingsSet({ profiles }).then((saved) => {
                if (saved && !persistViaParent) {
                    alert(`「${name}」を保存しました。`);
                    populateProfiles(profiles);
                } else {
                    alert('この環境ではプロファイルを保存できません。');
                }
            });
        });
    });

    elements.loadProfileBtn.addEventListener('click', () => {
        const name = elements.profileSelector.value;
        ylcApi.settingsGet('profiles').then((data) => {
            if (data.profiles && data.profiles[name]) {
                loadSettings(data.profiles[name]);
                saveSettingsNow();
                alert(`「${name}」を読み込みました。`);
            }
        });
    });

    elements.deleteProfileBtn.addEventListener('click', () => {
        const name = elements.profileName.value.trim();
        if (!name) { alert('削除するプロファイルの名前を入力してください。'); return; }

        ylcApi.settingsGet('profiles').then((data) => {
            const profiles = data.profiles || {};
            if (profiles[name]) {
                if (confirm(`プロファイル「${name}」を本当に削除しますか？`)) {
                    delete profiles[name];
                    ylcApi.settingsSet({ profiles }).then((saved) => {
                        if (saved && !persistViaParent) {
                            alert(`「${name}」を削除しました。`);
                            populateProfiles(profiles);
                            elements.profileName.value = '';
                        } else {
                            alert('この環境ではプロファイルを削除できません。');
                        }
                    });
                }
            } else {
                alert('その名前のプロファイルは存在しません。');
            }
        });
    });

    Object.keys(elements).filter(k => k !== 'profiles' && elements[k]).forEach(key => {
        const element = elements[key];
        if (element.id && !element.id.includes('Group') && !element.id.includes('Value') && !element.id.includes('Status')) {
            element.addEventListener('input', debouncedSaveSettings);
            element.addEventListener('change', debouncedSaveSettings);
        }
    });

    const debouncedRefreshLmstudioModels = debounce(() => refreshLmstudioModels(), 500);
    if (elements.refreshLmstudioModelsBtn) {
        elements.refreshLmstudioModelsBtn.addEventListener('click', () => refreshLmstudioModels());
    }
    if (elements.lmstudioModel) {
        elements.lmstudioModel.addEventListener('change', debouncedSaveSettings);
    }
    
    elements.translator.addEventListener('change', (e) => {
        const selected = e.target.value;
        toggleLmstudioConfig(selected);
        if (selected !== 'lmstudio') {
            const model = elements.lmstudioModel.value.trim();
            ylcApi.sendMessage({ action: 'lmstudioSetActive', active: false, model });
            if (elements.lmstudioModelActive) elements.lmstudioModelActive.checked = false;
            updateLmstudioStatusDisplay(false);
            ylcApi.settingsSet({ lmstudioModelActive: false });
        } else {
            refreshLmstudioModels();
        }
        debouncedSaveSettings();
    });

    if (elements.lmstudioModelActive) {
        elements.lmstudioModelActive.addEventListener('change', async (e) => {
            const active = e.target.checked;
            const model = elements.lmstudioModel.value.trim();
            const status = elements.lmstudioStatus;

            if (status) status.textContent = active ? '起動中...' : '停止中...';
            
            ylcApi.sendMessage({
                action: 'lmstudioSetActive', active, model
            }).then((messageResult) => {
                const res = messageResult.ok ? messageResult.data : null;
                if (res?.ok) {
                    updateLmstudioStatusDisplay(active);
                } else {
                    if (status) {
                        status.textContent = `エラー: ${res?.error || messageResult.reason || '接続失敗'}`;
                        status.style.color = '#f44336';
                    }
                    e.target.checked = false;
                    ylcApi.settingsSet({ lmstudioModelActive: false });
                }
            });
            debouncedSaveSettings();
        });
    }

    if (elements.opacity) {
        elements.opacity.addEventListener('input', (e) => { 
            if (elements.opacityValue) elements.opacityValue.textContent = e.target.value; 
        });
    }
    
    ylcApi.onStorageChanged((changes, area) => {
        if (area !== 'sync' && area !== 'local') return;

        if (area === 'local' && currentStateKey && changes[currentStateKey]) {
            const newTabState = changes[currentStateKey].newValue || {};
            if (elements.enableInlineTranslation && newTabState.enableInlineTranslation !== undefined) {
                elements.enableInlineTranslation.checked = newTabState.enableInlineTranslation;
            }
            if (elements.enableFlowComments && newTabState.enableFlowComments !== undefined) {
                elements.enableFlowComments.checked = newTabState.enableFlowComments;
            }
        }

        // 設定エリアはsync不可環境ではlocalに切り替わるため、解決済みエリア名で判定する
        if (area === ylcApi.settingsAreaName()) {
            for (let [key, { newValue }] of Object.entries(changes)) {
                if (key === 'enableInlineTranslation' || key === 'enableFlowComments') continue;
                if (ylcApi.isInternalKey(key)) continue;
                const element = elements[key];
                if (element) {
                    if (element.type === 'checkbox') {
                        element.checked = newValue;
                        if (key === 'lmstudioModelActive') updateLmstudioStatusDisplay(newValue);
                    } else if (key !== 'profiles') { 
                        if (key === 'lmstudioModel') {
                            setLmstudioModelOptions(cachedLmstudioModels, newValue, elements.lmstudioModelsStatus?.textContent || '');
                        } else {
                            element.value = newValue;
                        }
                        if (key === 'translator') {
                            const normalizedTranslator = newValue === 'ollama' ? 'lmstudio' : newValue;
                            if (element.value !== normalizedTranslator) element.value = normalizedTranslator;
                            toggleLmstudioConfig(normalizedTranslator);
                            if (normalizedTranslator === 'lmstudio') refreshLmstudioModels();
                        }
                    }
                }
            }
        }
    });

    // ---- 親ページ（content script）への問い合わせ ----

    /** ページ内iframe文脈で親へリクエストし、対応するレスポンスを待つ */
    function requestFromParent(requestType, responseType, payload = {}, timeoutMs = 4000) {
        return new Promise(resolve => {
            if (isToolbarPopup) { resolve(null); return; }
            const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            let settled = false;
            let unsubscribe = null;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (unsubscribe) unsubscribe();
                resolve(value);
            };
            const timer = setTimeout(() => finish(null), timeoutMs);
            unsubscribe = ylcApi.onFrameMessage((message) => {
                if (message.type !== responseType || message.requestId !== requestId) return;
                finish(message);
            });
            if (!ylcApi.postToParent({ type: requestType, requestId, ...payload })) {
                finish(null);
            }
        });
    }

    function requestParentDiagnostics() {
        return requestFromParent('YLC_DIAG_REQUEST', 'YLC_DIAG_RESPONSE').then(m => m?.data || null);
    }

    /** chrome.storageが使えない環境向け: 親に設定の読み出しを代行させる */
    function requestParentSettings() {
        const plainDefaults = {};
        for (const [key, value] of Object.entries(defaults)) {
            if (key !== 'profiles') plainDefaults[key] = value;
        }
        return requestFromParent('YLC_SETTINGS_REQUEST', 'YLC_SETTINGS_RESPONSE', { defaults: plainDefaults }, 3000);
    }

    async function probeStorageUsable() {
        const ok = await ylcApi.localSet({ ylcDiagProbe: Date.now() });
        if (ok) ylcApi.localRemove('ylcDiagProbe');
        return ok;
    }

    // ---- 機能診断 ----

    function renderDiagnostics(items) {
        const list = document.getElementById('diagnosticsList');
        if (!list) return;
        list.innerHTML = '';
        for (const item of items) {
            const li = document.createElement('li');
            const status = document.createElement('span');
            status.textContent = item.ok ? 'OK' : 'NG';
            status.className = item.ok ? 'diag-ok' : 'diag-ng';
            li.appendChild(status);
            li.appendChild(document.createTextNode(` ${item.label}`));
            if (item.detail) {
                const detail = document.createElement('span');
                detail.className = 'diag-detail';
                detail.textContent = ` — ${item.detail}`;
                li.appendChild(detail);
            }
            list.appendChild(li);
        }
    }

    async function runDiagnostics() {
        const items = [];
        const add = (label, ok, detail = '') => items.push({ label, ok, detail });

        const bg = await ylcApi.sendMessage({ action: 'getTabId' });
        add('background通信', bg.ok, bg.ok ? '' : (bg.reason || ''));

        await ylcApi.settingsGet({});
        const areaName = ylcApi.settingsAreaName();
        add('設定保存先', true, areaName === 'sync' ? 'sync（通常）' : 'local（フォールバック中）');

        const localOk = await ylcApi.localSet({ ylcDiagProbe: Date.now() });
        if (localOk) ylcApi.localRemove('ylcDiagProbe');
        add('storage local', localOk);

        const tr = await ylcApi.sendMessage({ action: 'translate', text: 'hello' });
        const trOk = tr.ok && !!tr.data?.translation;
        add('Google翻訳（background経由）', trOk, trOk ? `結果: ${tr.data.translation}` : (tr.data?.error || tr.reason || ''));

        add('LM Studio', lmstudioSupported, lmstudioSupported ? 'この環境では選択可能' : 'この環境では利用不可（iOS/iPadOS相当）');
        add('設定パネル表示方式', true, isToolbarPopup ? 'ツールバーポップアップ' : 'ページ内iframe');
        add('設定の保存方式', true, persistViaParent ? '親ページ代行（このパネルからstorage不可）' : '直接保存');
        add('状態キー', true, currentStateKey || '(未解決)');

        if (!isToolbarPopup) {
            const parentInfo = await requestParentDiagnostics();
            if (parentInfo) {
                add('hidden live_chat iframe',
                    parentInfo.hiddenChatIframePresent === true,
                    parentInfo.hiddenChatIframePresent ? '作成済み'
                        : (parentInfo.hiddenChatIframeFailed ? '作成失敗（フローコメント縮退中）' : '未作成（ライブチャットなし？）'));
                const watchModeLabels = {
                    'iframe-script': 'iframe内スクリプト（通常）',
                    'direct': '親ページから直接監視（フォールバック）',
                    'none': '未監視',
                };
                add('チャット監視', parentInfo.chatWatchMode !== 'none',
                    watchModeLabels[parentInfo.chatWatchMode] || String(parentInfo.chatWatchMode || '不明'));
                add('Google翻訳（content script直接fetch）',
                    parentInfo.directGoogleTranslateOk === true,
                    parentInfo.directGoogleTranslateDetail || '');
            } else {
                add('親ページ診断', false, '応答なし（postMessage経路が縮退している可能性）');
            }
        }

        renderDiagnostics(items);
    }

    const runDiagnosticsBtn = document.getElementById('runDiagnosticsBtn');
    if (runDiagnosticsBtn) {
        runDiagnosticsBtn.addEventListener('click', async () => {
            runDiagnosticsBtn.disabled = true;
            runDiagnosticsBtn.textContent = '診断中...';
            try {
                await runDiagnostics();
            } finally {
                runDiagnosticsBtn.disabled = false;
                runDiagnosticsBtn.textContent = '診断を実行';
            }
        });
    }

    (async () => {
        currentStateKey = await ylcApi.resolveStateKey(urlStateKey);

        // storageが使えない環境では親に読み出しを代行させる
        const storageUsable = await probeStorageUsable();
        if (!storageUsable && !isToolbarPopup) {
            const remote = await requestParentSettings();
            if (remote && remote.settings) {
                persistViaParent = true;
                const { updatedAt, ...tabStateValues } = remote.tabState || {};
                loadSettings({ ...remote.settings, ...tabStateValues });
                populateProfiles(remote.settings.profiles);
                return;
            }
        }

        const storedSettings = await ylcApi.settingsGet(defaults);
        const tabState = await ylcApi.readTabState(currentStateKey);
        const { updatedAt, ...tabStateValues } = tabState;
        loadSettings({ ...storedSettings, ...tabStateValues });
        populateProfiles(storedSettings.profiles);
    })();
});
