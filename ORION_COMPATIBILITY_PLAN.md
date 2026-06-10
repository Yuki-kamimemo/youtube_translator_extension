# Orion Browser対応改修計画

## 作成目的

この計画書は、現在Chrome拡張機能として実装されているYouTube Live Chat Enhancerを、iPadOS/iOS向けOrion Browserでも安定して動作させるための改修方針を整理するために作成した。

Orion BrowserはChrome拡張機能とFirefox拡張機能の利用をうたっているが、WebKit上にWebExtensions APIを独自実装しているブラウザであり、特にiOS/iPadOS版では対応APIに制限がある。そのため、Chrome Manifest V3で動作している現在の実装をそのまま前提にすると、background service worker、`chrome.tabs`、`chrome.alarms`、`chrome.storage.sync`、拡張内HTMLのiframe表示、YouTubeのモバイルDOM、localhost向けLM Studio連携などが不安定要因になり得る。

本計画の目的は、Chrome版の既存動作を壊さず、Orion Browserでは利用可能な機能を段階的に有効化し、利用できない機能は明示的に縮退させることで、ユーザーが少なくともGoogle翻訳、フローコメント、基本設定保存を安定して使える状態にすることだ。

## 調査メモ

Orion公式FAQでは、OrionはWebExtensions APIをネイティブにサポートするが、対応は実験的で、約70%のWebExtensions APIに対応していると説明されている。

iOS/iPadOS版については、一部WebExtensionsの予備的サポートがあり、Chrome/Firefox拡張をインストールできる一方で、対応可能なAPI範囲には制限があるとされている。

OrionのWebExtensions API対応表では、`runtime.sendMessage`、`runtime.onMessage`、`runtime.getURL`、`tabs.sendMessage`、`tabs.getCurrent`、`storage`系など主要APIは一定程度対応している。ただし、iOS/iPadOSでは実装差、部分対応、WebKit制約、ブラウザ内蔵コンテンツブロッカーによるYouTube iframeや外部fetchへの影響を考慮する必要がある。

参考:

- https://browser.kagi.com/faq.html
- https://browser.kagi.com/WebExtensions-API-Support.html

## 現在の実装で想定される不安定要因

1. `background.js`がManifest V3のservice workerと`chrome.tabs`、`chrome.alarms`（キャッシュ掃除）に強く依存している。
2. content scriptからbackgroundへ翻訳依頼を送り、backgroundがGoogle翻訳またはLM Studioへfetchする構造になっている。翻訳の前処理（`preprocessForYouTubeChat`、ユーザー辞書）と後処理（`postprocessJapanese`）も`background.js`内にのみ存在する。
3. **フローコメントのデータ経路がbackground中継に依存している。** `chat_observer.js`（live_chat iframe側）が`runtime.sendMessage({ type: 'FLOW_COMMENT_DATA' })`でbackgroundへ送り、backgroundが`chrome.tabs.sendMessage(sender.tab.id)`でwatchページへ折り返す構造。service workerの起床と`tabs.sendMessage`の両方が動かないと弾幕が一切流れない。`toggleSettingsPanel`（popup iframe→親ページ）も同じ折り返し構造。
4. `getTabId`で取得したタブIDを使い、`tabState_${tabId}`としてON/OFF状態を保存している。`content_script.js`、`chat_observer.js`、`popup.js`の3箇所が依存。
5. 設定パネルは`chrome.runtime.getURL('popup.html')`で取得した拡張ページをYouTubeページ上のiframeに表示している。iOS系WebKitでは拡張オリジンのページをWebページ内iframeに埋め込めない可能性がある。
6. `chrome.storage.sync`を主設定保存先として使っているが、Orionでは部分対応または環境差がある可能性がある。
7. LM Studio連携は`http://localhost:1234`固定で、iOS/iPadOS上では実用上ほぼ期待できない。
8. `m.youtube.com`やiPadOSのYouTube表示では、`#movie_player`やSPAナビゲーションイベントがChrome desktopと異なる可能性がある。また`m.youtube.com`親ページからの hidden iframe（`www.youtube.com/live_chat`）はクロスオリジンになる。

## 改修方針

Orion専用の分岐を各所に散らすのではなく、まず拡張APIと環境差を吸収する層を作る。その上で、機能単位に「使える場合は使う、失敗したら縮退する」構造へ変更する。

