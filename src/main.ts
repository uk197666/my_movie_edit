// spike: 循環バッファ録画 + ハイライト切り出しの実機検証画面(iPhone Safari)
import './style.css';
import { Recorder, type Clip } from './recorder';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header class="head">
    <h1>ハイライト録画</h1>
    <span class="note">※撮影前に、画面の回転ロックをオフにしてください</span>
  </header>
  <div id="stage">
    <video id="preview" autoplay muted playsinline></video>
    <button id="mark" disabled aria-label="ハイライト">★<span id="badge" hidden>0</span></button>
  </div>
  <div class="row">
    <label>前 <input id="pre" type="number" min="1" max="60" value="10" inputmode="numeric" /> 秒</label>
    <label>後 <input id="post" type="number" min="1" max="60" value="5" inputmode="numeric" /> 秒</label>
  </div>
  <div class="row">
    <button id="start">録画開始</button>
    <button id="stop" disabled>停止</button>
  </div>
  <div id="level"><div id="levelBar"></div></div>
  <pre id="stats"></pre>
  <h2>クリップ</h2>
  <div id="clips"></div>
  <details id="usageSection" class="usage">
    <summary>使い方</summary>
    <h3>1. 撮影の前に</h3>
    <ul>
      <li>画面の回転ロックをオフにしてください(縦・横どちらで撮るかを、端末の向きから自動で判断するため)。</li>
      <li>初回は、カメラとマイクの許可を求められます。「許可」を選んでください。</li>
      <li>共有ボタンの「ホーム画面に追加」で、アプリのように全画面で使えます。</li>
      <li>撮影中は、画面を消したり、別のアプリに切り替えたりしないでください。撮影が止まることがあります。</li>
      <li>長く撮ると本体が熱くなり、電池も減ります。必要なら充電しながら使ってください。</li>
    </ul>
    <h3>2. 撮る</h3>
    <ol>
      <li>画面の「前」「後」の欄で、ハイライトに残す秒数を決めます(初期値は前10秒・後5秒)。</li>
      <li>「録画開始」を押します。</li>
      <li>見せ場のプレーのあとに、映像の右下の★ボタンを押します。押した瞬間にボタンが光り、押した回数が表示されます。</li>
      <li>押した時点の「前○秒〜後○秒」だけが、1本のクリップとして残ります。それ以外の映像は保存されず、自動で捨てられます。</li>
      <li>近いタイミングで続けて押した場合、範囲が重なる部分は1本にまとめられます。</li>
    </ol>
    <h3>3. 確認して保存する</h3>
    <ol>
      <li>撮影が終わったら「停止」を押します。</li>
      <li>「クリップ」の一覧で、再生して確認します。</li>
      <li>残したいクリップは「共有/保存」を押し、「ビデオを保存」を選ぶと、写真アプリに保存されます。</li>
      <li>いらないクリップは「削除」を押します。</li>
      <li class="warn">保存する前に、ページを閉じたり再読み込みしたりすると、クリップは消えます。停止したら、早めに保存してください。</li>
    </ol>
    <h3>4. 知っておくとよいこと</h3>
    <ul>
      <li>映像と音声は、インターネットには送られません。端末の中だけで処理されます。</li>
      <li>前の秒数は、最大で約1秒長くなることがあります(映像の切れ目を合わせるため)。</li>
      <li>縦向きで撮れば縦の動画、横向きで撮れば横の動画になります。</li>
      <li>通信がなくても、一度開いたあとなら使えます。</li>
    </ul>
    <h3>5. うまくいかないとき</h3>
    <ul>
      <li>カメラが映らない、または録画を始められない場合: iPhone の設定 → アプリ → Safari → カメラ/マイクを「許可」または「確認」にしてください。</li>
      <li>動画の向きがおかしい場合: 画面の回転ロックがオフか確認してください。</li>
      <li>上記でも直らない場合は、下の「ログ」を開いて、内容を確認してください。</li>
    </ul>
  </details>
  <details id="logSection">
    <summary>ログ</summary>
    <pre id="log"></pre>
  </details>
  <details>
    <summary>対応状況チェック</summary>
    <pre id="ua"></pre>
    <table id="result"></table>
  </details>
