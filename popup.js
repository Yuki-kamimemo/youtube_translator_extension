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
        ollamaEndpoint: document.getElementById('ollamaEndpoint'),
        ollamaModel: document.getElementById('ollamaModel'),
        ollamaModelActive: document.getElementById('ollamaModelActive'),
        ollamaStatus: document.getElementById('ollamaStatus'),
        ollamaConfigGroup: document.getElementById('ollama-config-group'),
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

    function getSettingsFromForm() {
        const settings = {};
        Object.keys(defaults).filter(k => k !== 'profiles').forEach(key => {
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
        if (!['google', 'ollama'].includes(settings.translator)) {
            settings.translator = 'google';
        }
        Object.keys(settings).filter(k => k !== 'profiles').forEach(key => {
            const element = elements[key];
            if (element) {
                if (element.type === 'checkbox') element.checked = settings[key];
                else element.value = settings[key];
            }
        });
        if (elements.opacityValue && settings.opacity !== undefined) {
            elements.opacityValue.textContent = settings.opacity;
        }
        toggleOllamaConfig(settings.translator);
        updateOllamaStatusDisplay(settings.ollamaModelActive);
    }

    function toggleOllamaConfig(selected) {
        if (elements.ollamaConfigGroup) {
            elements.ollamaConfigGroup.style.display = (selected === 'ollama') ? 'block' : 'none';
        }
    }

    function updateOllamaStatusDisplay(active) {
        if (!elements.ollamaStatus) return;
        elements.ollamaStatus.textContent = active ? '起動中' : '停止中';
        elements.ollamaStatus.style.color = active ? '#4caf50' : '#888';
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
    
    elements.translator.addEventListener('change', (e) => {
        const selected = e.target.value;
        toggleOllamaConfig(selected);
        if (selected !== 'ollama') {
            const endpoint = elements.ollamaEndpoint.value.trim();
            const model = elements.ollamaModel.value.trim();
            chrome.runtime.sendMessage({ action: 'ollamaSetActive', active: false, endpoint, model });
            if (elements.ollamaModelActive) elements.ollamaModelActive.checked = false;
            updateOllamaStatusDisplay(false);
            chrome.storage.sync.set({ ollamaModelActive: false });
        }
        debouncedSaveSettings();
    });

    if (elements.ollamaModelActive) {
        elements.ollamaModelActive.addEventListener('change', async (e) => {
            const active = e.target.checked;
            const endpoint = elements.ollamaEndpoint.value.trim();
            const model = elements.ollamaModel.value.trim();
            const status = elements.ollamaStatus;

            if (status) status.textContent = active ? '起動中...' : '停止中...';
            
            chrome.runtime.sendMessage({
                action: 'ollamaSetActive', active, endpoint, model
            }, (res) => {
                if (res?.ok) {
                    updateOllamaStatusDisplay(active);
                } else {
                    if (status) {
                        status.textContent = `エラー: ${res?.error || '接続失敗'}`;
                        status.style.color = '#f44336';
                    }
                    e.target.checked = false;
                    chrome.storage.sync.set({ ollamaModelActive: false });
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
                        if (key === 'ollamaModelActive') updateOllamaStatusDisplay(newValue);
                    } else if (key !== 'profiles') { 
                        element.value = newValue;
                        if (key === 'translator') toggleOllamaConfig(newValue);
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