最大の構造改善は、**フレーム間通信（弾幕データ・パネル開閉・設定更新通知）をbackground折り返しから`window.postMessage`直結へ変更する**ことだ。hidden live_chat iframeとpopup iframeはどちらもwatchページ自身が生成する子フレームであり、`window.parent.postMessage`で直接届く。これによりOrionで最も不安定なservice worker＋`tabs.sendMessage`への依存が弾幕のコア経路から消え、Chrome版でもservice worker起床待ちがなくなりレイテンシが下がる。backgroundの責務は「翻訳APIの呼び出しとキャッシュ」だけに縮小する。

Chrome desktopでは既存の動作を維持する。Orion macOSでは可能な限りChrome版と同等に動かす。Orion iOS/iPadOSではGoogle翻訳、フローコメント、基本設定保存を優先し、LM Studioや高度な設定UIは非対応または限定対応として扱う。

## 実装計画

### 1. WebExtensions互換レイヤーを追加する

`extension_api.js`を追加し、`chrome`と`browser`の差異、callback APIとPromise APIの差異、`runtime.lastError`の扱いを吸収する。

主な提供関数:

- `ylcApi.sendMessage(message)` — 失敗時はrejectでなく`{ ok: false, reason }`を返し、呼び出し側のフォールバック分岐を単純にする
- `ylcApi.storageGet(defaultsOrKeys)` / `ylcApi.storageSet(values)` / `ylcApi.storageRemove(keys)`
- `ylcApi.getRuntimeUrl(path)`
- `ylcApi.hasRuntime()`
- `ylcApi.onStorageChanged(callback)`

storage系はエリア（sync/local）を呼び出し側に選ばせず、レイヤー内で解決する（計画5参照）。

`manifest.json`では、watchページとlive_chatページの両方で`extension_api.js`を最初に読み込む。

backgroundの`chrome.alarms`によるキャッシュ掃除は、alarms未対応環境に備えて「翻訳リクエスト処理時に期限切れエントリを間引く」方式を併用する（alarmsが動けば従来通り、動かなくても肥大しない）。

### 2. フレーム間通信をpostMessage直結にする

background折り返しに依存している3つの経路を`window.postMessage`へ移行する。

- `FLOW_COMMENT_DATA`: `chat_observer.js`から`window.parent.postMessage({ source: 'ylc-enhancer', type: 'FLOW_COMMENT_DATA', data }, '*')`で送り、watchページ側の`content_script.js`が`message`イベントで受ける。
- `toggleSettingsPanel`: popup iframeから親ページへ同様に直接送る。`chrome.action.onClicked`（ツールバーアイコン）経由の開閉だけはbackground経由を残す。
- 設定更新通知: 設定保存後にwatchページからhidden iframeへ`iframe.contentWindow.postMessage`で明示通知する（計画5の`storage.onChanged`不安定対策と兼ねる）。

セキュリティ要件:

- 受信側は`event.origin`を`https://www.youtube.com`と`https://m.youtube.com`の許可リストで検証する。
- メッセージに`source: 'ylc-enhancer'`のマーカーを付け、他スクリプトのpostMessageと区別する。
- 受信データは既存の`FLOW_COMMENT_DATA`処理と同じ検証・上限・XSS対策を通す（ページ上の任意スクリプトが弾幕を注入できる前提で、テキストとして扱い長さ上限を課す）。

`m.youtube.com`親ページと`www.youtube.com/live_chat` iframeはクロスオリジンだが、postMessageはクロスオリジンで設計通り動くため問題ない。

互換のため、postMessage受信が確認できない場合（旧構成や予期しない環境）は既存のbackground折り返しを残してフォールバックとして使う。

### 3. 環境判定を機能単位で追加する

ブラウザ名だけで判定せず、機能可用性を中心に判定する。

追加する判定:

- iOS/iPadOS相当か
- Orionらしい環境か
- background中継が使えるか（起動時に`getTabId`応答の成否で実測する）
- 拡張ページiframeが使えるか（iframeの`load`成否で実測する）
- hidden live_chat iframeが作成できるか
- localhost LM Studio連携を有効にしてよいか

この判定結果は`ylcCapabilities`のようなグローバルにまとめ、content script、popup、backgroundで参照する。UA文字列による事前判定は補助とし、実測结果を優先する。

### 4. background翻訳のフォールバックを作る

現在はcontent scriptから`chrome.runtime.sendMessage({ action: "translate" })`でbackgroundへ翻訳を依頼している。

Orion iOS/iPadOSでbackground中継が不安定な場合に備えて、Google翻訳だけはcontent script側でも実行できるようにする。

方針:

