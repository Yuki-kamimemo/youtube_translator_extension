/**
 * content_script.js (Main)
 * 拡張機能のメインロジック、初期化、イベント監視
 * * ▼▽▼ 特殊メッセージ＆絵文字対応版 ▼▽▼
 */

// --- グローバル変数 ---
const IS_IN_IFRAME = (window.self !== window.top);
let settings = {};
let chatObserver = null;
let ngUserList = [];
let ngWordList = [];
let flowContainer = null; // flow.jsが使用するグローバル変数
let isInitialized = false; // 初期化状態を管理するフラグ
let initializationRetryTimer = null; // 初期化再試行のためのタイマー

// --- デフォルト設定 ---
const DEFAULTS = {
    translator: 'gemini', geminiApiKey: '', geminiApiKey2: '', deeplApiKey: '', enableInlineTranslation: true,
    enableGoogleTranslateFallback: true, enableFlowComments: true, flowContent: 'translation',
    flowTime: 8, fontSize: 24, opacity: 0.9, position: 'top_priority',
    strokeWidth: 1.5, strokeColor: '#000000',
    flowFontFamily: "'ヒラギノ角ゴ Pro W3', 'Hiragino Kaku Gothic Pro', 'メイリオ', Meiryo, sans-serif",
    customFontFamily: '', flowMarginTop: 10, flowMarginBottom: 10,
    normalColor: '#FFFFFF', memberColor: '#28a745', moderatorColor: '#007bff',
    superchatColor: '#FFFFFF',
    membershipColorFlow: '#00e676',
    dictionary: '',
    ngUsers: '', ngWords: '',
};

// --- ヘルパー関数 ---
function updateNgLists() {
    ngUserList = settings.ngUsers ? settings.ngUsers.split('\n').map(u => u.trim()).filter(Boolean) : [];
    ngWordList = settings.ngWords ? settings.ngWords.split('\n').map(w => w.trim()).filter(Boolean) : [];
}

function waitForElement(selector, parent = document, timeout = 15000) {
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
    
    // authorTypeの取得
    const authorTypeAttr = node.getAttribute('author-type');
    let userType = 'normal';
    if (authorTypeAttr === 'moderator') userType = 'moderator';
    else if (authorTypeAttr === 'member') userType = 'member';

    const baseComment = {
        html: '', text: '', userType: userType,
        authorName: authorEl ? authorEl.textContent || '' : '',
        specialType: null,
    };

    const tagName = node.tagName.toUpperCase();

    // 1. 通常コメント
    if (tagName === 'YT-LIVE-CHAT-TEXT-MESSAGE-RENDERER') {
        if (messageEl) {
            baseComment.html = messageEl.innerHTML;
            baseComment.text = messageEl.textContent || '';
            // 画像(絵文字)のみの場合、テキストが空になることがあるため補完
            if (!baseComment.text.trim() && messageEl.querySelector('img')) {
                 baseComment.text = ' '; // 空文字だとスキップされる可能性があるためスペースを入れる
            }
        }
    } 
    // 2. スーパーチャット (赤スパなど)
    else if (tagName === 'YT-LIVE-CHAT-PAID-MESSAGE-RENDERER') {
        const purchaseAmountEl = node.querySelector('#purchase-amount');
        if (messageEl) {
            baseComment.html = messageEl.innerHTML;
            baseComment.text = messageEl.textContent || '';
        }
        baseComment.specialType = 'superchat';
        baseComment.purchaseAmount = purchaseAmountEl ? purchaseAmountEl.textContent.trim() : '';
        baseComment.bgColor = node.style.getPropertyValue('--yt-live-chat-paid-message-primary-color') || '#ff0000';
    } 
    // 3. メンバーシップ加入/更新
    else if (tagName === 'YT-LIVE-CHAT-MEMBERSHIP-ITEM-RENDERER') {
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
    }
    // 4. スーパーステッカー (投げ銭スタンプ) ★追加
    else if (tagName === 'YT-LIVE-CHAT-PAID-STICKER-RENDERER') {
        const purchaseAmountEl = node.querySelector('#purchase-amount-chip');
        const stickerImg = node.querySelector('#sticker > img');
        
        baseComment.specialType = 'superchat'; // フロー上はスパチャと同じ扱いでOK
        baseComment.purchaseAmount = purchaseAmountEl ? purchaseAmountEl.textContent.trim() : '';
        baseComment.bgColor = node.style.getPropertyValue('--yt-live-chat-paid-sticker-background-color') || '#ff0000';
        
        if (stickerImg) {
            // ステッカー画像を大きく表示するためのHTMLを生成
            baseComment.html = `<img src="${stickerImg.src}" style="height: 80px; width: auto; vertical-align: middle;">`;
            baseComment.text = '[Super Sticker]';
        }
    }
    // 5. メンバーシップギフト購入 ★追加
    else if (tagName === 'YT-LIVE-CHAT-MEMBERSHIP-GIFT-PURCHASE-RENDERER') {
        const headerEl = node.querySelector('#header');
        const giftImg = node.querySelector('#gift-image > img');
        
        baseComment.specialType = 'membership';
        baseComment.html = (headerEl ? headerEl.innerHTML : '') + (giftImg ? `<br><img src="${giftImg.src}" style="height: 1.5em; vertical-align: middle;">` : '');
        baseComment.text = headerEl ? headerEl.textContent : '[Gift Purchase]';
    }
    // 6. ギフト受け取り (ログが大量に出るので不要なら外しても良い) ★追加
    else if (tagName === 'YT-LIVE-CHAT-GIFT-MEMBERSHIP-RECEIVED-RENDERER') {
        const msgEl = node.querySelector('#message');
        baseComment.specialType = 'membership';
        baseComment.html = msgEl ? msgEl.innerHTML : '';
        baseComment.text = msgEl ? msgEl.textContent : '[Gift Received]';
    }

    // HTMLもテキストもなければ無効
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

    // テキストが存在し、かつ画像のみのメッセージ（[Super Sticker]など）でない場合に翻訳を実行
    // ※ [Super Sticker] などのプレースホルダーは翻訳APIに送らないようにする
    const shouldTranslate = settings.enableInlineTranslation && comment.text && !comment.text.startsWith('[') && !comment.text.startsWith('<');

    if (shouldTranslate) {
        requestTranslation(comment.text, (result) => {
            if (result.error) {
                displayInlineTranslation(node, `[${result.error}]`, true);
            } else if (result.translation) {
                displayInlineTranslation(node, result.translation);
            }
            sendToFlow(result.translation || '');
        });
    } else {
        // 翻訳しない場合（絵文字のみ、ステッカー、ギフトなど）もフローに送る
        sendToFlow('');
    }
}

