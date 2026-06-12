# 設定パネル表示時に背後のページが消失するバグ 調査・修正計画書

作成日: 2026-06-12

## 現象

設定パネル（Live Chat Enhancer 設定）を開くと、背後のYouTube watchページのコンテンツ（動画プレーヤー・タイトル・コメント欄など）が消え、黒い背景だけになる。

スクリーンショットから読み取れる重要な事実:

- **マストヘッド（検索バー・ロゴ）は表示されたまま** → マストヘッドは `position: fixed` 要素
- **設定パネル自体は正常に表示・動作している** → パネルとバックドロップも `position: fixed` 要素
- **タブのスピーカーアイコンが点灯したまま（音声は再生継続）** → DOMは破棄されておらず、`<video>` も再生中。純粋に「描画/レイアウト」の問題
- 消えているのは**通常フロー（in-flow）のコンテンツだけ**で、fixed配置の要素はすべて生き残っている

---

## 1. 原因の仮説

### 仮説A（本命・コード調査で裏付けあり）: スクロールロックが `<body>` に `position: fixed` を適用していることによるレイアウト崩壊

`content_script.js` の `lockPageScrollForSettingsPanel()`（310〜330行付近）は、パネル表示のたびに**デスクトップを含む全環境で無条件に**以下を実行する（`createSettingsPanel()` の先頭 348行で呼び出し）:

```js
document.documentElement.style.overflow = 'hidden';
document.body.style.overflow = 'hidden';
document.body.style.position = 'fixed';   // ← 最重要容疑
document.body.style.top = `-${scrollY}px`;
document.body.style.left = `-${scrollX}px`;
document.body.style.width = '100%';
document.body.style.touchAction = 'none';
```

#### 裏付けとなる証拠

1. **時系列の一致**: この処理はコミット `fced355`（2026-06-11「fix: モバイル設定をトップレベル表示に切り替え」）で導入されたばかりで、バグ報告の直前である。
2. **症状の境界線が完全に一致**: `<body>` を `position: fixed` 化すると影響を受けるのは**通常フローの子孫だけ**で、fixed配置の要素（マストヘッド・パネル・バックドロップ）は viewport 基準のため影響を受けない。これはスクリーンショットの「生き残った要素 / 消えた要素」の境界と正確に一致する。
3. **パネル表示時にページへ干渉する処理は2つしかない**ことをコードから確認済み:
   - スクロールロック（本仮説）
   - バックドロップ＋パネルのDOM追加（バックドロップは `background: transparent` であり、黒く塗り潰しているのはバックドロップ**ではない**。黒はYouTube自身のダークテーマ背景 `#0f0f0f` が露出したもの）
4. **既知の問題パターン**: 「body への position:fixed によるスクロールロック」は、YouTube のような巨大SPA（Polymerによる動的レイアウト、スクロール位置に依存した遅延描画・仮想化）と相性が最悪の手法として知られる。特に WebKit 系（ユーザー環境の Orion を含む）では、body fixed 化により:
   - `document.scrollingElement` のスクロール高がviewport高に収縮し `scrollY` が 0 にリセット → YouTube側のスクロール/リサイズハンドラが発火し、レイアウト・遅延描画状態を再計算
   - スクロール位置が深い状態（`top: -Npx` が大きい）では、コンテンツ全体が viewport 外へシフト
   - 結果として in-flow コンテンツが viewport 内に描画されなくなる

### 仮説B（次点）: 最大級 z-index の fixed レイヤーによる合成（コンポジット）の不具合

バックドロップ `#ylc-settings-backdrop` は `position: fixed; inset: 0; z-index: 2147483646`、パネルは `z-index: 2147483647; isolation: isolate` を持つ。WebKit系ブラウザでは、画面全体を覆う最大級z-indexの透明fixedレイヤーが背後のレイヤーの再描画を阻害するレンダリングバグが報告例として存在する。ただし**仮説Aで症状の説明が完結する**ため、優先度は低い。

### 仮説C（ほぼ棄却）: SPAルーティング競合・DOM破棄

タブで音声再生が継続している＝ `<video>` 要素とプレーヤーDOMは生存しているため、「YouTubeのSPAナビゲーションによるページ破棄」は証拠と矛盾し棄却できる。`createSettingsPanel()` 内にもページDOMを削除・付け替えする処理は存在しない。

---

## 2. 推奨される調査手順

### 手順1: 拡張機能なしで最小再現（仮説Aの直接検証・5分）

YouTube watchページを開き、少しスクロールした状態でデベロッパーツールの **Console** に以下を貼り付ける（拡張機能のロックと同一の処理）:

```js
document.documentElement.style.overflow = 'hidden';
document.body.style.overflow = 'hidden';
document.body.style.position = 'fixed';
document.body.style.top = `-${scrollY}px`;
document.body.style.width = '100%';
```

