# CLAUDE.md

## 言語設定

Claude の実行状態(何をしているかの説明)や作業結果の表示は、日本語で行うこと。

## セッション開始時のモード

新しいセッションを起動する場合は、Planモードをデフォルトとする(実装前にまず計画を提示し、承認を得てから実行する)。

## アプリ概要

スポーツ撮影用の動画撮影アプリ。撮影中はずっと録画するが、ユーザが「ハイライトボタン」を押した時点の前後の区間だけを保存し、ハイライト作成に必要な部分のみを残す。

## 開発方針(確定事項)

- 対象は iPhone のみ(Android は対応しない)
- 開発環境は Windows のみ(Mac なし)、Apple Developer Program にも加入しない
- そのため **iPhone の Safari で動く Web アプリ(PWA)** として作る。HTTPS でホストし、ホーム画面に追加して使う
- 技術: Vite + TypeScript(まずフレームワークなし)、getUserMedia、WebCodecs(または MediaRecorder)、Web Share API
- ホスティング: GitHub Pages か Cloudflare Pages(無料・HTTPS)

## アプリ仕様

- 記録操作: プレー後に画面の大きな1ボタンをタップ。タップ時点の前N秒〜後M秒を1クリップとして確保する
- 前後秒数: 設定画面で変更可(初期値 前10秒・後5秒)。設定は localStorage に保存
- 保存形式: ハイライトごとに個別の MP4
- 撮影条件: 1試合〜30分程度、1080p、音声あり
- 撮影中: ボタン押下は画面表示(ボタンが光り、押した回数を表示)でマークする(iPhone は振動不可)。確保したクリップのチャンクはメモリ上で循環バッファの破棄対象から外し、後ろ M 秒が揃ったら MP4 化する。OPFS/IndexedDB へは退避しない(下記「ストレージ・メモリ方針」)
- 撮影後の一覧画面: クリップの再生プレビュー、不要クリップの削除、選択クリップの一括保存(共有シート)
- 押下が近接して範囲が重なった場合は1クリップに統合する(詳細は実装時に確定)

## 撮影バッファ方式

- 決定: WebCodecs の VideoEncoder + AudioEncoder でエンコード済みチャンクをメモリ上の循環バッファに保持し、押下時に前N秒(直前のキーフレームから。最大約1秒長くなる)〜後M秒を MP4 化する
- 不採用: MediaRecorder を2本ずらして回す方式(案2。実機で案1が動いたため使わない)

## 実機検証結果(iPhone / iOS 26.6.2 Safari)

- OK: getUserMedia、VideoEncoder(H.264 1080p)、AudioEncoder(AAC)、MediaRecorder、Screen Wake Lock、OPFS、Web Share(ファイル)
- NG: MediaStreamTrackProcessor(映像フレームの取り出しは `requestVideoFrameCallback` + `new VideoFrame(video)` で代替、音声は AudioWorklet で代替)
- NG: vibrate(振動フィードバックは使えない。画面表示で代替)
- カメラ取得が NotAllowedError で失敗した場合は、iPhone 設定 → アプリ → Safari → カメラ/マイクを「許可」にする
- 方式は案1(WebCodecs + 循環バッファ)に決定。実装は [src/recorder.ts](src/recorder.ts)、MP4 化は mediabunny

## PWA(ホーム画面追加)

- アプリ名は「ハイライト録画」。iPhone の Safari → 共有 → 「ホーム画面に追加」で、全画面(standalone)のアプリとして起動できる
- 設定: [public/manifest.webmanifest](public/manifest.webmanifest)、[index.html](index.html) の meta/link、アイコン `public/icons/*.png`
- アイコンは `node scripts/make-icons.mjs` で再生成できる(依存パッケージなし。バスケットボール: オレンジの球 + 黒い縫い目)
- 画面上部のタイトル横に「撮影前に、画面の回転ロックをオフにしてください」の注意文を表示している(ロック中は向きが更新されないため)
- [public/sw.js](public/sw.js): アプリ本体(HTML/JS/アイコン)だけをネットワーク優先でキャッシュし、オフラインでも起動できるようにする。動画・バッファは保存しない(ストレージ方針と矛盾しない)。仕様を変えたら `CACHE` のバージョンを上げる
- ホーム画面から起動したアプリは、Safari とは別のサイトデータとして扱われ、カメラ/マイクの許可を改めて聞かれることがある
- ログは既定で閉じた折りたたみセクション。失敗・エラーを含むログが出たときだけ自動で開く