function startChatObserver(chatItemsEl) {
    if (chatObserver) chatObserver.disconnect();
    
    // ★変更: 監視対象タグを追加
    const targetNodeTypes = [
        'YT-LIVE-CHAT-TEXT-MESSAGE-RENDERER',
        'YT-LIVE-CHAT-PAID-MESSAGE-RENDERER',
        'YT-LIVE-CHAT-MEMBERSHIP-ITEM-RENDERER',
        'YT-LIVE-CHAT-PAID-STICKER-RENDERER',           // ★追加
        'YT-LIVE-CHAT-MEMBERSHIP-GIFT-PURCHASE-RENDERER', // ★追加
        'YT-LIVE-CHAT-GIFT-MEMBERSHIP-RECEIVED-RENDERER'  // ★追加
    ];

    chatObserver = new MutationObserver(mutations => {
        mutations.forEach(m => m.addedNodes.forEach(node => {
            if (node.nodeType === 1 && targetNodeTypes.includes(node.tagName.toUpperCase())) { // ★変更: toUpperCaseで安全に比較
                processNewCommentNode(node);
            }
        }));
    });
    chatObserver.observe(chatItemsEl, { childList: true });
    console.log('[YLC Enhancer] Chat observer started.');
}

// --- 初期化 ---
async function initializeIframe() {
    if (isInitialized) return;
    
    try {
        const chatApp = await waitForElement('yt-live-chat-app');
        const header = await waitForElement('yt-live-chat-header-renderer', chatApp);
        
        let controls = document.getElementById('enhancer-controls');
        if (!controls) {
            controls = document.createElement('div');
            controls.id = 'enhancer-controls';
            header.after(controls); 
            
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
        isInitialized = true; 
        clearInterval(initializationRetryTimer); 
        console.log('[YLC Enhancer] Iframe initialized successfully.');
    } catch (error) {
        console.error('[YLC Enhancer] Iframe initialization failed:', error);
        isInitialized = false; 
    }
}

async function initializeTopLevel() {
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
        isInitialized = true; 
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
        let reInitRequired = false; 
        for (let key in changes) {
            settings[key] = changes[key].newValue;
            if (key === 'ngUsers' || key === 'ngWords') ngListsChanged = true;

            if (key === 'enableInlineTranslation' || key === 'enableFlowComments') {
                reInitRequired = true;
            }
        }
        if (ngListsChanged) updateNgLists();
        
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
        if (!isInitialized) {
            if (IS_IN_IFRAME && location.pathname.startsWith('/live_chat')) {
                initializeIframe();
            } else if (!IS_IN_IFRAME) {
                initializeTopLevel();
            }
        }

        if (isInitialized && initializationRetryTimer) {
            console.log('[YLC Enhancer] Initialization successful, stopping retry timer.');
            clearInterval(initializationRetryTimer);
            initializationRetryTimer = null; 
        }
    };

    if (!IS_IN_IFRAME) {
        if (!window.ylcEnhancerMessageListener) {
            window.ylcEnhancerMessageListener = true;
            chrome.runtime.onMessage.addListener(req => {
                if (req.type === 'FLOW_COMMENT_DATA') { flowComment(req.data); }
                else if (req.action === 'toggleSettingsPanel') { toggleSettingsPanel(); }
            });
        }

        if (!window.ylcNavigateListener) {
            window.ylcNavigateListener = true;
            document.body.addEventListener('yt-navigate-finish', () => {
                console.log('[YLC Enhancer] Page navigation detected. Re-initializing...');
                isInitialized = false;
                if (initializationRetryTimer) {
                    clearInterval(initializationRetryTimer);
                }
                initializationRetryTimer = setInterval(attemptInitialization, 2000);
            });
        }
    }

    initializationRetryTimer = setInterval(attemptInitialization, 2000);
}

main();