- **ページが同様に黒くなれば仮説A確定**（拡張機能は無関係に再現する）。
- ブラウザ依存性の切り分けのため、Orion と Chrome の両方で実施する。

### 手順2: 実際のバグ状態での Elements パネル確認

パネルを開いて背景が消えた状態で:

1. `<body>` を選択し、インラインstyleの `position: fixed` / `top` / `overflow` を**1つずつチェックボックスでOFF**にする → どのプロパティをOFFにした瞬間にページが復活するかで原因プロパティを特定。
2. `ytd-app`・`#page-manager`・`ytd-watch-flexy` を選択し、ハイライト位置とComputedの `height` を確認 → 「高さが0に収縮」か「viewport外へシフト」かを判別。
3. `#ylc-settings-backdrop` の要素を一時的に `display: none` にして背景が戻るか確認（仮説Bの切り分け）。

### 手順3: Console での状態確認

```js
document.body.getBoundingClientRect();                      // bodyの位置とサイズ
document.querySelector('ytd-app').getBoundingClientRect();  // 主要コンテンツの位置
scrollY;                                                    // ロック後のスクロール位置
```

加えて Console にYouTube側のエラーが出ていないかを確認する（仮説Cの最終確認）。

---

## 3. 修正計画（ステップ）

方針: **「body の position:fixed 化」をやめる**。スクロールロックの本来の目的（モバイルでの背景スクロール防止・タップ貫通防止）は、既に実装済みの別レイヤーでほぼ達成されている:

- バックドロップが `touchmove` を `preventDefault`（`createSettingsPanel()` 内で実装済み）
- パネル側に `overscroll-behavior: contain`（CSS実装済み）

### ステップ1: 最小再現で根本原因を確定（上記・調査手順1）

修正前に必ず実施し、仮説Aを事実として確定させる。

### ステップ2: 失敗するテストの追加

`tests/settings_panel_touch_css.test.js` に「スクロールロックが `body.style.position` を変更しないこと」を検証するテストを追加する（現状の実装では失敗することを確認）。

### ステップ3: スクロールロックの実装差し替え（最小修正）

`lockPageScrollForSettingsPanel()` から `position: fixed` / `top` / `left` / `width` の操作を撤去し、以下のみ残す:

```js
document.documentElement.style.overflow = 'hidden';
document.body.style.overflow = 'hidden';
```

`unlockPageScrollForSettingsPanel()` も対応する復元処理だけに簡素化する（`window.scrollTo` による復元は overflow 方式ではスクロール位置が失われないため不要になる見込み。iOS Safari系でズレる場合のみ保険として残す）。

`touch-action: none` を body に付ける処理も撤去する（バックドロップの `preventDefault` で代替済み。body への適用はパネル外のYouTube UI全体の操作性に影響する副作用が大きい）。

### ステップ4: デスクトップではロック自体を不要化（任意・推奨）

デスクトップ（fine pointer）のパネルはドラッグ可能なフローティングダイアログであり、背景スクロールを禁止する必然性がない。`shouldUseShadowSettingsPanel()` と同様の coarse pointer 判定でロックをモバイル系に限定すれば、デスクトップへの副作用リスクがゼロになる。

### ステップ5: 回帰確認

1. **本バグ**: Chrome / Orion のデスクトップで、watchページ・スクロール済みのwatchページ・ホームフィードの各状態でパネルを開閉し、背景が消えないこと・閉じた後にスクロール位置が保たれることを確認。
2. **ロック導入の動機だった元バグの再発確認**: モバイル（実機 Orion / DevToolsエミュレーション）で、パネル表示中に背景がスクロールしないこと・タップ貫通しないこと（`4b5c858` / `fced355` の修正目的）を確認。
3. `tests/` のユニットテストが全て通ることを確認。

### ステップ6（仮説Aが万一否定された場合のみ）

手順2-3の調査結果を起点に仮説B（バックドロップの合成バグ）へ移行する。対処候補: `z-index` を現実的な値（例: 9999998）へ引き下げ、`isolation: isolate` の撤去、バックドロップへの `will-change` 付与など。**仮説A確定前にこれらを先回りで変更しないこと**（複数同時変更は原因特定を破壊する）。

---

## 関連ファイル

| ファイル | 該当箇所 |
|---|---|
| `content_script.js` | `lockPageScrollForSettingsPanel()` / `unlockPageScrollForSettingsPanel()`（310〜344行）、`createSettingsPanel()` 冒頭のロック呼び出し（348行） |
| `content_script.css` | `#ylc-settings-backdrop`（139〜146行）、`#ylc-settings-panel`（148〜173行） |
| `tests/settings_panel_touch_css.test.js` | スクロールロック仕様のテスト追加先 |
| `SETTINGS_PANEL_FIX_PLAN.md` | 前回（モバイル操作不能バグ）の計画書。本件はその修正で導入されたスクロールロックの副作用 |
