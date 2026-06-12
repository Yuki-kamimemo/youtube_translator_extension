# モバイル設定パネル不具合 修正計画書

作成日: 2026-06-12

## 背景

YouTubeライブチャット翻訳拡張機能において、モバイル環境でのみ、動画内の設定ボタン(歯車アイコン)タップ時に以下の不具合が発生している。

1. 設定パネル用の画面が新規タブで開いてしまう。
2. 同時に、元のYouTubeタブ側でも設定パネルが展開される。
3. 元タブ側のパネルは一切の操作を受け付けず、「×ボタンで閉じる」のみ機能する。

### 経緯

- 初期実装: 歯車タップで iframe によるページ内設定パネルを展開していたが、モバイルでうまく動作しなかった。
- 現在の実装: 「拡張機能アイコンからのポップアップは正常に動く」と判明したため、歯車タップ時も拡張アイコンと同等の挙動(popup.html をトップレベルで開く)を呼び出す形に改修した。

### ゴール

「拡張機能アイコン」と「画面内の歯車ボタン」で共通の設定パネル資産(HTML/JS)を使う仕様を維持したまま、以下を実現する。

1. 歯車タップ時に新規タブを開かない。
2. YouTubeを表示している同一タブ内に、正常に操作可能な設定パネルを開く。

---

## 1. 原因の分析

### 不具合1・2「新規タブが開く」かつ「元のタブでもパネルが展開される」 — 原因確定

`content_script.js` の `toggleSettingsPanel()` (256〜280行付近)の実装に起因する。

- モバイル判定(`window.innerWidth <= 768` かつ coarse pointer)が真のとき、`openSettingsAsTopLevelPage()` が `window.open(popup.html, '_blank', 'noopener')` を実行する。「拡張アイコンと同じ挙動」を「popup.html をトップレベルページとして開く」ことで実現しようとした結果であり、**新規タブが開くのは現在の実装そのものの仕様**(不具合1)。
- さらに HTML 仕様上、**`window.open` の features に `'noopener'` を指定すると、ウィンドウが正常に開けても戻り値は必ず `null`** になる。そのため `return !!opened;` が常に `false` を返し、`if (... && openSettingsAsTopLevelPage()) return;` を素通りして、フォールバックの `createSettingsPanel()`(ページ内 iframe パネル)も同時に実行される。これが二重表示の正体(不具合2)。ブラウザのバグではなく仕様どおりの動作。

### 不具合3「元タブ側のパネルが操作不能(×だけ効く)」

元タブに出るパネルは、**初期実装で「うまく動作しなかった」iframe 方式のパネルがフォールバックとして発動したもの**。

有力な仮説(要実機確認):

- `ORION_COMPATIBILITY_PLAN.md` に記録済みのとおり、**iOS系WebKit(Orion iOS/iPadOS等)では、拡張機能オリジンのページをWebページ内のiframeに埋め込むこと自体が制限されている**可能性が高い。iframe のドキュメントがロードに失敗する、またはロードされても拡張APIが機能しない状態になり、`popup.js` の初期化(storage probe → 親ページへの設定要求)が完了せず、UIが反応しない。
- 「×ボタンだけ効く」のは、×ボタンが iframe 内ではなく**親ページ(content script)側のヘッダーDOM**にあるためで、この仮説と整合する。
- 副次要因の候補として、スクロールロックが `body` に `touch-action: none` を設定する点もあるが、パネル側CSSで上書きされており主因ではないとみられる。

### なぜ「拡張機能アイコンからは正常に動く」のか

ツールバーポップアップ(`action.default_popup`)は**トップレベルの拡張ページ**として開くため、iframe 埋め込み制限を受けず、拡張API(storage等)にもフルアクセスできる。問題は popup.html 自体ではなく、「Webページ内 iframe という実行コンテキスト」にある。

---

## 2. 推奨アプローチ(設計方針)

**「ページ内 iframe」でも「新規タブ」でもなく、content script が popup の HTML/JS 資産を Shadow DOM 内に直接展開して動かす方式**を採用する。

```
[ツールバーアイコン]──→ default_popup (popup.html) ……現状維持・変更なし
[画面内の歯車ボタン]──→ content script が Shadow DOM ホストを生成
                         └→ 共通テンプレート(popup の中身)を注入
                         └→ 共通の popup.js ロジックを初期化
```

### 設計のポイント

1. **資産の共通化方法**: popup の `<body>` 中身をテンプレート(共有JSファイルのHTML文字列、または `web_accessible_resources` の popup.html を fetch して抽出)として一本化し、popup.html(ツールバー用)とページ内 Shadow DOM の両方が同じテンプレート+同じ popup.js を使う。二重実装は発生しない。

2. **popup.js のコンテキスト非依存化**: 現在は `DOMContentLoaded` + `document.getElementById` 直書きのため、`initSettingsPanel(rootElement, { context, stateKey })` のような初期化関数に改修し、DOM参照を root スコープ化する。実行文脈判定に「ページ内Shadow DOM」を追加する。

