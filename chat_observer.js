/**
 * chat_observer.js
 * live_chat iframe 専用の最小スクリプト
 * チャット監視・翻訳キュー・親への FLOW_COMMENT_DATA 送信のみを担う
 */

let settings = {};
let chatObserver = null;
let ngUserList = [];
let ngWordList = [];
let isInitialized = false;
let isInitializing = false;
let initializationRetryTimer = null;
let stateKey = null;
// 親からYLC_FRAME_MODEで通知される。trueなら自分は不可視のhidden iframeであり、
// インライン翻訳のDOM挿入は誰にも見えないため行わない
let isHiddenObserver = false;
let pageStateGeneration = 0;
const managedTimeouts = new Set();

const DEFAULTS = {
    enableInlineTranslation: true,
    enableFlowComments: true,
    enableGoogleTranslateFallback: true,
    flowContent: 'translation',
    dictionary: '',
    ngUsers: '',
    ngWords: '',
};

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
            reject(new Error(`Element not found: ${selector}`));
        }, timeout);

        observer.observe(parent.documentElement || parent, { childList: true, subtree: true });
    });
}

function parseComment(node) {
    const authorEl = node.querySelector('#author-name');
    const messageEl = node.querySelector('#message');

    const authorTypeAttr = node.getAttribute('author-type');
    let userType = 'normal';
    if (authorTypeAttr === 'moderator') userType = 'moderator';
    else if (authorTypeAttr === 'member') userType = 'member';

    const baseComment = {
        id: node.id || '',
        html: '', text: '', userType: userType,
        authorName: authorEl ? authorEl.textContent || '' : '',
        specialType: null,
    };

    const tagName = node.tagName.toUpperCase();

    if (tagName === 'YT-LIVE-CHAT-TEXT-MESSAGE-RENDERER') {
        if (messageEl) {
            baseComment.html = messageEl.innerHTML;
            baseComment.text = messageEl.textContent || '';
            if (!baseComment.text.trim() && messageEl.querySelector('img')) {
                baseComment.text = ' ';
            }
        }
    } else if (tagName === 'YT-LIVE-CHAT-PAID-MESSAGE-RENDERER') {
        const purchaseAmountEl = node.querySelector('#purchase-amount');
        if (messageEl) {
            baseComment.html = messageEl.innerHTML;
            baseComment.text = messageEl.textContent || '';
        }
        baseComment.specialType = 'superchat';
        baseComment.purchaseAmount = purchaseAmountEl ? purchaseAmountEl.textContent.trim() : '';
        baseComment.bgColor = node.style.getPropertyValue('--yt-live-chat-paid-message-primary-color') || '#ff0000';
    } else if (tagName === 'YT-LIVE-CHAT-MEMBERSHIP-ITEM-RENDERER') {
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
    } else if (tagName === 'YT-LIVE-CHAT-PAID-STICKER-RENDERER') {
        const purchaseAmountEl = node.querySelector('#purchase-amount-chip');
        const stickerImg = node.querySelector('#sticker > img');

        baseComment.specialType = 'superchat';
        baseComment.purchaseAmount = purchaseAmountEl ? purchaseAmountEl.textContent.trim() : '';
        baseComment.bgColor = node.style.getPropertyValue('--yt-live-chat-paid-sticker-background-color') || '#ff0000';

        if (stickerImg) {
            baseComment.html = `<img src="${stickerImg.src}">`;
            baseComment.text = '[Super Sticker]';
        }
    } else if (tagName === 'YT-LIVE-CHAT-MEMBERSHIP-GIFT-PURCHASE-RENDERER') {
        const headerEl = node.querySelector('#header');
        const giftImg = node.querySelector('#gift-image > img');

        baseComment.specialType = 'membership';
        baseComment.html = (headerEl ? headerEl.innerHTML : '') + (giftImg ? `<br><img src="${giftImg.src}">` : '');
        baseComment.text = headerEl ? headerEl.textContent : '[Gift Purchase]';
    } else if (tagName === 'YT-LIVE-CHAT-GIFT-MEMBERSHIP-RECEIVED-RENDERER') {
        const msgEl = node.querySelector('#message');
        baseComment.specialType = 'membership';
        baseComment.html = msgEl ? msgEl.innerHTML : '';
        baseComment.text = msgEl ? msgEl.textContent : '[Gift Received]';
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

const translatedNodes = [];
const MAX_TRANSLATED_NODES = 120;

function displayInlineTranslation(node, text, isError = false) {
    const messageEl = node.querySelector('#message');
    if (!messageEl) return;
    const transEl = document.createElement('div');
    transEl.className = 'ylc-inline-translation';
    transEl.textContent = text;
    transEl.style.color = isError ? '#ff4e4e' : '#3ea6ff';
    transEl.style.fontSize = '0.9em';
    transEl.style.marginTop = '2px';
    messageEl.appendChild(transEl);

    translatedNodes.push(node);
    while (translatedNodes.length > MAX_TRANSLATED_NODES) {
        const oldNode = translatedNodes.shift();
        const oldTrans = oldNode?.querySelector('.ylc-inline-translation');
        if (oldTrans) oldTrans.remove();
    }
}

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
        if (!settings.enableFlowComments) return;
        comment.translated = translatedText;
        // 親ページへ直接postMessage（service worker非依存の主経路）。
        // 親がYouTubeページと確認できない場合のみ従来のbackground中継を使う
        if (ylcApi.postToParent({ type: 'FLOW_COMMENT_DATA', data: comment })) return;
        ylcApi.sendMessage({ type: 'FLOW_COMMENT_DATA', data: comment });
    };

    const hasJapanese = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/.test(comment.text);
    const hasForeignCharacters = /[a-zA-Z0-9\uac00-\ud7a3\u0400-\u04ff\u0e00-\u0e7f\xc0-\u017f]/.test(comment.text);

    // この文脈で翻訳が必要か:
    // - 可視iframe: インライン表示用（従来どおり）
    // - hidden iframe: フローに翻訳を載せる設定（translation/both）のときだけ
    const needsTranslationHere = isHiddenObserver
        ? (settings.enableFlowComments && settings.flowContent !== 'original')
        : settings.enableInlineTranslation;

    const shouldTranslate = needsTranslationHere &&
        comment.text &&
        !comment.text.startsWith('[') &&
        !comment.text.startsWith('<') &&
        !hasJapanese &&
        hasForeignCharacters &&
        !shouldSkipTranslation(comment.text);

    if (shouldTranslate) {
        enqueueTranslation(comment.text, (result) => {
            if (!isHiddenObserver) {
                if (result && result.error) {
                    displayInlineTranslation(node, `[${result.error}]`, true);
                } else if (result && result.translation) {
                    displayInlineTranslation(node, result.translation);
                }
            }
            sendToFlow(result ? result.translation : '');
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
        'YT-LIVE-CHAT-PAID-STICKER-RENDERER',
        'YT-LIVE-CHAT-MEMBERSHIP-GIFT-PURCHASE-RENDERER',
        'YT-LIVE-CHAT-GIFT-MEMBERSHIP-RECEIVED-RENDERER'
    ];

    const MAX_BURST_COMMENTS = 5;

    chatObserver = new MutationObserver(mutations => {
        // タブ非表示中は解析・翻訳とも無意味（ライブチャットは追いかけ再生しない）
        if (document.hidden) return;
        const allAddedNodes = [];
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType === 1 && targetNodeTypes.includes(node.tagName.toUpperCase())) {
                    allAddedNodes.push(node);
                }
            }
        }

        if (allAddedNodes.length === 0) return;

        let nodesToProcess = allAddedNodes;
        if (allAddedNodes.length > MAX_BURST_COMMENTS) {
            nodesToProcess = allAddedNodes.slice(-MAX_BURST_COMMENTS);
        }

        nodesToProcess.forEach(node => {
            processNewCommentNode(node);
        });
    });
    chatObserver.observe(chatItemsEl, { childList: true });
}

