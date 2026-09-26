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
- 撮影中: ボタン押下は振動(対応時)や画面表示でマークするだけ。確保したクリップのチャンクは一時領域(OPFS/IndexedDB)へ退避し、循環バッファの破棄対象から外す。MP4化と保存は撮影後
- 撮影後の一覧画面: クリップの再生プレビュー、不要クリップの削除、選択クリップの一括保存(共有シート)
- 押下が近接して範囲が重なった場合は1クリップに統合する(詳細は実装時に確定)

## 撮影バッファ方式

- 案1(推奨候補): WebCodecs の VideoEncoder(対応していれば AudioEncoder)でエンコード済みチャンクを循環バッファに保持し、押下時に前後N秒(キーフレーム境界)を MP4 化する
- 案2(フォールバック): MediaRecorder を2本、時間をずらして短いセグメントで回し、押下時刻を含むセグメントを結合する
- どちらにするかは iPhone 実機での spike で決める

## 実機検証結果(iPhone / iOS 26.6.2 Safari)

- OK: getUserMedia、VideoEncoder(H.264 1080p)、AudioEncoder(AAC)、MediaRecorder、Screen Wake Lock、OPFS、Web Share(ファイル)
- NG: MediaStreamTrackProcessor(映像フレームの取り出しは `requestVideoFrameCallback` + `new VideoFrame(video)` で代替、音声は AudioWorklet で代替)
- NG: vibrate(振動フィードバックは使えない。画面表示で代替)
- カメラ取得が NotAllowedError で失敗した場合は、iPhone 設定 → アプリ → Safari → カメラ/マイクを「許可」にする
- 方式は案1(WebCodecs + 循環バッファ)に決定。実装は [src/recorder.ts](src/recorder.ts)、MP4 化は mediabunny

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

- 保存動画の向きは撮影時の映像サイズに従う(縦で撮れば縦、横で撮れば横)
- 撮影中に向きが変わると、エンコーダを作り直し、待機中のハイライトはそこまでで確定、バッファは破棄する(向きの違う映像は1本に混ぜない)
- iPhone の「画面縦向きのロック」がオンだと Safari が向きを更新しないため、横向きで撮るときはロックをオフにする

## 既知の制約

- 画面ロックやアプリ切替でカメラ・撮影が止まる → 撮影中は Screen Wake Lock API で画面スリープを防ぐ
- 写真アプリへ直接保存できず、共有シート(ビデオを保存)経由になる
- iOS Safari のバージョンにより WebCodecs / AudioEncoder の対応が異なる → 実機で確認する
- getUserMedia は HTTPS 必須

## 未決事項

- 映像と音声の同期精度、30分連続録画時の発熱・メモリ(実機で検証中)
- 押下が重なった場合の統合ルールの詳細
