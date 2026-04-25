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
        lmstudioEndpoint: document.getElementById('lmstudioEndpoint'),
        lmstudioModel: document.getElementById('lmstudioModel'),
        lmstudioApiToken: document.getElementById('lmstudioApiToken'),
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
        lmstudioEndpoint: 'http://localhost:1234',
        lmstudioModel: '',
        lmstudioApiToken: '',
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

    let currentTabId = null;
    let latestLmstudioModelRequestId = 0;
    let cachedLmstudioModels = [];
    
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
        const normalized = { ...settings };
        if (normalized.translator === 'ollama') normalized.translator = 'lmstudio';
        if (!normalized.lmstudioEndpoint && normalized.ollamaEndpoint) normalized.lmstudioEndpoint = normalized.ollamaEndpoint;
        if (!normalized.lmstudioModel && normalized.ollamaModel) normalized.lmstudioModel = normalized.ollamaModel;
        if (normalized.lmstudioModelActive === undefined && normalized.ollamaModelActive !== undefined) {
            normalized.lmstudioModelActive = normalized.ollamaModelActive;
        }
        normalized.lmstudioEndpoint = normalized.lmstudioEndpoint || defaults.lmstudioEndpoint;
        normalized.lmstudioModel = normalized.lmstudioModel || defaults.lmstudioModel;
        normalized.lmstudioApiToken = normalized.lmstudioApiToken || '';
        normalized.lmstudioModelActive = normalized.lmstudioModelActive === true;
        return normalized;
    }

    function getSettingsFromForm() {
        const settings = {};
        Object.keys(defaults).filter(k => k !== 'profiles' && !key.startsWith('ollama')).forEach(key => {
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

    const debouncedSaveSettings = debounce(() => {
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
        
        chrome.storage.sync.set(syncState);
        
        if (currentTabId) {
            chrome.storage.local.set({ [`tabState_${currentTabId}`]: tabState });
        }
    }, 300);

    function loadSettings(settings) {
        settings = normalizeSettings(settings);
        if (!['google', 'lmstudio'].includes(settings.translator)) {
            settings.translator = 'google';
        }
        Object.keys(settings).filter(k => k !== 'profiles' && !key.startsWith('ollama')).forEach(key => {
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
        if (!elements.lmstudioEndpoint || !elements.lmstudioModel) return;
        const requestId = ++latestLmstudioModelRequestId;
        const endpoint = elements.lmstudioEndpoint.value.trim();
        const apiToken = elements.lmstudioApiToken?.value.trim() || '';
        const currentValue = selectedModel || elements.lmstudioModel.value || defaults.lmstudioModel;

        setLmstudioModelsStatus('モデル一覧を取得中...');
        if (elements.refreshLmstudioModelsBtn) elements.refreshLmstudioModelsBtn.disabled = true;

        chrome.runtime.sendMessage({ action: 'lmstudioListModels', endpoint, apiToken }, (res) => {
            if (requestId !== latestLmstudioModelRequestId) return;
            if (elements.refreshLmstudioModelsBtn) elements.refreshLmstudioModelsBtn.disabled = false;

            if (chrome.runtime.lastError) {
                cachedLmstudioModels = [];
                setLmstudioModelOptions([], currentValue, `エラー: ${chrome.runtime.lastError.message}`);
                setLmstudioModelsStatus(`エラー: ${chrome.runtime.lastError.message}`, '#f44336');
                return;
            }

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

        chrome.storage.sync.get('profiles', (data) => {
            const profiles = data.profiles || {};
            profiles[name] = getSettingsFromForm();
            chrome.storage.sync.set({ profiles }, () => {
                alert(`「${name}」を保存しました。`);
                populateProfiles(profiles);
            });
        });
    });

    elements.loadProfileBtn.addEventListener('click', () => {
        const name = elements.profileSelector.value;
        chrome.storage.sync.get('profiles', (data) => {
            if (data.profiles && data.profiles[name]) {
                loadSettings(data.profiles[name]);
                debouncedSaveSettings();
                alert(`「${name}」を読み込みました。`);
            }
        });
    });

    elements.deleteProfileBtn.addEventListener('click', () => {
        const name = elements.profileName.value.trim();
        if (!name) { alert('削除するプロファイルの名前を入力してください。'); return; }

        chrome.storage.sync.get('profiles', (data) => {
            const profiles = data.profiles || {};
            if (profiles[name]) {
                if (confirm(`プロファイル「${name}」を本当に削除しますか？`)) {
                    delete profiles[name];
                    chrome.storage.sync.set({ profiles }, () => {
                        alert(`「${name}」を削除しました。`);
                        populateProfiles(profiles);
                        elements.profileName.value = '';
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
        }
    });

    const debouncedRefreshLmstudioModels = debounce(() => refreshLmstudioModels(), 500);
    if (elements.refreshLmstudioModelsBtn) {
        elements.refreshLmstudioModelsBtn.addEventListener('click', () => refreshLmstudioModels());
    }
    if (elements.lmstudioEndpoint) {
        elements.lmstudioEndpoint.addEventListener('input', debouncedRefreshLmstudioModels);
    }
    if (elements.lmstudioApiToken) {
        elements.lmstudioApiToken.addEventListener('input', debouncedRefreshLmstudioModels);
    }
    if (elements.lmstudioModel) {
        elements.lmstudioModel.addEventListener('change', debouncedSaveSettings);
    }
    
    elements.translator.addEventListener('change', (e) => {
        const selected = e.target.value;
        toggleLmstudioConfig(selected);
        if (selected !== 'lmstudio') {
            const endpoint = elements.lmstudioEndpoint.value.trim();
            const model = elements.lmstudioModel.value.trim();
            const apiToken = elements.lmstudioApiToken?.value.trim() || '';
            chrome.runtime.sendMessage({ action: 'lmstudioSetActive', active: false, endpoint, model, apiToken });
            if (elements.lmstudioModelActive) elements.lmstudioModelActive.checked = false;
            updateLmstudioStatusDisplay(false);
            chrome.storage.sync.set({ lmstudioModelActive: false });
        } else {
            refreshLmstudioModels();
        }
        debouncedSaveSettings();
    });

    if (elements.lmstudioModelActive) {
        elements.lmstudioModelActive.addEventListener('change', async (e) => {
            const active = e.target.checked;
            const endpoint = elements.lmstudioEndpoint.value.trim();
            const model = elements.lmstudioModel.value.trim();
            const apiToken = elements.lmstudioApiToken?.value.trim() || '';
            const status = elements.lmstudioStatus;

            if (status) status.textContent = active ? '起動中...' : '停止中...';
            
            chrome.runtime.sendMessage({
                action: 'lmstudioSetActive', active, endpoint, model, apiToken
            }, (res) => {
                if (res?.ok) {
                    updateLmstudioStatusDisplay(active);
                } else {
                    if (status) {
                        status.textContent = `エラー: ${res?.error || '接続失敗'}`;
                        status.style.color = '#f44336';
                    }
                    e.target.checked = false;
                    chrome.storage.sync.set({ lmstudioModelActive: false });
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
    
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync' && area !== 'local') return;

        if (area === 'local' && currentTabId && changes[`tabState_${currentTabId}`]) {
            const newTabState = changes[`tabState_${currentTabId}`].newValue || {};
            if (elements.enableInlineTranslation && newTabState.enableInlineTranslation !== undefined) {
                elements.enableInlineTranslation.checked = newTabState.enableInlineTranslation;
            }
            if (elements.enableFlowComments && newTabState.enableFlowComments !== undefined) {
                elements.enableFlowComments.checked = newTabState.enableFlowComments;
            }
        }

        if (area === 'sync') {
            for (let [key, { newValue }] of Object.entries(changes)) {
                if (key === 'enableInlineTranslation' || key === 'enableFlowComments') continue;
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

    chrome.runtime.sendMessage({ action: 'getTabId' }, (response) => {
        currentTabId = response?.tabId || null;
        
        chrome.storage.sync.get(defaults, (syncSettings) => {
            if (currentTabId) {
                chrome.storage.local.get(`tabState_${currentTabId}`, (localData) => {
                    const tabState = localData[`tabState_${currentTabId}`] || {};
                    const finalSettings = { ...syncSettings, ...tabState };
                    loadSettings(finalSettings);
                    populateProfiles(syncSettings.profiles);
                });
            } else {
                loadSettings(syncSettings);
                populateProfiles(syncSettings.profiles);
            }
        });
    });
});
