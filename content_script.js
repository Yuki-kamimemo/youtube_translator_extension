/**
 * content_script.js (Main)
 * 拡張機能のメインロジック、初期化、イベント監視
 * * ▼▽▼ 安定性向上のための修正版 ▼▽▼
 */

// --- グローバル変数 ---
const IS_IN_IFRAME = (window.self !== window.top);
let settings = {};
let chatObserver = null;
let ngUserList = [];
let ngWordList = [];
let flowContainer = null; // flow.jsが使用するグローバル変数
let isInitialized = false; // ★追加: 初期化状態を管理するフラグ
let initializationRetryTimer = null; // ★追加: 初期化再試行のためのタイマー

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

function waitForElement(selector, parent = document, timeout = 15000) { // ★変更: タイムアウトを追加
    return new Promise((resolve, reject) => {
        const element = parent.querySelector(selector);
        if (element) {
            resolve(element);
            return;
        }

        const observer = new MutationObserver(() => {
            const el = parent.querySelector(selector);
            if (el) {
                observer.disconnect();
                clearTimeout(timer);
                resolve(el);
            }
        });

        const timer = setTimeout(() => {
            observer.disconnect();
            console.warn(`[YLC Enhancer] waitForElement timed out for selector: ${selector}`);
            reject(new Error(`Element not found: ${selector}`));
        }, timeout);

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
    // ★追加: 既存のコメントも処理する
    chatItemsEl.querySelectorAll(targetNodeTypes.join(',')).forEach(processNewCommentNode);

    chatObserver = new MutationObserver(mutations => {
        mutations.forEach(m => m.addedNodes.forEach(node => {
            if (node.nodeType === 1 && targetNodeTypes.includes(node.tagName)) {
                processNewCommentNode(node);
            }
        }));
    });
    chatObserver.observe(chatItemsEl, { childList: true });
    console.log('[YLC Enhancer] Chat observer started.');
}

// --- 初期化 ---
async function initializeIframe() {
    // ★変更: isInitializedフラグをチェック
    if (isInitialized) return;
    
    try {
        const chatApp = await waitForElement('yt-live-chat-app');
        const header = await waitForElement('yt-live-chat-header-renderer', chatApp);
        
        let controls = document.getElementById('enhancer-controls');
        if (!controls) {
            controls = document.createElement('div');
            controls.id = 'enhancer-controls';
            header.after(controls); // ★変更: 先にコンテナを挿入
            
            // UIの作成
            createToggleButton('toggle-translation-btn', 'enableInlineTranslation', '翻訳', controls);
            createToggleButton('toggle-flow-btn', 'enableFlowComments', 'コメント表示', controls);
            const settingsBtn = document.createElement('button');
            settingsBtn.id = 'ylc-settings-btn';
            settingsBtn.title = '詳細設定を開く';
            settingsBtn.innerHTML = '⚙️';
            settingsBtn.onclick = () => chrome.runtime.sendMessage({ action: 'toggleSettingsPanel' });
            controls.appendChild(settingsBtn);
        }
        
        const items = await waitForElement('#items.yt-live-chat-item-list-renderer', chatApp);
        startChatObserver(items);
        isInitialized = true; // ★追加: 初期化完了をマーク
        clearTimeout(initializationRetryTimer); // ★追加: 再試行タイマーをクリア
        console.log('[YLC Enhancer] Iframe initialized successfully.');
    } catch (error) {
        console.error('[YLC Enhancer] Iframe initialization failed:', error);
        isInitialized = false; // ★追加: 失敗した場合は未初期化状態に戻す
    }
}

async function initializeTopLevel() {
    // ★変更: isInitializedフラグをチェック
    if (isInitialized) return;
    if (!location.pathname.startsWith('/watch')) return;

    try {
        const player = await waitForElement('#movie_player');
        if (player && !document.getElementById('yt-flow-comment-container')) {
            flowContainer = document.createElement('div');
            flowContainer.id = 'yt-flow-comment-container';
            player.appendChild(flowContainer);
        }
        createSettingsPanel();
        isInitialized = true; // ★追加: 初期化完了をマーク
        console.log('[YLC Enhancer] Top-level initialized successfully.');
    } catch (error) {
        console.error('[YLC Enhancer] Top-level initialization failed:', error);
        isInitialized = false;
    }
}

/**
 * ★★★ メインの実行関数 (安定性向上版) ★★★
 */
async function main() {
    // 既にリスナーが設定されていれば何もしない
    if (window.ylcEnhancerLoaded) return;
    window.ylcEnhancerLoaded = true;

    try {
        const loadedSettings = await new Promise(resolve => chrome.storage.sync.get(DEFAULTS, resolve));
        Object.assign(settings, loadedSettings);
        updateNgLists();
    } catch (e) {
        console.error('[YLC Enhancer] Failed to load settings:', e);
        return; 
    }

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        let ngListsChanged = false;
        let reInitRequired = false; // ★追加: UI更新が必要かどうかのフラグ
        for (let key in changes) {
            settings[key] = changes[key].newValue;
            if (key === 'ngUsers' || key === 'ngWords') ngListsChanged = true;

            // ボタンの表示に関わる設定が変更されたらUI更新フラグを立てる
            if (key === 'enableInlineTranslation' || key === 'enableFlowComments') {
                reInitRequired = true;
            }
        }
        if (ngListsChanged) updateNgLists();
        
        // ★変更: ボタンの状態を動的に更新
        if (IS_IN_IFRAME && reInitRequired) {
            const transBtn = document.getElementById('toggle-translation-btn');
            if (transBtn && 'enableInlineTranslation' in changes) {
                const isEnabled = settings.enableInlineTranslation;
                transBtn.title = `翻訳: ${isEnabled ? 'オン' : 'オフ'}`;
                transBtn.classList.toggle('enabled', isEnabled);
            }
            const flowBtn = document.getElementById('toggle-flow-btn');
            if (flowBtn && 'enableFlowComments' in changes) {
                const isEnabled = settings.enableFlowComments;
                flowBtn.title = `コメント表示: ${isEnabled ? 'オン' : 'オフ'}`;
                flowBtn.classList.toggle('enabled', isEnabled);
            }
        }
    });

    const attemptInitialization = () => {
        isInitialized = false; // ★追加: 初期化試行前にリセット
        if (IS_IN_IFRAME && location.pathname.startsWith('/live_chat')) {
            initializeIframe();
        } else if (!IS_IN_IFRAME) {
            initializeTopLevel();
        }
    };
    
    if (!IS_IN_IFRAME) {
        // トップレベルでのメッセージリスナーとナビゲーションイベントリスナーの設定
        if (!window.ylcEnhancerMessageListener) {
            window.ylcEnhancerMessageListener = true;
            chrome.runtime.onMessage.addListener(req => {
                if (req.type === 'FLOW_COMMENT_DATA') { flowComment(req.data); } 
                else if (req.action === 'toggleSettingsPanel') { toggleSettingsPanel(); }
            });
        }
        
        // ★変更: ナビゲーションイベントリスナーは一度だけ登録
        if (!window.ylcNavigateListener) {
             window.ylcNavigateListener = true;
             document.body.addEventListener('yt-navigate-finish', () => {
                 console.log('[YLC Enhancer] yt-navigate-finish detected. Re-initializing...');
                 // isInitializedをリセットして再初期化を許可
                 isInitialized = false;
                 // 以前のタイマーをクリア
                 clearTimeout(initializationRetryTimer);
                 // 短い遅延の後、初期化を試みる
                 initializationRetryTimer = setTimeout(attemptInitialization, 500);
             });
        }
    }
    
    // ★変更: DOMの読み込み状態に応じて初期化を試みる
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', attemptInitialization);
    } else {
        attemptInitialization();
    }
    
    // ★追加: 最終手段としての再試行タイマー
    // 3秒後に初期化が完了していなければ、再度試みる
    initializationRetryTimer = setTimeout(() => {
        if (!isInitialized) {
            console.log('[YLC Enhancer] Initial attempt failed or timed out. Retrying...');
            attemptInitialization();
        }
    }, 3000);
}

main();