const translationQueue = [];
let translationActive = 0;
const MAX_CONCURRENT_TRANSLATIONS = 3;
const MAX_QUEUE_SIZE = 50;
const THROTTLE_INTERVAL = 50;

function setManagedTimeout(callback, delay) {
    const id = setTimeout(() => {
        managedTimeouts.delete(id);
        callback();
    }, delay);
    managedTimeouts.add(id);
    return id;
}

function clearManagedTimeouts() {
    for (const id of managedTimeouts) clearTimeout(id);
    managedTimeouts.clear();
}

function enqueueTranslation(text, callback) {
    if (translationQueue.length >= MAX_QUEUE_SIZE) {
        translationQueue.shift();
    }
    translationQueue.push({ text, callback });
    processTranslationQueue();
}

function processTranslationQueue() {
    while (translationActive < MAX_CONCURRENT_TRANSLATIONS && translationQueue.length > 0) {
        const { text, callback } = translationQueue.shift();
        // 直近で失敗したテキストは連続再試行しない
        if (isRecentlyFailedTranslation(text)) {
            callback({ error: '翻訳エラー' });
            continue;
        }
        // 同一テキストの再翻訳はSWを起こさずローカルキャッシュで返す
        const cached = getCachedTranslation(text);
        if (cached) {
            callback({ translation: cached });
            continue;
        }
        translationActive++;
        ylcApi.sendMessage({ action: "translate", text }).then(async (messageResult) => {
            let result;
            if (messageResult.ok && messageResult.data) {
                result = messageResult.data;
            } else {
                // background不達時はGoogle翻訳のみcontent scriptから直接実行する
                result = await translateDirectWithGoogle(text, settings.dictionary);
            }
            translationActive--;
            if (result && result.error) markTranslationFailed(text);
            if (result && result.translation) cacheTranslation(text, result.translation);
            callback(result);
            if (translationQueue.length > 0) {
                setManagedTimeout(processTranslationQueue, THROTTLE_INTERVAL);
            }
        });
    }
}