- 通常はbackground翻訳を使う（キャッシュ・重複排除が効くため）。
- `runtime.sendMessage`が失敗した場合、Google翻訳のみcontent scriptから直接fetchする。
- LM Studioはbackground経由のみとし、Orion iOS/iPadOSでは無効化する。
- 翻訳失敗時は短時間の失敗キャッシュを持ち、同じコメントを連続再試行しない。

前提整備（重要）:

- `preprocessForYouTubeChat`、`preprocessWithDictionary`、`postprocessJapanese`は現在`background.js`内にのみある。直接fetchフォールバックが「前処理なしの劣化翻訳」にならないよう、これらを`translation.js`（全コンテキストで読込済）へ抽出し、backgroundとcontent scriptで共有する。スラング辞書JSONの取得も`runtime.getURL`ベースで両文脈から読めるようにする。
- content script側フォールバックにも小さなキャッシュ（数百件程度）を持たせ、background不在時の重複fetchを抑える。

CORSリスク（要検証）:

MV3ではcontent scriptのfetchはページのCORS制約下にある（拡張のhost_permissionsでは回避できない）。`translate.googleapis.com`のgtxエンドポイントがCORSヘッダを返すか、およびOrionのcontent script fetchの扱いを、実装前にOrion実機で最初に検証する。**この検証が失敗した場合、iOS/iPadOSでの翻訳はbackground経由が唯一の経路となり、本計画の縮退ラインが変わる**ため、Phase 2の最初に行う。

### 5. 設定保存のストレージ解決を互換レイヤーに集約する

呼び出し側で多段マージするのではなく、`extension_api.js`内で保存先エリアを一度だけ解決する。

- 起動時に`storage.sync`へプローブ書き込みし、成功すれば`sync`、失敗すれば`local`を利用エリアとする。
- エリアが`local`に決まった環境では、初回に`sync`の既存値が読めれば`local`へ一回だけマイグレーションする。
- 以後の`storageGet`/`storageSet`は解決済みエリアだけを使う。呼び出し側は従来通り「デフォルト→保存値→タブ/セッション固有状態」の単純な順で読む。

`storage.onChanged`が不安定な環境に備え、設定保存後にwatchページとlive_chatページへ明示的な設定更新メッセージを送る（計画2のpostMessage経路を使う）。

### 6. タブID依存を緩和する

`getTabId`が取得できない環境に備え、タブ固有状態の保存キーにフォールバックを持たせる。

優先順:

1. `tabState_${tabId}`
2. `sessionState_${videoId}`（watchページはURLの`v`パラメータ、live_chat iframeも自身のURLの`v`パラメータから取得できるため、親子で同じキーに到達できる）
3. `globalState`

watchページ・hidden iframe・popup iframeの3者が同じキー階層を参照するよう、解決ロジックは`extension_api.js`に置く。

`chrome.tabs.onRemoved`による掃除が動かない場合でも古い状態が残り続けないよう、保存値に`updatedAt`を付け、一定期間を過ぎたものを読み込み時に破棄する。

### 7. 設定パネルiframeのフォールバックを用意する

ChromeとOrion macOSでは既存の`popup.html` iframe表示を維持する。

Orion iOS/iPadOSでiframe表示が失敗する場合の第一フォールバックは、**既存`popup.html`を`action.default_popup`（ツールバーポップアップ）としても使えるようにする**ことだ。軽量パネルをDOMで再実装するよりも、既存`popup.js`の資産をそのまま使えて二重実装を避けられる。

そのために必要な`popup.js`の改修:

- 実行文脈の自己判定（親フレームがYouTubeページのiframeか、ツールバーポップアップか）。
- ポップアップ文脈では`getTabId`（`sender.tab`依存）が効かないため、`tabs.query({ active: true, currentWindow: true })`→失敗時は`sessionState`/`globalState`フォールバックでタブ状態を解決する。
- ポップアップ文脈ではLM Studio管理UIを`ylcCapabilities`に従って非表示にする。

`default_popup`も使えない環境が確認された場合に限り、最終手段としてcontent script内の軽量DOMパネル（インライン翻訳ON/OFF、フローコメントON/OFF、フォントサイズ、フロー速度の4項目程度）を実装する。最初から作り込まない。

### 8. YouTube mobile DOMへの耐性を上げる

`#movie_player`が見つからない場合の代替セレクタを追加する。

候補:

- `#movie_player`
- `.html5-video-player`
- `ytd-player`
- `video`の親要素から最も近いプレーヤー相当コンテナ

セレクタだけでなくSPAナビゲーションの検知も差異がある。`yt-navigate-finish`が発火しない環境に備え、URL変化のポーリングまたは`Navigation API`/`popstate`ベースの補助検知を追加する。