`;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const startBtn = $<HTMLButtonElement>('#start');
const stopBtn = $<HTMLButtonElement>('#stop');
const markBtn = $<HTMLButtonElement>('#mark');
const logEl = $('#log');
const statsEl = $('#stats');
const clipsEl = $('#clips');

const logSection = $<HTMLDetailsElement>('#logSection');

const log = (msg: string) => {
  const t = new Date().toLocaleTimeString();
  logEl.textContent = `${t} ${msg}\n${logEl.textContent ?? ''}`.slice(0, 5000);
  // ログは既定で閉じているため、失敗やエラーのときだけ自動で開いて気づけるようにする
  if (/失敗|error|Error/.test(msg)) logSection.open = true;
};

const num = (sel: string, fallback: number) => {
  const v = Number($<HTMLInputElement>(sel).value);
  return Number.isFinite(v) && v >= 1 ? v : fallback;
};

const addClip = (clip: Clip) => {
  const div = document.createElement('div');
  div.className = 'clip';
  div.innerHTML = `
    <div>#${clip.id} ${clip.durationSec.toFixed(1)}秒 / ${(clip.blob.size / 1e6).toFixed(1)}MB / ${clip.width}x${clip.height}(${clip.height > clip.width ? '縦' : '横'}) / 音声${clip.hasAudio ? 'あり' : 'なし'}</div>
    <div class="playerDim"></div>
    <video src="${clip.url}" controls playsinline preload="metadata"></video>
    <div class="row"><button data-act="share">共有/保存</button><button data-act="del">削除</button></div>
  `;
  const player = div.querySelector('video')!;
  player.addEventListener('loadedmetadata', () => {
    div.querySelector('.playerDim')!.textContent = `プレーヤーが認識したサイズ ${player.videoWidth}x${player.videoHeight}`;
  });
  div.querySelector('[data-act="share"]')!.addEventListener('click', async () => {
    const file = new File([clip.blob], `highlight-${clip.id}.mp4`, { type: 'video/mp4' });
    try {
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file] });
      else log('この環境ではファイル共有できません');
    } catch (e) {
      log(`共有: ${e}`);
    }
  });
  div.querySelector('[data-act="del"]')!.addEventListener('click', () => {
    URL.revokeObjectURL(clip.url);
    div.remove();
  });
  clipsEl.prepend(div);
  log(`クリップ #${clip.id} 完成(${clip.durationSec.toFixed(1)}秒)`);
};

const recorder = new Recorder(
  () => ({ preSec: num('#pre', 10), postSec: num('#post', 5) }),
  addClip,
  log,
);

let statsTimer: number | undefined;

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  // iOS は AudioContext の resume がタップ操作の中でないと効かないため、getUserMedia より前に行う
  const audioCtx = new AudioContext();
  void audioCtx.resume();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      audio: true,
    });
    await recorder.start(stream, $<HTMLVideoElement>('#preview'), audioCtx);
    resetMarkBadge();
    stopBtn.disabled = false;
    markBtn.disabled = false;
    statsTimer = window.setInterval(() => {
      const s = recorder.getStats();
      const a = s.audio;
      statsEl.textContent =
        `映像 ${s.width}x${s.height}(${s.height > s.width ? '縦' : '横'}) fps ${s.fps.toFixed(1)} / 破棄 ${s.dropped} / キュー ${s.encodeQueue}\n` +
        `バッファ ${s.bufferedSec.toFixed(1)}秒 / ${s.bufferedMB.toFixed(1)}MB / 処理待ち ${s.pending}\n` +
        `音声 ${a.enabled ? 'ON' : 'OFF'} ctx=${a.ctxState} ${a.sampleRate}Hz PCM=${a.pcmCount} チャンク=${a.chunkCount} config=${a.hasConfig ? 'あり' : 'なし'}`;
      $('#levelBar').style.width = `${Math.min(100, Math.round(a.level * 300))}%`;
    }, 500);
  } catch (e) {
    log(`開始失敗: ${e instanceof Error ? `${e.name}: ${e.message}` : e}`);
    void audioCtx.close();
    startBtn.disabled = false;
  }
});

let markCount = 0;
markBtn.addEventListener('click', () => {
  const msg = recorder.highlight();
  log(msg);
  if (msg.startsWith('録画中ではありません')) return;
  markCount++;
  const badge = $('#badge');
  badge.hidden = false;
  badge.textContent = String(markCount);
  markBtn.classList.remove('flash');
  void markBtn.offsetWidth; // アニメーションを再起動
  markBtn.classList.add('flash');
});

const resetMarkBadge = () => {
  markCount = 0;
  $('#badge').hidden = true;
  $('#badge').textContent = '0';
};

stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true;
  markBtn.disabled = true;
  window.clearInterval(statsTimer);
  await recorder.stop();
  statsEl.textContent = '';
  $('#levelBar').style.width = '0';
  resetMarkBadge();
  startBtn.disabled = false;
});

// ---- 対応状況チェック ----
type Row = { name: string; ok: boolean | null; detail?: string };
const rows: Row[] = [];
const add = (name: string, ok: boolean | null, detail?: string) => {
  rows.push({ name, ok, detail });
  $('#result').innerHTML = rows
    .map((r) => `<tr><td>${r.ok === null ? '?' : r.ok ? 'OK' : 'NG'}</td><td>${r.name}</td><td>${r.detail ?? ''}</td></tr>`)
    .join('');
};

async function checkCapabilities() {
  $('#ua').textContent = navigator.userAgent;
  add('secure context(HTTPS)', window.isSecureContext);
  add('VideoEncoder', typeof VideoEncoder !== 'undefined');
  add('AudioEncoder', typeof AudioEncoder !== 'undefined');
  add('AudioWorklet', typeof AudioWorkletNode !== 'undefined');
  add('requestVideoFrameCallback', 'requestVideoFrameCallback' in HTMLVideoElement.prototype);
  add('Screen Wake Lock', 'wakeLock' in navigator);
  add('OPFS', !!navigator.storage?.getDirectory);
  add(
    'Web Share(ファイル)',
    !!navigator.canShare && navigator.canShare({ files: [new File([''], 'a.mp4', { type: 'video/mp4' })] }),
  );
}
checkCapabilities();

// ---- PWA: Service Worker(アプリ本体のオフライン起動用) ----
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((e) => log(`Service Worker 登録失敗: ${e}`));
  });
}
