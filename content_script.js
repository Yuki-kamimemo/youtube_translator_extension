/**
 * content_script.js (Main)
 * 拡張機能のメインロジック、初期化、イベント監視
 */

// --- グローバル変数 ---
const IS_IN_IFRAME = (window.self !== window.top);
let settings = {};
let chatObserver = null;
let ngUserList = [];
let ngWordList = [];
let flowContainer = null; // flow.jsが使用するグローバル変数

// --- デフォルト設定 ---
const DEFAULTS = {
    translator: 'gemini', geminiApiKey: '', geminiApiKey2: '', deeplApiKey: '', enableInlineTranslation: true,
    enableGoogleTranslateFallback: true, enableFlowComments: true, flowContent: 'translation',
    flowTime: 8, fontSize: 24, opacity: 0.9, position: 'top_priority',
    flowFontFamily: "'ヒラギノ角ゴ Pro W3', 'Hiragino Kaku Gothic Pro', 'メイリオ', Meiryo, sans-serif",
    customFontFamily: '', flowMarginTop: 10, flowMarginBottom: 10,
    normalColor: '#FFFFFF', memberColor: '#28a745', moderatorColor: '#007bff',
    superchatColor: '#FFFFFF',
    membershipColorFlow: '#00e676',
    ngUsers: '', ngWords: '',
};

// --- ヘルパー関数 ---
function updateNgLists() {
    ngUserList = settings.ngUsers ? settings.ngUsers.split('\n').map(u => u.trim()).filter(Boolean) : [];
    ngWordList = settings.ngWords ? settings.ngWords.split('\n').map(w => w.trim()).filter(Boolean) : [];
}

function waitForElement(selector, parent = document) {
    return new Promise(resolve => {
        const element = parent.querySelector(selector);
        if (element) return resolve(element);
        const observer = new MutationObserver(() => {
            const el = parent.querySelector(selector);
            if (el) { observer.disconnect(); resolve(el); }
        });
        observer.observe(parent.documentElement || parent, { childList: true, subtree: true });
    });
}

// --- コメント解析 ---
function parseComment(node) {
    const authorEl = node.querySelector('#author-name');
    const messageEl = node.querySelector('#message');
    let userType = 'normal';

    const authorTypeAttr = node.getAttribute('author-type');
    if (authorTypeAttr === 'moderator') userType = 'moderator';
    else if (authorTypeAttr === 'member') userType = 'member';

    const baseComment = {
        html: '', text: '', userType: userType,
        authorName: authorEl ? authorEl.textContent || '' : '',
        specialType: null,
    };

    switch (node.tagName) {
        case 'YT-LIVE-CHAT-TEXT-MESSAGE-RENDERER':
            if (messageEl) {
                baseComment.html = messageEl.innerHTML;
                baseComment.text = messageEl.textContent || '';
            }
            break;
        case 'YT-LIVE-CHAT-PAID-MESSAGE-RENDERER':
            const purchaseAmountEl = node.querySelector('#purchase-amount');
            if (messageEl) {
                baseComment.html = messageEl.innerHTML;
                baseComment.text = messageEl.textContent || '';
            }
            baseComment.specialType = 'superchat';
            baseComment.purchaseAmount = purchaseAmountEl ? purchaseAmountEl.textContent.trim() : '';
            baseComment.bgColor = node.style.getPropertyValue('--yt-live-chat-paid-message-primary-color');
            break;
        case 'YT-LIVE-CHAT-MEMBERSHIP-ITEM-RENDERER':
            const headerSubtextEl = node.querySelector('#header-subtext');
            let membershipHtml = '';
            let membershipText = '';
            if (headerSubtextEl) {
                membershipHtml = headerSubtextEl.innerHTML;
                membershipText = headerSubtextEl.textContent || '';
            }
            if (messageEl) {
                baseComment.html = membershipHtml ? `${membershipHtml}<br>${messageEl.innerHTML}` : messageEl.innerHTML;
                baseComment.text = membershipText ? `${membershipText} ${(messageEl.textContent || '')}`.trim() : (messageEl.textContent || '').trim();
            } else {
                baseComment.html = membershipHtml;
                baseComment.text = membershipText;
            }
            baseComment.specialType = 'membership';
            break;
    }
    if (!baseComment.html.trim() && baseComment.specialType === null) return null;
    return baseComment;
}