live_chatについても、hidden iframe作成だけに依存せず、既存のチャットiframeがあればそれを優先して監視する（`chat_observer.js`は`all_frames: true`で注入されるため、可視チャットiframeでもそのまま動く。重複防止として、watchページ側で「どのフレームの`FLOW_COMMENT_DATA`を採用するか」を1つに固定する）。

hidden iframe作成に失敗した場合は、フローコメント不可として明示的に縮退し、インライン翻訳だけを維持する。

### 9. Orion向けの診断表示を追加する

設定パネル内または簡易ログに、現在の機能状態を表示できるようにする。

表示項目:

- background通信の可否
- storage保存先（sync / localフォールバック中）
- Google翻訳fetchの可否（background経由 / 直接fetch）
- LM Studio使用可否
- hidden live_chat iframe作成可否
- 設定パネルの表示方式（ページ内iframe / ツールバーポップアップ / 軽量パネル）

ユーザーがOrion上で「動かない」と感じた時に、どの機能が縮退しているか判断できるようにする。

### 10. manifestを最小変更する

権限やhost_permissionsは原則増やさない。

変更予定:

- `extension_api.js`を両content scriptの読み込み順の先頭に追加する。
- `action.default_popup`に`popup.html`を設定する（計画7）。Chrome desktopでは従来の`action.onClicked`→ページ内パネル開閉が使えなくなるため、`popup.html`側からアクティブタブへ開閉メッセージを送る形に揃えるか、ポップアップ自体を設定UIとして完結させるかをPhase 3で決める。
- `background`に`service_worker`と併記で`scripts`（event page型）を宣言する。Safari/Firefox系実装は`scripts`を読むため、クロスブラウザMV3の定石。Chromeは`service_worker`を優先するので既存動作に影響しない。
- `web_accessible_resources`は既存の`popup.html`、`popup.js`を維持し、追加が必要な場合だけ最小限にする。

### 11. テストと確認を行う

既存Nodeテスト:

```powershell
node tests\flow_emoji_fallback.test.js
```

ローカル確認:

1. Chrome desktopで既存機能の回帰確認をする。特にpostMessage化後の弾幕表示・パネル開閉・設定即時反映。
2. Orion macOSで拡張を読み込み、設定パネル、Google翻訳、フローコメントを確認する。
3. Orion iPadOS/iOSでGoogle翻訳、フローコメント、設定保存、縮退表示を確認する。
4. LM StudioはChrome desktopとOrion macOSのみ確認対象とし、iOS/iPadOSでは非対応表示を確認する。
5. `m.youtube.com`（Chrome devtoolsのモバイルエミュレーションとOrion iPadOS実機）でプレーヤー検出とクロスオリジンpostMessageを確認する。

## 優先順位

### Phase 1: 基盤互換化

- `extension_api.js`追加（storage解決・sendMessage安全化・alarmsフォールバック含む）
- manifest読み込み順変更・`background.scripts`併記
- タブID取得失敗時のフォールバック

### Phase 2: 通信・翻訳経路の安定化

- **Orion実機でのGoogle翻訳直接fetch（CORS）検証 — 最初に行う**
- フレーム間通信のpostMessage直結化（弾幕・パネル開閉・設定更新通知）
- 前処理・後処理の`translation.js`への抽出と共有
- background翻訳失敗時のGoogle翻訳フォールバック
- LM StudioのiOS/iPadOS無効化
- 失敗キャッシュ追加

### Phase 3: UIとYouTube DOM対応

- `action.default_popup`によるポップアップ文脈対応
- 設定パネルiframe失敗時のフォールバック切替
- mobile/iPadOS向けプレーヤー検出・SPAナビゲーション補助検知
- hidden live_chat iframe失敗時の縮退

### Phase 4: 診断と検証

- Orion向け診断表示
- Chrome回帰確認
- Orion macOS確認
- Orion iOS/iPadOS確認

## 完了条件

- Chrome desktopで既存機能が壊れていない。
- Orion macOSでGoogle翻訳、フローコメント、設定パネル、設定保存が動作する。
- Orion iPadOS/iOSでGoogle翻訳、基本設定保存、可能な範囲のフローコメントが動作する。
- Orion iPadOS/iOSで使えない機能は無言で失敗せず、UI上で非対応または縮退状態が分かる。
- 弾幕データ経路がbackground service workerの生死に依存しない。
- 既存のXSS対策、翻訳キュー上限、フローコメントDOM上限、YouTube SPA対応を維持している。postMessage受信経路にもorigin検証・データ検証・上限を適用している。
