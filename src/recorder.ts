// 循環バッファ録画: 映像・音声をエンコード済みチャンクで保持し、ハイライト押下時に前後の区間だけ MP4 にする
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Input,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
} from 'mediabunny';

// 向き(映像サイズ)が変わるたびにエンコーダを作り直す。1つの世代(epoch)は1つの映像サイズ・1つの decoderConfig を持つ
type Epoch = { id: number; width: number; height: number; meta?: EncodedVideoChunkMetadata };

type VChunk = { ts: number; key: boolean; chunk: EncodedVideoChunk; epoch: Epoch };
type AChunk = { ts: number; chunk: EncodedAudioChunk };

type Pending = {
  endTs: number;
  video: VChunk[];
  audio: AChunk[];
  markedAt: number;
};

export type Clip = {
  id: number;
  blob: Blob;
  url: string;
  durationSec: number;
  markedAtSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
};

export type Settings = { preSec: number; postSec: number };

export type Stats = {
  bufferedSec: number;
  bufferedMB: number;
  fps: number;
  dropped: number;
  encodeQueue: number;
  pending: number;
  width: number;
  height: number;
  audio: {
    enabled: boolean;
    ctxState: string;
    sampleRate: number;
    pcmCount: number;
    chunkCount: number;
    hasConfig: boolean;
    level: number;
  };
};

const hex = (d: Uint8Array) => Array.from(d, (b) => b.toString(16).padStart(2, '0')).join(' ');

const toBytes = (d: AllowSharedBufferSource) =>
  ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d);

// MPEG-4 記述子の長さ(可変長: 上位ビットが継続フラグ)を読む
const readDescLen = (d: Uint8Array, pos: number): [number, number] => {
  let len = 0;
  for (let k = 0; k < 4; k++) {
    const b = d[pos++];
    len = (len << 7) | (b & 0x7f);
    if (!(b & 0x80)) break;
  }
  return [len, pos];
};

/**
 * Safari の AudioEncoder は decoderConfig.description に ES_Descriptor(esds の中身, 39B など)を返す。
 * MP4 の esds には AudioSpecificConfig(2B 程度)だけを入れる必要があるため、ここから取り出す。
 * ES_Descriptor でなければ(先頭が 0x03 以外)そのまま返す。
 */
const extractAudioSpecificConfig = (desc: Uint8Array): Uint8Array => {
  if (desc[0] !== 0x03) return desc;
  let [, pos] = readDescLen(desc, 1); // ES_Descriptor
  const flags = desc[pos + 2];
  pos += 3; // ES_ID(2) + flags(1)
  if (flags & 0x80) pos += 2; // streamDependence
  if (flags & 0x40) pos += 1 + desc[pos]; // URL
  if (flags & 0x20) pos += 2; // OCR
  if (desc[pos] !== 0x04) return desc;
  [, pos] = readDescLen(desc, pos + 1); // DecoderConfigDescriptor
  pos += 13; // objectType(1) streamType(1) bufferSize(3) maxBitrate(4) avgBitrate(4)
  if (desc[pos] !== 0x05) return desc;
  const [len, start] = readDescLen(desc, pos + 1); // DecoderSpecificInfo = AudioSpecificConfig
  return desc.slice(start, start + len);
};

const KEY_INTERVAL_US = 1_000_000;
const AUDIO_BATCH_SAMPLES = 2048;
const AUDIO_WAIT_LIMIT_US = 2_000_000;

const WORKLET_CODE = `
class Cap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      const copy = ch.slice(0);
      this.port.postMessage(copy, [copy.buffer]);
    }
    return true;
  }
}
registerProcessor('cap', Cap);
`;

export class Recorder {
  private running = false;
  private startedAtMs = 0;