## セキュリティ

- 動画はサーバーに送らず端末内で処理する。外部への通信・外部読み込みは一切ない
- CSP: [vite.config.ts](vite.config.ts) のプラグインで、ビルド時だけ meta タグとして挿入(GitHub Pages は HTTP ヘッダーを設定できないため。開発サーバーには付けない)。`default-src 'none'` を基本に、必要なものだけ許可している。そのため次のルールを守る
  - インラインの `<script>` / `<style>` / `style="..."` 属性は使わない(CSS は [src/style.css](src/style.css))。JS からの `el.style.xxx = ...` は可
  - AudioWorklet は Blob URL ではなく静的ファイル [public/audio-capture-worklet.js](public/audio-capture-worklet.js) を読み込む
  - 外部の CDN・フォント・API を追加しない(必要になったら CSP を見直す)
  - `frame-ancestors` は meta では効かないため未設定
- GitHub Actions は [.github/workflows/deploy.yml](.github/workflows/deploy.yml) でコミット SHA に固定している(コメントにバージョン)。更新は [.github/dependabot.yml](.github/dependabot.yml) の Dependabot(npm と Actions、週次)が出す PR で行う
- 公開先 `uk197666.github.io` は、同じアカウントの他の Pages サイトと同一オリジン。カメラ/マイクの許可や localStorage が共有されるため、このアカウントの Pages には信頼できるサイトだけを置く。GitHub アカウントの 2 要素認証は設定しない方針(乗っ取られると悪意あるコードが配信されカメラ/マイクを悪用されるリスクは承知の上。パスワードの使い回しはしない)
- 画面には、折りたたみの「使い方」セクション(クリップ一覧とログの間、既定で閉じる)がある。文言は [src/main.ts](src/main.ts) のテンプレート内。機能や注意点を変えたら、あわせて更新する
- 検証: CSP 付きビルドを `vite preview` で動かし、Edge(フェイクカメラ)で録画 → ハイライト → クリップ生成まで CSP 違反 0 件で通ることを確認済み

## ストレージ・メモリ方針(確定)

- ストレージとメモリはできるだけ使わない。ストレージに残すのは、ユーザが写真アプリに保存したクリップだけ
- 保存していない映像は、メモリ上の循環バッファ(前N秒分)だけに置き、古い分から捨てる。OPFS/IndexedDB への一時書き出しはしない(決定済み。再検討しない限り入れない)
- 完成したクリップ(MP4 の Blob)は、一覧の「削除」またはページを閉じるまでメモリに残る。写真アプリへの保存後に一覧から削除すればメモリも解放される
- ページを閉じる/再読み込みすると、未保存のバッファとクリップは失われる(許容する)

## 音声(AAC)の注意

- Safari の AudioEncoder は `decoderConfig.description` に ES_Descriptor(39B)を返す。MP4 の esds には AudioSpecificConfig(2B、48kHz モノラルなら `11 88`)だけを入れる必要があり、そのまま入れると iPhone で音声が無音扱いになる
- [src/recorder.ts](src/recorder.ts) の `extractAudioSpecificConfig` で取り出してから mediabunny に渡している(実機で音声入りを確認済み)
- iOS の AudioContext は、タップ操作の中で作成・resume しないと動かないことがある

## 向きの扱い

