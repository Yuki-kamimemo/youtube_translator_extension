# YouTube Live Chat Enhancer

YouTubeのライブ配信・プレミア公開のチャットを日本語で追いやすくする、Manifest V3対応のブラウザ拡張機能です。チャット欄へのインライン翻訳と、動画プレーヤー上を流れるコメント表示に対応しています。

## 主な機能

- Google翻訳またはPC上のLM Studioによる日本語翻訳
- 通常チャット、スーパーチャット、メンバー加入・ギフトなどの表示
- 原文・翻訳文・両方から選べるフローコメント
- フローの速度、文字サイズ、透明度、位置、余白、色、縁取り、フォントの調整
- ユーザー辞書とYouTubeチャット向けスラング補正
- NGユーザー・NGワード
- 設定プロファイルの保存と切り替え
- YouTubeのSPA遷移、チャット開閉、タブの非表示・復帰に対応した監視制御

高負荷時は古い未処理コメントより、最新コメントと画面操作の滑らかさを優先します。翻訳は最大3件を並行処理し、待機キューは最大50件です。フロー表示はPCで最大60件、モバイルで最大30件に制限されます。

## 対応環境

- PC: Google Chrome / Microsoft EdgeなどのChromium系ブラウザ
- Android: Chrome系ブラウザで動作確認
- iPhone / iPad: Orion互換を考慮した実装

LM Studio連携はPC版専用です。iPhone / iPadなどのAppleタッチ環境ではLM Studioを選択できません。Google翻訳はAPIキー不要です。

## インストール

1. このリポジトリをダウンロードまたはクローンします。
2. ChromeまたはEdgeの拡張機能管理ページを開きます。
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
3. 「デベロッパーモード」を有効にします。
4. 「パッケージ化されていない拡張機能を読み込む」を選び、このリポジトリのフォルダを指定します。
5. YouTubeのライブ配信またはプレミア公開ページを開きます。

更新したファイルを取得した後は、拡張機能管理ページで本拡張の「更新」または再読み込みを実行し、YouTubeのページも再読み込みしてください。

## 基本的な使い方

動画プレーヤー上に表示されるボタンから、次の機能を操作できます。

- 翻訳: チャット欄のインライン翻訳をオン・オフ
- フロー: プレーヤー上のフローコメントをオン・オフ
- 設定: 翻訳サービス、表示、辞書、NG条件、プロファイルなどを変更

翻訳とフローのオン・オフ状態はタブごとに保存されます。設定は通常 `chrome.storage.sync` に保存され、利用できない環境や容量制限時は `chrome.storage.local` へ自動的に切り替わります。

## 翻訳サービス

### Google翻訳

初期設定です。APIキーは不要で、PC・モバイルの両方で利用できます。

### LM Studio

PC上のLM Studio OpenAI互換APIを使用します。接続先は次の固定アドレスです。

```text
http://localhost:1234
```

1. LM StudioでLocal Serverを起動します。
2. 拡張機能の設定を開き、翻訳サービスに「LM Studio」を選びます。
3. 「更新」でLM Studioからモデル一覧を取得します。
4. 使用するモデルを選択します。
5. 「LM Studioモデルを起動」をオンにします。

モデル選択機能はTranslateGemma以外でも利用できます。通常モデルでは、短いチャット翻訳向けの指示を送り、LM Studioが対応している場合は推論を `off` にして日本語訳だけを生成させます。

「LM Studio失敗時にGoogle翻訳を使用」がオンの場合、モデル未起動、通信失敗、言語判定不能などではGoogle翻訳へフォールバックします。オフの場合は翻訳を表示せず、短時間の失敗キャッシュで同じコメントへの連続再試行を抑制します。

## TranslateGemma 4Bを使う