function isCommentFiltered(comment) {
    if (ngUserList.length > 0 && ngUserList.includes(comment.authorName)) return true;
    if (ngWordList.length > 0 && comment.text) {
        for (const word of ngWordList) {
            if (comment.text.includes(word)) return true;
        }
    }
    return false;
}

// --- UI作成・操作 ---
function createToggleButton(id, settingKey, labelPrefix, parentContainer) {
    const button = document.createElement('button');
    button.id = id;
    button.innerHTML = (id === 'toggle-translation-btn') ? '🌐' : '💬';
    const updateButton = (isEnabled) => {
        button.title = `${labelPrefix}: ${isEnabled ? 'オン' : 'オフ'}`;
        button.className = isEnabled ? 'enabled' : '';
    };
    updateButton(settings[settingKey]);
    button.onclick = () => chrome.storage.sync.set({ [settingKey]: !settings[settingKey] });
    parentContainer.appendChild(button);
}

function toggleSettingsPanel() {
    const panel = document.getElementById('ylc-settings-panel');
    if (panel) {
        const isVisible = panel.style.display === 'flex';
        panel.style.display = isVisible ? 'none' : 'flex';
    }
}

function createSettingsPanel() {
    if (document.getElementById('ylc-settings-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'ylc-settings-panel';
    const header = document.createElement('div');
    header.id = 'ylc-settings-header';
    header.textContent = 'チャット翻訳・表示設定';
    const closeButton = document.createElement('button');
    closeButton.id = 'ylc-settings-close-btn';
    closeButton.textContent = '×';
    closeButton.onclick = () => panel.style.display = 'none';
    header.appendChild(closeButton);
    const iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL('popup.html');
    iframe.id = 'ylc-settings-iframe';
    panel.appendChild(header);
    panel.appendChild(iframe);
    document.body.appendChild(panel);
    let isDragging = false;
    let offsetX, offsetY;
    header.onmousedown = (e) => {
        isDragging = true;
        offsetX = e.clientX - panel.offsetLeft;
        offsetY = e.clientY - panel.offsetTop;
        panel.style.transition = 'none';
    };
    document.onmousemove = (e) => {
        if (isDragging) {
            panel.style.left = `${e.clientX - offsetX}px`;
            panel.style.top = `${e.clientY - offsetY}px`;
        }
    };
    document.onmouseup = () => {
        isDragging = false;
        panel.style.transition = '';
    };
}

// --- メイン処理 ---
function processNewCommentNode(node) {
    if (node.dataset.processed) return;
    node.dataset.processed = 'true';

    const comment = parseComment(node);
    if (!comment) return;

    if (isCommentFiltered(comment)) {
        node.style.display = 'none';
        return;
    }

    const sendToFlow = (translatedText = '') => {
        if (settings.enableFlowComments) {
            comment.translated = translatedText;
            if (chrome.runtime?.id) {
                chrome.runtime.sendMessage({ type: 'FLOW_COMMENT_DATA', data: comment });
            }
        }
    };

    if (settings.enableInlineTranslation && comment.text) {
        requestTranslation(comment.text, (result) => {
            if (result.error) {
                displayInlineTranslation(node, `[${result.error}]`, true);
            } else if (result.translation) {
                displayInlineTranslation(node, result.translation);
            }
            sendToFlow(result.translation || '');
        });
    } else {
        sendToFlow('');
    }
}

function startChatObserver(chatItemsEl) {
    if (chatObserver) chatObserver.disconnect();
    const targetNodeTypes = [
        'YT-LIVE-CHAT-TEXT-MESSAGE-RENDERER',
        'YT-LIVE-CHAT-PAID-MESSAGE-RENDERER',
        'YT-LIVE-CHAT-MEMBERSHIP-ITEM-RENDERER',
    ];
    chatObserver = new MutationObserver(mutations => {
        mutations.forEach(m => m.addedNodes.forEach(node => {
            if (node.nodeType === 1 && targetNodeTypes.includes(node.tagName)) {
                processNewCommentNode(node);
            }
        }));
    });
    chatObserver.observe(chatItemsEl, { childList: true });
}

// --- 初期化 ---
async function initializeIframe() {
    const chatApp = await waitForElement('yt-live-chat-app');
    const header = await waitForElement('yt-live-chat-header-renderer', chatApp);
    let controls = document.getElementById('enhancer-controls');
    if (!controls) {
        controls = document.createElement('div');
        controls.id = 'enhancer-controls';
        createToggleButton('toggle-translation-btn', 'enableInlineTranslation', '翻訳', controls);
        createToggleButton('toggle-flow-btn', 'enableFlowComments', 'コメント表示', controls);
        const settingsBtn = document.createElement('button');
        settingsBtn.id = 'ylc-settings-btn';
        settingsBtn.title = '詳細設定を開く';
        settingsBtn.innerHTML = '⚙️';
        settingsBtn.onclick = () => chrome.runtime.sendMessage({ action: 'toggleSettingsPanel' });
        controls.appendChild(settingsBtn);
        header.after(controls);
    }
    const items = await waitForElement('#items.yt-live-chat-item-list-renderer', chatApp);
    startChatObserver(items);
}

async function initializeTopLevel() {
    if (!location.pathname.startsWith('/watch')) return;
    if (!document.getElementById('yt-flow-comment-container')) {
        const player = await waitForElement('#movie_player');
        if(player) {
            flowContainer = document.createElement('div');
            flowContainer.id = 'yt-flow-comment-container';
            player.appendChild(flowContainer);
        }
    }
    createSettingsPanel();
}

/**
 * メインの実行関数
 */
async function main() {
    try {
        const loadedSettings = await new Promise(resolve => chrome.storage.sync.get(DEFAULTS, resolve));
        Object.assign(settings, loadedSettings);
        updateNgLists();
    } catch (e) { return; }

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        let ngListsChanged = false;
        for (let key in changes) {
            settings[key] = changes[key].newValue;
            if (key === 'ngUsers' || key === 'ngWords') ngListsChanged = true;
        }
        if (ngListsChanged) updateNgLists();
        if (IS_IN_IFRAME) {
            const transBtn = document.getElementById('toggle-translation-btn');
            if (transBtn && 'enableInlineTranslation' in changes) {
                const isEnabled = settings.enableInlineTranslation;
                transBtn.title = `翻訳: ${isEnabled ? 'オン' : 'オフ'}`;
                transBtn.className = isEnabled ? 'enabled' : '';
            }
            const flowBtn = document.getElementById('toggle-flow-btn');
            if (flowBtn && 'enableFlowComments' in changes) {
                const isEnabled = settings.enableFlowComments;
                flowBtn.title = `コメント表示: ${isEnabled ? 'オン' : 'オフ'}`;
                flowBtn.className = isEnabled ? 'enabled' : '';
            }
        }
    });

    if (IS_IN_IFRAME && location.pathname.startsWith('/live_chat')) {
        initializeIframe();
    } else if (!IS_IN_IFRAME) {
        initializeTopLevel();
        document.body.addEventListener('yt-navigate-finish', initializeTopLevel);
        if (!window.ylcEnhancerMessageListener) {
            window.ylcEnhancerMessageListener = true;
            chrome.runtime.onMessage.addListener(req => {
                if (req.type === 'FLOW_COMMENT_DATA') { flowComment(req.data); } 
                else if (req.action === 'toggleSettingsPanel') { toggleSettingsPanel(); }
            });
        }
    }
}

main();
