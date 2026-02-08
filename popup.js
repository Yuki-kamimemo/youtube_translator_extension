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
        deeplApiKey: document.getElementById('deeplApiKey'),
        deeplKeyGroup: document.getElementById('deepl-key-group'),
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
        translator: 'google', deeplApiKey: '',
        enableGoogleTranslateFallback: true, enableInlineTranslation: true, enableFlowComments: true,
        flowContent: 'translation', flowTime: 8, fontSize: 24, opacity: 0.9, position: 'top_priority',
        strokeWidth: 1.5, strokeColor: '#000000',
        flowFontFamily: "'ヒラギノ角ゴ Pro W3', 'Hiragino Kaku Gothic Pro', 'メイリオ', Meiryo, sans-serif",
        customFontFamily: '', flowMarginTop: 10, flowMarginBottom: 10,
        normalColor: '#FFFFFF', memberColor: '#28a745', moderatorColor: '#007bff',
        superchatColor: '#FFFFFF',
        membershipColorFlow: '#00e676',
        dictionary: '', 
        ngUsers: '', ngWords: '',
        profiles: {},
    };
    
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
        chrome.storage.sync.set(getSettingsFromForm());
    }, 300);

    function loadSettings(settings) {
        Object.keys(settings).filter(k => k !== 'profiles').forEach(key => {
            const element = elements[key];
            if (element) {
                if (element.type === 'checkbox') element.checked = settings[key];
                else element.value = settings[key];
            }
        });
        elements.opacityValue.textContent = settings.opacity;
        toggleApiKeyInput(settings.translator);
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
        if (element.id && !element.id.includes('Group') && !element.id.includes('Value')) {
            element.addEventListener('input', debouncedSaveSettings);
        }
    });
    
    elements.translator.addEventListener('change', (e) => {
        toggleApiKeyInput(e.target.value);
        debouncedSaveSettings();
    });
    elements.opacity.addEventListener('input', (e) => { elements.opacityValue.textContent = e.target.value; });
    
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;

        for (let [key, { newValue }] of Object.entries(changes)) {
            const element = elements[key];
            if (element) {
                if (element.type === 'checkbox') {
                    element.checked = newValue;
                } else if (key !== 'profiles') { 
                    element.value = newValue;
                }
            }
        }
    });

    chrome.storage.sync.get(defaults, (settings) => {
        loadSettings(settings);
        populateProfiles(settings.profiles);
    });

    function toggleApiKeyInput(selected) {
        elements.deeplKeyGroup.style.display = (selected === 'deepl') ? 'block' : 'none';
    }
});