- iOS Safari の `VideoFrame(video)` は、表示上の向きではなく回転前(センサー向き=横)の画素・サイズ(1920x1080)を返す。そのままエンコードすると、縦撮りが横長のクリップや縦に引き伸ばされたクリップになる
- 対策として、video を canvas に描画してから `VideoFrame(canvas)` を作る(canvas には表示どおりの向きで描かれる)。エンコーダのサイズは `video.videoWidth/Height`。実機で縦・横とも正しく保存できることを確認済み
- 5分連続録画で fps は約30を維持、発熱は軽度(30分連続は未検証)
- 保存動画の向きは撮影時の映像サイズに従う(縦で撮れば縦、横で撮れば横)
- 撮影中に向きが変わると、エンコーダを作り直し、待機中のハイライトはそこまでで確定、バッファは破棄する(向きの違う映像は1本に混ぜない)
- iPhone の「画面縦向きのロック」がオンだと Safari が向きを更新しないため、横向きで撮るときはロックをオフにする

## 既知の制約

- 画面ロックやアプリ切替でカメラ・撮影が止まる → 撮影中は Screen Wake Lock API で画面スリープを防ぐ
- 写真アプリへ直接保存できず、共有シート(ビデオを保存)経由になる
- iOS Safari のバージョンにより WebCodecs / AudioEncoder の対応が異なる → 実機で確認する
- getUserMedia は HTTPS 必須

## 現在の状況

- 公開URL: https://uk197666.github.io/my_movie_edit/ 、リポジトリ: `uk197666/my_movie_edit`。main への push で GitHub Actions が自動デプロイする
- 実装済み: 循環バッファ録画、ハイライト切り出し(重なりは統合)、縦横の向き対応、音声(AAC)、MP4 化、クリップ一覧(再生/共有/削除)、チェックしたクリップの一括保存(共有シートに複数ファイルを渡す。チェックは初期オン、共有後も一覧に残す)、停止時と開始時の状態リセット、PWA、CSP、使い方セクション、ログの折りたたみ
- 実機(iPhone)で確認済み: 音声入り保存、縦・横の向き、5分録画で fps 約30、一括保存(複数本を共有シートの「ビデオを保存」で写真アプリへ)、CSP 付きビルド(公開版で録画〜一括保存まで動作)
- 実機で未確認: クリップ追加時にプレビューが縮む問題の修正(`.clip video` の幅制限)、ホーム画面追加とオフライン起動、使い方セクションの表示、一括保存で合計サイズが大きい場合(試合1本分など)の挙動

## 開発・検証の手順

- ビルド: `npm run build`(型チェック込み)
- ローカル検証: `npm run build` → `npx vite preview`(ポート 4173、パスは `/my_movie_edit/`)を、Edge のフェイクカメラで動かす
  - Playwright はこのプロジェクトに入れず、`C:\Users\uk197\my-git-project\e2e\node_modules` の playwright-core を流用する
  - 起動フラグ: `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required`
  - 確認項目: 録画開始 → ★押下 → クリップ生成、`securitypolicyviolation` が 0 件、コンソールエラーなし
  - 検証後は preview を止め、`dist` を消す
- コミット末尾に `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` を付ける。push など外部に出す操作は、事前にユーザに確認する
- 機能や注意点を変えたら、CLAUDE.md と画面の「使い方」を更新する。Service Worker のキャッシュ対象を変えたら `CACHE` のバージョンを上げる

## 決定の経緯(要点)

- Mac がなく Apple Developer Program にも入らないため、ネイティブ(Expo 等)は不採用。Web アプリ(PWA)に決定し、公開は GitHub Pages
- 映像は `VideoFrame(video)` ではなく canvas 経由で取り込む(iOS の向きの問題。「向きの扱い」参照)
- ストレージ・メモリは最小限にする。OPFS/IndexedDB は使わない
- GitHub アカウントの2要素認証は設定しない(リスクは承知。「セキュリティ」参照)

## 未決事項・未着手

- 30分連続録画の実機確認(発熱・メモリ。映像と音声の同期精度もあわせて確認)
- 前後秒数を localStorage に保存する(仕様にあるが未実装。現在は再読み込みで初期値に戻る)
- 押下が重なった場合の統合ルールの詳細