  private venc?: VideoEncoder;
  private aenc?: AudioEncoder;
  private aMeta?: EncodedAudioChunkMetadata; // MP4 用(description は AudioSpecificConfig に整形済み)
  private aMetaRaw?: EncodedAudioChunkMetadata; // エンコーダが返した元の設定(復号チェック用)
  private lastKeyTs = -Infinity;
  private epoch: Epoch = { id: 0, width: 0, height: 0 };

  private vRing: VChunk[] = [];
  private aRing: AChunk[] = [];
  private pending: Pending[] = [];
  private lastVideoTs = -1;
  private lastAudioTs = -1;
  private hasAudio = false;

  private audioCtx?: AudioContext;
  private audioTs0 = -1;
  private audioSamplesSent = 0;
  private audioBuf: Float32Array[] = [];
  private audioBufLen = 0;
  private pcmCount = 0;
  private audioChunkCount = 0;
  private level = 0;

  private frameCount = 0;
  private fps = 0;
  private fpsWindowStart = 0;
  private dropped = 0;
  private nextClipId = 1;
  private wakeLock?: WakeLockSentinel;
  private stream?: MediaStream;

  private getSettings: () => Settings;
  private onClip: (clip: Clip) => void;
  private onLog: (msg: string) => void;

  constructor(getSettings: () => Settings, onClip: (clip: Clip) => void, onLog: (msg: string) => void) {
    this.getSettings = getSettings;
    this.onClip = onClip;
    this.onLog = onLog;
  }

  /** audioCtx はタップ操作の中で作成・resume 済みのものを渡す(iOS は操作外だと suspended のままになるため) */
  async start(stream: MediaStream, video: HTMLVideoElement, audioCtx: AudioContext): Promise<void> {
    this.resetState();
    this.stream = stream;
    video.srcObject = stream;
    await video.play();
    // エンコーダは最初のフレームの実サイズで作る(video.videoWidth は向きの反映が遅れることがあるため当てにしない)

    try {
      await this.startAudio(stream, audioCtx);
    } catch (e) {
      this.hasAudio = false;
      this.onLog(`音声なしで続行: ${e instanceof Error ? `${e.name}: ${e.message}` : e}`);
    }

    try {
      this.wakeLock = await navigator.wakeLock?.request('screen');
    } catch (e) {
      this.onLog(`Wake Lock 失敗: ${e}`);
    }

    this.running = true;
    this.startedAtMs = performance.now();
    this.fpsWindowStart = this.startedAtMs;
    const loop = (now: number) => {
      if (!this.running) return;
      this.captureFrame(video, now);
      video.requestVideoFrameCallback(loop);
    };
    video.requestVideoFrameCallback(loop);
    const ts = stream.getVideoTracks()[0]?.getSettings();
    this.onLog(`録画開始 track=${ts?.width}x${ts?.height} video要素=${video.videoWidth}x${video.videoHeight}`);
  }

  // 停止・再開始をまたいで前回の状態(バッファ、音声のタイムスタンプ、AAC設定など)を持ち越さないよう初期化する
  private resetState() {
    this.venc = undefined;
    this.aenc = undefined;
    this.audioCtx = undefined;
    this.stream = undefined;
    this.wakeLock = undefined;
    this.aMeta = undefined;
    this.aMetaRaw = undefined;
    this.lastKeyTs = -Infinity;
    this.epoch = { id: this.epoch.id, width: 0, height: 0 }; // 次のフレームでエンコーダを作り直させる
    this.vRing = [];
    this.aRing = [];
    this.pending = [];
    this.lastVideoTs = -1;
    this.lastAudioTs = -1;
    this.hasAudio = false;
    this.audioTs0 = -1;
    this.audioSamplesSent = 0;
    this.audioBuf = [];
    this.audioBufLen = 0;
    this.pcmCount = 0;
    this.audioChunkCount = 0;
    this.level = 0;
    this.frameCount = 0;
    this.fps = 0;
    this.dropped = 0;
  }