async function initializeIframe() {
    if (isInitialized || isInitializing) return;
    isInitializing = true;
    const generation = pageStateGeneration;

    try {
        const chatApp = await waitForElement('yt-live-chat-app');
        if (generation !== pageStateGeneration || !location.pathname.startsWith('/live_chat')) return;
        const items = await waitForElement('#items.yt-live-chat-item-list-renderer', chatApp);
        if (generation !== pageStateGeneration || !location.pathname.startsWith('/live_chat')) return;
        startChatObserver(items);
        isInitialized = true;
        // 親ページへ監視開始を通知。届かない環境では親側が直接監視フォールバックへ移行する
        ylcApi.postToParent({ type: 'YLC_OBSERVER_READY', stage: 'observing' });
        if (initializationRetryTimer) {
            clearInterval(initializationRetryTimer);
            initializationRetryTimer = null;
        }
    } catch (error) {
        isInitialized = false;
    } finally {
        isInitializing = false;
    }
}

async function main() {
    if (window.ylcEnhancerLoaded) return;
    window.ylcEnhancerLoaded = true;

    // スクリプトがこのiframeに注入されたことを親ページへ通知する
    ylcApi.postToParent({ type: 'YLC_OBSERVER_READY', stage: 'loaded' });

    try {
        stateKey = await ylcApi.resolveStateKey();

        const loadedSettings = await ylcApi.settingsGet(DEFAULTS);
        Object.assign(settings, loadedSettings);

        const tabState = await ylcApi.readTabState(stateKey);
        if (tabState.enableInlineTranslation !== undefined) settings.enableInlineTranslation = tabState.enableInlineTranslation;
        if (tabState.enableFlowComments !== undefined) settings.enableFlowComments = tabState.enableFlowComments;

        updateNgLists();
    } catch (e) {
        console.error('[YLC Enhancer/iframe] Failed to load settings:', e);
        return;
    }

    ylcApi.onStorageChanged((changes, area) => {
        let ngListsChanged = false;

        // 設定エリアはsync不可環境ではlocalに切り替わるため、解決済みエリア名で判定する
        if (area === ylcApi.settingsAreaName()) {
            for (const key in changes) {
                if (ylcApi.isInternalKey(key)) continue;
                if (key !== 'enableInlineTranslation' && key !== 'enableFlowComments') {
                    settings[key] = changes[key].newValue;
                }
                if (key === 'ngUsers' || key === 'ngWords') ngListsChanged = true;
            }
        }

        if (area === 'local' && stateKey && changes[stateKey]) {
            const newTabState = changes[stateKey].newValue || {};
            if (newTabState.enableInlineTranslation !== undefined) {
                settings.enableInlineTranslation = newTabState.enableInlineTranslation;
            }
            if (newTabState.enableFlowComments !== undefined) {
                settings.enableFlowComments = newTabState.enableFlowComments;
            }
        }

        if (ngListsChanged) updateNgLists();
    });

    // storage.onChangedが不安定な環境向け: 親ページからの明示的な設定更新通知を受ける
    ylcApi.onFrameMessage((message) => {
        if (message.type === 'YLC_FRAME_MODE') {
            isHiddenObserver = message.hiddenObserver === true;
            return;
        }
        if (message.type !== 'YLC_SETTINGS_SAVED') return;
        if (message.settings && typeof message.settings === 'object') {
            for (const key in message.settings) {
                if (key !== 'enableInlineTranslation' && key !== 'enableFlowComments') {
                    settings[key] = message.settings[key];
                }
            }
            updateNgLists();
        }
        if (message.tabState && typeof message.tabState === 'object') {
            if (message.tabState.enableInlineTranslation !== undefined) {
                settings.enableInlineTranslation = message.tabState.enableInlineTranslation;
            }
            if (message.tabState.enableFlowComments !== undefined) {
                settings.enableFlowComments = message.tabState.enableFlowComments;
            }
        }
    });

    const INIT_RETRY_MAX_ATTEMPTS = 15; // live_chatページで#itemsが出ないまま回り続けない
    let initAttempts = 0;
    const attemptInitialization = () => {
        initAttempts++;
        if (isInitialized || initAttempts > INIT_RETRY_MAX_ATTEMPTS) {
            if (initializationRetryTimer) {
                clearInterval(initializationRetryTimer);
                initializationRetryTimer = null;
            }
            return;
        }
        if (location.pathname.startsWith('/live_chat')) {
            initializeIframe();
        }
    };

    initializationRetryTimer = setInterval(attemptInitialization, 2000);
    attemptInitialization();
}

window.addEventListener('pagehide', () => {
    pageStateGeneration++;
    if (chatObserver) {
        chatObserver.disconnect();
        chatObserver = null;
    }
    if (initializationRetryTimer) {
        clearInterval(initializationRetryTimer);
        initializationRetryTimer = null;
    }
    clearManagedTimeouts();
    translationQueue.length = 0;
});

main();