3. **メッセージングの大幅な簡素化**: Shadow DOM 方式ではパネルのJSが **content script と同一コンテキストで動く**ため、iframe 用の postMessage 代行経路(`persistViaParent` / `YLC_REQUEST_SETTINGS` / `YLC_SETTINGS_SAVED`)が不要になる。`ylcApi.settingsSet` / `updateTabState` を直接呼び、設定反映も同一コンテキストの適用関数を直接呼ぶ。Background(service worker)はパネル開閉に一切関与させない(Orionで最も不安定な経路を踏まないため)。

4. **CSS の隔離**: Shadow DOM(`mode: 'open'`)内に popup.css を `<link>`(runtime URL)または `<style>` として読み込み、YouTube側CSSと完全に隔離する。既存のモバイル用ボトムシートCSS・バックドロップ・スクロールロックはホスト要素に対してそのまま流用する。

5. **PC との切り分け**: PC で動作実績のある iframe パネルは当面維持し、モバイル判定を「新規タブを開く判定」から「Shadow DOM パネルを使う判定」に転用する(低リスク)。動作確認後、PC も Shadow DOM に統一して iframe 経路を廃止すれば保守が一本化できる(任意の後続タスク)。

6. **`window.open` 経路は完全撤去**: ゴール要件「新規タブを開かない」に直結。仮にフォールバックとして残す場合でも、`'noopener'` 指定時は戻り値で成否判定できない点の修正が必須。

> 補足: `chrome.action.openPopup()` で「アイコンのポップアップをプログラム的に開く」案は、対応ブラウザが限定的でモバイルでは期待できないため非推奨。

---

## 3. 修正計画(タスクリスト)

### ステップ0: 実機での仮説検証(短時間)

対象モバイルブラウザで以下を確認し、不具合3の主因(iframe 制限 vs イベント遮断)を確定させる。

- (a) 元タブ側パネルの iframe が `load` イベントに到達しているか
- (b) 設定パネルの診断タブ(実装済み)で storage / postMessage 経路の生死を確認

※不具合1・2の原因は仕様レベルで確定済みのため検証不要。

### ステップ1: popup 資産の共通テンプレート化

popup.html の `<body>` 中身を共有テンプレートに抽出し、popup.html はそれを読み込む薄いシェルにする。表示崩れがないことをツールバーポップアップで回帰確認。

### ステップ2: popup.js の初期化リファクタ

`DOMContentLoaded` 直実行を `initSettingsPanel(root, options)` に分離し、DOM参照を root スコープ化。実行文脈に「inpage(Shadow DOM)」を追加し、inpage では `ylcApi` 直接呼び出し(postMessage 代行をバイパス)する分岐を実装。ツールバー文脈の既存動作は不変であることを確認。

### ステップ3: content script に Shadow DOM パネルを実装

`createSettingsPanel()` に Shadow DOM 方式を追加(ホスト生成 → popup.css 注入 → テンプレート注入 → `initSettingsPanel` 呼び出し)。既存のバックドロップ・スクロールロック・ボトムシートCSS・×ボタンを流用。モバイル判定時はこちらを使う。

### ステップ4: `window.open` 経路の撤去

`openSettingsAsTopLevelPage()` / `shouldOpenSettingsAsTopLevelPage()` の新規タブ処理を削除し、判定ロジックは「Shadow DOM か iframe か」の分岐に転用。

### ステップ5: テスト更新

`tests/settings_panel_touch_css.test.js` が `shouldOpenSettingsAsTopLevelPage` の存在を前提にしているため、新仕様(設定パネル経路に `window.open` が存在しないこと、Shadow DOM 初期化関数の存在)を検証する形に書き換え。

### ステップ6: 動作検証

1. Chrome デスクトップ: iframe パネル・ツールバーポップアップの回帰確認
2. Chrome DevTools モバイルエミュレーション: Shadow DOM パネルの開閉・設定変更・即時反映
3. モバイル実機(Orion 等): 新規タブが開かないこと、同一タブ内で全設定操作が可能なこと、診断タブで縮退がないことを確認

### ステップ7(任意・後続): PC も Shadow DOM に統一

モバイルで安定稼働を確認後、iframe 経路と `persistViaParent` 系の postMessage 代行コードを廃止して実装を一本化。

---

## 関連ファイル

| ファイル | 役割 |
|---|---|
| `content_script.js` | 歯車ボタン・`toggleSettingsPanel()`・iframe パネル生成(修正の中心) |
| `popup.js` | 設定パネルのロジック(初期化リファクタ対象) |
| `popup.html` / `popup.css` | 共通テンプレート化・Shadow DOM への注入対象 |
| `extension_api.js` | `ylcApi` 互換レイヤー(変更なし・直接呼び出しに利用) |
| `content_script.css` | バックドロップ・ボトムシートCSS(流用) |
| `tests/settings_panel_touch_css.test.js` | 旧仕様前提のテスト(書き換え対象) |
| `ORION_COMPATIBILITY_PLAN.md` | iframe 制限の調査記録(参照) |