  // 映像サイズに合わせてエンコーダを(再)作成する
  private configureVideo(width: number, height: number) {
    const epoch: Epoch = { id: this.epoch.id + 1, width, height };
    this.epoch = epoch;
    this.venc?.close();
    const venc = new VideoEncoder({
      output: (chunk, meta) => this.onVideoChunk(epoch, chunk, meta),
      error: (e) => this.onLog(`VideoEncoder error: ${e}`),
    });
    venc.configure({
      codec: 'avc1.640028',
      width,
      height,
      bitrate: 8_000_000,
      framerate: 30,
      latencyMode: 'realtime',
      avc: { format: 'avc' },
    });
    this.venc = venc;
    this.lastKeyTs = -Infinity;
  }

  // 向きが変わったら、待機中のハイライトをそこまでで確定し、バッファを捨てて新しい向きで撮り直す
  private onOrientationChange(width: number, height: number, video: HTMLVideoElement) {
    const first = this.epoch.width === 0;
    this.onLog(
      `${first ? '映像サイズ確定' : `向き変更 ${this.epoch.width}x${this.epoch.height} →`} ${width}x${height} ` +
        `(video要素=${video.videoWidth}x${video.videoHeight})`,
    );
    for (const p of this.pending.splice(0)) {
      p.endTs = Math.min(p.endTs, this.lastVideoTs);
      this.mux(p).catch((e) => this.onLog(`MP4化失敗: ${e}`));
    }
    this.vRing = [];
    this.lastVideoTs = -1;
    this.configureVideo(width, height);
  }

  private captureFrame(video: HTMLVideoElement, now: number) {
    if (this.venc && this.venc.encodeQueueSize > 6) {
      this.dropped++;
      return;
    }
    const ts = Math.round(now * 1000);
    const frame = new VideoFrame(video, { timestamp: ts, duration: 33_333 });
    // フレーム自身のサイズで向きを判定する。エンコーダの設定サイズとフレームのサイズが違うと、映像が引き伸ばされて保存される
    const width = frame.displayWidth & ~1;
    const height = frame.displayHeight & ~1;
    if (width > 0 && height > 0 && (width !== this.epoch.width || height !== this.epoch.height)) {
      this.onOrientationChange(width, height, video);
    }
    const venc = this.venc;
    if (!venc) {
      frame.close();
      return;
    }
    const key = ts - this.lastKeyTs >= KEY_INTERVAL_US;
    if (key) this.lastKeyTs = ts;
    venc.encode(frame, { keyFrame: key });
    frame.close();

    this.frameCount++;
    if (now - this.fpsWindowStart >= 1000) {
      this.fps = (this.frameCount * 1000) / (now - this.fpsWindowStart);
      this.frameCount = 0;
      this.fpsWindowStart = now;
    }
  }

  private async startAudio(stream: MediaStream, ctx: AudioContext) {
    if (stream.getAudioTracks().length === 0) throw new Error('音声トラックなし');
    this.audioCtx = ctx;
    ctx.onstatechange = () => this.onLog(`AudioContext: ${ctx.state}`);
    if (ctx.state !== 'running') await ctx.resume();
    if (ctx.state !== 'running') this.onLog(`AudioContext が running になりません(${ctx.state})`);

    const url = URL.createObjectURL(new Blob([WORKLET_CODE], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    const aenc = new AudioEncoder({
      output: (chunk, meta) => this.onAudioChunk(chunk, meta),
      error: (e) => this.onLog(`AudioEncoder error: ${e}`),
    });
    aenc.configure({
      codec: 'mp4a.40.2',
      sampleRate: ctx.sampleRate,
      numberOfChannels: 1,
      bitrate: 128_000,
      aac: { format: 'aac' },
    });

    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'cap');
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);
    node.port.onmessage = (e: MessageEvent<Float32Array>) => this.onPcm(e.data);

    this.aenc = aenc;
    this.hasAudio = true;
  }