正式な検証対象は [`mradermacher/translategemma-4b-it-GGUF`](https://huggingface.co/mradermacher/translategemma-4b-it-GGUF) の `Q4_K_S`（約2.38GB）です。モデル名に `translategemma`、`4b`、`it`が含まれていれば他の量子化形式にも専用処理を適用しますが、動作保証対象外です。

TranslateGemmaをLM Studioで使用するには、モデルを登録するだけでなく、LM Studio側のチャットテンプレートを必ず書き換える必要があります。GGUFに埋め込まれた既定テンプレートのままでは、モデルのロードに成功しても翻訳要求が正常に処理されないことがあります。

### セットアップ手順

1. Hugging Faceから `translategemma-4b-it.Q4_K_S.gguf` を取得し、LM Studioへ登録します。
2. LM Studioの「My Models」からTranslateGemmaを開きます。
3. モデル設定の「Prompt Template」または「Chat Template」を編集します。
4. 既存内容をすべて削除し、下記テンプレートへ置き換えて保存します。
5. LM StudioのLocal Serverを `http://localhost:1234` で起動します。
6. 拡張機能の設定で「LM Studio」を選び、「更新」を押します。
7. TranslateGemmaモデルを選び、「LM Studioモデルを起動」をオンにします。
8. 次の表示を確認します。

```text
TranslateGemma最適化: 適用中（Q4_K_S検証対象）
原文言語: 自動判定 / 翻訳先: 日本語
LM Studio側のPrompt Template設定が必要です
```

### LM Studioへ設定するチャットテンプレート

このリポジトリの [`translategemma_lmstudio_template.jinja`](translategemma_lmstudio_template.jinja) と同じ内容です。改行を含め、次の内容をそのまま貼り付けてください。

```jinja
{{- bos_token }}
{%- for message in messages %}
    {%- if message['role'] == 'user' %}
        {{- '<start_of_turn>user\n' }}
        {{- message['content'] | trim }}
        {{- '<end_of_turn>\n' }}
    {%- elif message['role'] == 'assistant' %}
        {{- '<start_of_turn>model\n' }}
        {{- message['content'] | trim }}
        {{- '<end_of_turn>\n' }}
    {%- endif %}
{%- endfor %}
{%- if add_generation_prompt %}
    {{- '<start_of_turn>model\n' }}
{%- endif %}
```

このテンプレートはLM Studioのllama.cpp環境向けの互換テンプレートです。TranslateGemma公式の構造化chat templateそのものではありません。拡張機能は言語コードを含む翻訳要求をLM Studioで扱える文字列へ変換して送信します。

TranslateGemma選択時は、PC側で `chrome.i18n.detectLanguage()` により原文言語を判定します。信頼できる対応言語だけをLM Studioへ送り、翻訳先は日本語に固定します。判定不能・信頼性不足・非対応言語の場合は、フォールバック設定が有効ならGoogle翻訳を使用します。

## ユーザー辞書

「単語登録」タブで、翻訳前に適用する置換を1行1件で登録できます。

```text
置換前,置換後
Holo,ホロ
Gura,ぐら
```

大文字と小文字は区別しません。部分一致の衝突を避けるため、長い語から優先して適用されます。

## フローコメント設定

- 流す内容: 翻訳のみ / 原文のみ / 原文と翻訳
- 表示時間、文字サイズ、透明度
- 上優先 / 下優先 / ランダム
- 上下余白、フォント、カスタムフォント
- 縁取りの太さと色
- 通常、メンバー、モデレーター、スーパーチャット、メンバー加入の色

絵文字、スーパーチャット、ステッカー、メンバー加入・ギフトを安全に再構築して表示します。チャット由来のHTMLは許可された要素と画像ホストだけを使用します。

## NG設定とプロファイル

- NGユーザー: 投稿者名の完全一致
- NGワード: コメント本文に指定語が含まれる場合に非表示
- プロファイル: 表示設定、辞書、NG設定などを名前付きで保存・切り替え

## 軽量化・安定化の仕様

- タブ非表示中は新しい翻訳を開始せず、復帰時に過去コメントを一括翻訳しません。
- SPA遷移や動画変更時は古いObserver、翻訳待ち、iframe、フロー要素を破棄します。
- 隠しlive_chat iframeは、フローがオンで利用可能な可視チャットがない場合だけ使用します。
- コメント追加はフレーム単位でまとめ、高負荷時は最新コメントを優先します。
- 翻訳キャッシュは翻訳サービス、モデル、原文言語、辞書を区別します。
- 同一翻訳の同時要求は1リクエストへまとめます。
- フロー要素は画面上限を超える前に破棄し、終了イベントと保険タイマーを一元管理します。

## トラブルシューティング

### LM Studioのモデル一覧が取得できない

- LM StudioのLocal Serverが起動しているか確認してください。
- Server Portが `1234` であることを確認してください。
- 拡張機能の設定で「更新」を押してください。

### TranslateGemmaは起動するが翻訳されない

- LM StudioのPrompt Templateが上記内容へ完全に置き換えられているか確認してください。
- テンプレート保存後にモデルを停止し、再度起動してください。
- 拡張機能を更新または再読み込みし、YouTubeページも再読み込みしてください。
- 設定欄に「TranslateGemma最適化: 適用中」と表示されるか確認してください。
- LM Studioのログに `/v1/chat/completions` が現れるか確認してください。

### 翻訳されないコメントがある

日本語、記号、URL、絵文字だけのコメントは翻訳しません。TranslateGemmaでは言語判定が不確実な短文や非対応言語もローカルモデルへ送りません。必要に応じてGoogleフォールバックを有効にしてください。

### モバイルでLM Studioを選べない

仕様です。LM StudioはPC版だけで利用できます。モバイルではGoogle翻訳を選択してください。

## 開発者向けテスト

ビルド処理や `package.json` はありません。Node.jsで次のテストを個別に実行できます。

```powershell
node tests\flow_emoji_fallback.test.js
node tests\extension_api.test.js
node tests\translation_cache.test.js
node tests\settings_panel_touch_css.test.js
node tests\translategemma_preset.test.js
node tests\performance_lifecycle.test.js
node tests\lifecycle_runtime.test.js
```

## 主なファイル

- `manifest.json`: Manifest V3、権限、スクリプト読み込み順
- `extension_api.js`: Chrome / WebExtensions互換処理とストレージフォールバック
- `background.js`: Google翻訳、LM Studio、モデル操作、キャッシュ、言語判定
- `translation.js`: 共通の前処理、スキップ判定、辞書、直接Google翻訳
- `content_script.js`: watchページのUI、設定パネル、監視ライフサイクル
- `chat_observer.js`: live_chat側の監視、NG判定、翻訳キュー
- `flow.js`: フロー描画、レーン制御、XSS対策
- `popup.html` / `popup.js` / `popup.css`: 設定画面
- `slang_dict.json`: YouTubeチャット向けスラング辞書
- `translategemma_lmstudio_template.jinja`: LM Studio用TranslateGemmaテンプレート

## 注意事項

- 翻訳結果は使用モデル、原文、言語判定によって変わります。
- LM Studioのモデル本体は本リポジトリに含まれません。
- YouTubeやLM Studioの仕様変更により、DOM監視やAPI連携が動作しなくなる場合があります。
