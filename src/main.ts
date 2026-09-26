// spike: 循環バッファ録画 + ハイライト切り出しの実機検証画面(iPhone Safari)
import { Recorder, type Clip } from './recorder';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <h1>my_movie_edit spike</h1>
  <video id="preview" autoplay muted playsinline></video>
  <div class="row">
    <label>前 <input id="pre" type="number" min="1" max="60" value="10" inputmode="numeric" /> 秒</label>
    <label>後 <input id="post" type="number" min="1" max="60" value="5" inputmode="numeric" /> 秒</label>
  </div>
  <div class="row">
    <button id="start">録画開始</button>
    <button id="stop" disabled>停止</button>
  </div>
  <button id="mark" disabled>ハイライト</button>
  <pre id="stats"></pre>
  <pre id="log"></pre>
  <h2>クリップ</h2>
  <div id="clips"></div>
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

const log = (msg: string) => {
  const t = new Date().toLocaleTimeString();
  logEl.textContent = `${t} ${msg}\n${logEl.textContent ?? ''}`.slice(0, 2000);
};

const num = (sel: string, fallback: number) => {
  const v = Number($<HTMLInputElement>(sel).value);
  return Number.isFinite(v) && v >= 1 ? v : fallback;
};

const addClip = (clip: Clip) => {
  const div = document.createElement('div');
  div.className = 'clip';
  div.innerHTML = `
    <div>#${clip.id} ${clip.durationSec.toFixed(1)}秒 / ${(clip.blob.size / 1e6).toFixed(1)}MB</div>
    <video src="${clip.url}" controls playsinline preload="metadata"></video>
    <div class="row"><button data-act="share">共有/保存</button><button data-act="del">削除</button></div>
  `;
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
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      audio: true,
    });
    await recorder.start(stream, $<HTMLVideoElement>('#preview'));
    stopBtn.disabled = false;
    markBtn.disabled = false;
    statsTimer = window.setInterval(() => {
      const s = recorder.getStats();
      statsEl.textContent =
        `バッファ ${s.bufferedSec.toFixed(1)}秒 / ${s.bufferedMB.toFixed(1)}MB\n` +
        `fps ${s.fps.toFixed(1)} / 破棄 ${s.dropped} / キュー ${s.encodeQueue}\n` +
        `処理待ちハイライト ${s.pending} / 音声 ${s.hasAudio ? 'あり' : 'なし'}`;
    }, 500);
  } catch (e) {
    log(`開始失敗: ${e instanceof Error ? `${e.name}: ${e.message}` : e}`);
    startBtn.disabled = false;
  }
});

markBtn.addEventListener('click', () => log(recorder.highlight()));

stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true;
  markBtn.disabled = true;
  window.clearInterval(statsTimer);
  await recorder.stop();
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