  private onPcm(samples: Float32Array) {
    const ctx = this.audioCtx!;
    this.pcmCount++;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    this.level = Math.max(this.level, Math.sqrt(sum / samples.length));

    if (this.audioTs0 < 0) {
      this.audioTs0 = performance.now() * 1000 - (samples.length / ctx.sampleRate) * 1e6;
    }
    this.audioBuf.push(samples);
    this.audioBufLen += samples.length;
    if (this.audioBufLen < AUDIO_BATCH_SAMPLES) return;

    const data = new Float32Array(this.audioBufLen);
    let off = 0;
    for (const b of this.audioBuf) {
      data.set(b, off);
      off += b.length;
    }
    this.audioBuf = [];
    this.audioBufLen = 0;

    const ts = Math.round(this.audioTs0 + (this.audioSamplesSent / ctx.sampleRate) * 1e6);
    this.audioSamplesSent += data.length;
    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate: ctx.sampleRate,
      numberOfFrames: data.length,
      numberOfChannels: 1,
      timestamp: ts,
      data,
    });
    this.aenc!.encode(audioData);
    audioData.close();
  }

  private onVideoChunk(epoch: Epoch, chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) {
    if (epoch !== this.epoch) return; // 向き変更前のエンコーダから遅れて届いたチャンクは捨てる
    if (!epoch.meta && meta?.decoderConfig) epoch.meta = meta;
    const v: VChunk = { ts: chunk.timestamp, key: chunk.type === 'key', chunk, epoch };
    this.lastVideoTs = v.ts;
    this.vRing.push(v);
    for (const p of this.pending) p.video.push(v);
    this.prune(v.ts);
    this.finalizeReady();
  }

  private onAudioChunk(chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) {
    this.audioChunkCount++;
    if (this.audioChunkCount === 1) {
      const head = new Uint8Array(4);
      chunk.copyTo(head.subarray(0, Math.min(4, chunk.byteLength)));
      const cfg = meta?.decoderConfig;
      const desc = cfg?.description ? toBytes(cfg.description) : undefined;
      this.onLog(
        `AAC先頭チャンク: ${chunk.byteLength}B 先頭=${hex(head)} ` +
          `codec=${cfg?.codec} ${cfg?.sampleRate}Hz ${cfg?.numberOfChannels}ch description=${desc?.byteLength ?? 0}B`,
      );
      if (desc) this.onLog(`AAC description: ${hex(desc)} → AudioSpecificConfig: ${hex(extractAudioSpecificConfig(desc))}`);
    }
    if (!this.aMeta && meta?.decoderConfig) {
      this.aMetaRaw = meta;
      const cfg = meta.decoderConfig;
      this.aMeta = cfg.description
        ? { decoderConfig: { ...cfg, description: extractAudioSpecificConfig(toBytes(cfg.description)) } }
        : meta;
    }
    const a: AChunk = { ts: chunk.timestamp, chunk };
    this.lastAudioTs = a.ts;
    this.aRing.push(a);
    for (const p of this.pending) p.audio.push(a);
    this.finalizeReady();
  }

  // 前N秒より古いチャンクを破棄する(先頭は必ずキーフレームになるよう、直前のキーフレームまで残す)
  private prune(nowTs: number) {
    const cutoff = nowTs - this.getSettings().preSec * 1e6;
    let idx = -1;
    for (let i = this.vRing.length - 1; i >= 0; i--) {
      if (this.vRing[i].key && this.vRing[i].ts <= cutoff) {
        idx = i;
        break;
      }
    }
    if (idx > 0) this.vRing.splice(0, idx);
    const firstTs = this.vRing[0]?.ts ?? 0;
    let n = 0;
    while (n < this.aRing.length && this.aRing[n].ts < firstTs) n++;
    if (n > 0) this.aRing.splice(0, n);
  }

  /** ハイライトを記録する。戻り値は結果メッセージ */
  highlight(): string {
    if (!this.running || this.lastVideoTs < 0 || this.vRing.length === 0) return '録画中ではありません';
    const { preSec, postSec } = this.getSettings();
    const T = this.lastVideoTs;
    const startTs = T - preSec * 1e6;
    const endTs = T + postSec * 1e6;

    const overlapped = this.pending.find((p) => startTs <= p.endTs);
    if (overlapped) {
      overlapped.endTs = endTs;
      return '直前のハイライトと範囲が重なったため統合しました';
    }

    let idx = 0;
    for (let i = this.vRing.length - 1; i >= 0; i--) {
      if (this.vRing[i].key && this.vRing[i].ts <= startTs) {
        idx = i;
        break;
      }
    }
    const video = this.vRing.slice(idx);
    const base = video[0].ts;
    const audio = this.aRing.filter((a) => a.ts >= base);
    this.pending.push({ endTs, video, audio, markedAt: T });
    return `ハイライトを記録しました(後${postSec}秒待機中)`;
  }

  private finalizeReady() {
    const ready = this.pending.filter(
      (p) =>
        this.lastVideoTs >= p.endTs &&
        (!this.hasAudio || this.lastAudioTs >= p.endTs || this.lastVideoTs >= p.endTs + AUDIO_WAIT_LIMIT_US),
    );
    for (const p of ready) {
      this.pending.splice(this.pending.indexOf(p), 1);
      this.mux(p).catch((e) => this.onLog(`MP4化失敗: ${e}`));
    }
  }

  private async mux(p: Pending) {
    const first = p.video[0];
    const base = first.ts;
    const epoch = first.epoch;
    const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
    const vs = new EncodedVideoPacketSource('avc');
    output.addVideoTrack(vs);

    // 状態リセット(停止・再開始)が await 中に走っても影響しないよう、先に取り出しておく
    const aMeta = this.aMeta;
    const aRawCfg = this.aMetaRaw?.decoderConfig;
    let audioReason = '';
    if (!this.hasAudio) audioReason = '音声機能が無効';
    else if (!aMeta) audioReason = 'AACのdecoderConfigが取得できていない';
    else if (p.audio.length === 0) audioReason = '音声チャンクが0件';
    const withAudio = audioReason === '';
    const as = withAudio ? new EncodedAudioPacketSource('aac') : undefined;
    if (as) output.addAudioTrack(as);
    if (!withAudio) this.onLog(`このクリップは音声なし: ${audioReason}`);
    await output.start();

    // p.video は向き変更前のチャンクを含まない(向き変更時にバッファを捨てているため)ので、先頭の世代のものだけ使う
    const videos = p.video.filter((v) => v.epoch === epoch);
    const toPacket = (c: EncodedVideoChunk | EncodedAudioChunk) =>
      EncodedPacket.fromEncodedChunk(c).clone({ timestamp: (c.timestamp - base) / 1e6 });

    const videoJob = (async () => {
      for (let i = 0; i < videos.length; i++) {
        await vs.add(toPacket(videos[i].chunk), i === 0 ? epoch.meta : undefined);
      }
      vs.close();
    })();
    const audioJob = (async () => {
      if (!as) return;
      for (let i = 0; i < p.audio.length; i++) {
        await as.add(toPacket(p.audio[i].chunk), i === 0 ? aMeta : undefined);
      }
      as.close();
    })();
    await Promise.all([videoJob, audioJob]);
    await output.finalize();

    const buffer = output.target.buffer;
    if (!buffer) throw new Error('出力バッファが空です');
    const blob = new Blob([buffer], { type: 'video/mp4' });
    if (withAudio && aRawCfg) {
      this.checkAudioDecode(aRawCfg, p.audio).then((m) => this.onLog(`音声チェック(エンコード結果の復号): ${m}`));
      this.verifyMp4(blob).then((m) => this.onLog(`音声チェック(MP4の中身): ${m}`));
    }
    this.onClip({
      id: this.nextClipId++,
      blob,
      url: URL.createObjectURL(blob),
      durationSec: (Math.min(p.endTs, videos[videos.length - 1].ts) - base) / 1e6,
      markedAtSec: (p.markedAt - this.startedAtMs * 1000) / 1e6,
      width: epoch.width,
      height: epoch.height,
      hasAudio: withAudio,
    });
  }

  // エンコード済み音声を実際に復号して、無音でないか(RMS)を確認する診断
  private async checkAudioDecode(cfg: AudioDecoderConfig, chunks: AChunk[]): Promise<string> {
    try {
      const support = await AudioDecoder.isConfigSupported(cfg);
      if (!support.supported) return `復号非対応(${cfg.codec})`;
      let samples = 0;
      let sum = 0;
      const dec = new AudioDecoder({
        output: (d) => {
          const buf = new Float32Array(d.numberOfFrames);
          d.copyTo(buf, { planeIndex: 0, format: 'f32-planar' });
          for (const s of buf) sum += s * s;
          samples += buf.length;
          d.close();
        },
        error: (e) => this.onLog(`AudioDecoder error: ${e}`),
      });
      dec.configure(cfg);
      for (const c of chunks.slice(0, 40)) dec.decode(c.chunk);
      await dec.flush();
      dec.close();
      return `${samples}サンプル RMS=${samples ? Math.sqrt(sum / samples).toFixed(4) : 'なし'}`;
    } catch (e) {
      return `失敗 ${e instanceof Error ? `${e.name}: ${e.message}` : e}`;
    }
  }

  // 出来上がった MP4 を読み直して、音声トラックの有無と長さを確認する診断
  private async verifyMp4(blob: Blob): Promise<string> {
    try {
      const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
      const track = await input.getPrimaryAudioTrack();
      if (!track) return '音声トラックなし';
      const cfg = await track.getDecoderConfig();
      const dur = await track.computeDuration();
      return `音声トラックあり ${dur.toFixed(1)}秒 codec=${cfg?.codec} ${cfg?.sampleRate}Hz ${cfg?.numberOfChannels}ch`;
    } catch (e) {
      return `失敗 ${e instanceof Error ? `${e.name}: ${e.message}` : e}`;
    }
  }

  getStats(): Stats {
    const first = this.vRing[0]?.ts ?? 0;
    const last = this.lastVideoTs < 0 ? 0 : this.lastVideoTs;
    let bytes = 0;
    for (const v of this.vRing) bytes += v.chunk.byteLength;
    for (const a of this.aRing) bytes += a.chunk.byteLength;
    const level = this.level;
    this.level = 0;
    return {
      bufferedSec: (last - first) / 1e6,
      bufferedMB: bytes / 1e6,
      fps: this.fps,
      dropped: this.dropped,
      encodeQueue: this.venc?.encodeQueueSize ?? 0,
      pending: this.pending.length,
      width: this.epoch.width,
      height: this.epoch.height,
      audio: {
        enabled: this.hasAudio,
        ctxState: this.audioCtx?.state ?? 'なし',
        sampleRate: this.audioCtx?.sampleRate ?? 0,
        pcmCount: this.pcmCount,
        chunkCount: this.audioChunkCount,
        hasConfig: !!this.aMeta,
        level,
      },
    };
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    try {
      await this.venc?.flush();
      await this.aenc?.flush();
    } catch (e) {
      this.onLog(`flush 失敗: ${e}`);
    }
    // 後N秒が揃っていないハイライトも、ここまでの分でMP4にする
    for (const p of this.pending.splice(0)) {
      p.endTs = Math.min(p.endTs, this.lastVideoTs);
      await this.mux(p).catch((e) => this.onLog(`MP4化失敗: ${e}`));
    }
    this.venc?.close();
    this.aenc?.close();
    await this.audioCtx?.close();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.wakeLock?.release().catch(() => {});
    this.resetState();
    this.onLog('録画停止(バッファをリセットしました)');
  }
}
