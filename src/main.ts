// spike: iPhone Safari での撮影バッファ方式(WebCodecs / MediaRecorder)の対応状況を確認する画面

type Row = { name: string; ok: boolean | null; detail?: string };

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <h1>my_movie_edit spike</h1>
  <video id="preview" autoplay muted playsinline style="width:100%;background:#000"></video>
  <p><button id="start">カメラ開始(1080p・音声あり)</button></p>
  <pre id="ua"></pre>
  <table id="result"></table>
`;

const rows: Row[] = [];
const render = () => {
  document.querySelector('#result')!.innerHTML = rows
    .map((r) => `<tr><td>${r.ok === null ? '?' : r.ok ? 'OK' : 'NG'}</td><td>${r.name}</td><td>${r.detail ?? ''}</td></tr>`)
    .join('');
};
const add = (name: string, ok: boolean | null, detail?: string) => {
  rows.push({ name, ok, detail });
  render();
};

document.querySelector('#ua')!.textContent = navigator.userAgent;

async function checkCapabilities() {
  add('secure context(HTTPS)', window.isSecureContext);
  add('getUserMedia', !!navigator.mediaDevices?.getUserMedia);

  add('VideoEncoder(WebCodecs)', typeof VideoEncoder !== 'undefined');
  if (typeof VideoEncoder !== 'undefined') {
    try {
      const s = await VideoEncoder.isConfigSupported({
        codec: 'avc1.640028',
        width: 1920,
        height: 1080,
        bitrate: 8_000_000,
        framerate: 30,
      });
      add('VideoEncoder H.264 1080p', !!s.supported);
    } catch (e) {
      add('VideoEncoder H.264 1080p', false, String(e));
    }
  }

  add('AudioEncoder(WebCodecs)', typeof AudioEncoder !== 'undefined');
  if (typeof AudioEncoder !== 'undefined') {
    try {
      const s = await AudioEncoder.isConfigSupported({
        codec: 'mp4a.40.2',
        sampleRate: 48000,
        numberOfChannels: 1,
        bitrate: 128_000,
      });
      add('AudioEncoder AAC', !!s.supported);
    } catch (e) {
      add('AudioEncoder AAC', false, String(e));
    }
  }

  add('MediaStreamTrackProcessor', 'MediaStreamTrackProcessor' in window);
  add('MediaRecorder', typeof MediaRecorder !== 'undefined');
  if (typeof MediaRecorder !== 'undefined') {
    for (const t of ['video/mp4', 'video/mp4;codecs=avc1', 'video/webm']) {
      add(`MediaRecorder ${t}`, MediaRecorder.isTypeSupported(t));
    }
  }

  add('Screen Wake Lock', 'wakeLock' in navigator);
  add('OPFS(navigator.storage.getDirectory)', !!navigator.storage?.getDirectory);
  const canShareFiles =
    !!navigator.canShare && navigator.canShare({ files: [new File([''], 'a.mp4', { type: 'video/mp4' })] });
  add('Web Share(ファイル共有)', canShareFiles);
  add('vibrate', 'vibrate' in navigator, 'iOS Safari は非対応の可能性あり');
}

document.querySelector('#start')!.addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      audio: true,
    });
    (document.querySelector('#preview') as HTMLVideoElement).srcObject = stream;
    const s = stream.getVideoTracks()[0].getSettings();
    add('カメラ取得', true, `${s.width}x${s.height}@${s.frameRate}`);
  } catch (e) {
    add('カメラ取得', false, String(e));
  }
});

checkCapabilities();
