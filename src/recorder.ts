// 循環バッファ録画: 映像・音声をエンコード済みチャンクで保持し、ハイライト押下時に前後の区間だけ MP4 にする
import {
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
} from 'mediabunny';

type VChunk = { ts: number; key: boolean; chunk: EncodedVideoChunk };
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
};

export type Settings = { preSec: number; postSec: number };

export type Stats = {
  bufferedSec: number;
  bufferedMB: number;
  fps: number;
  dropped: number;
  encodeQueue: number;
  pending: number;
  hasAudio: boolean;
};

const KEY_INTERVAL_US = 1_000_000;
const AUDIO_BATCH_SAMPLES = 2048;

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
  private vMeta?: EncodedVideoChunkMetadata;
  private aMeta?: EncodedAudioChunkMetadata;
  private lastKeyTs = -Infinity;

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

  async start(stream: MediaStream, video: HTMLVideoElement): Promise<void> {
    this.stream = stream;
    video.srcObject = stream;
    await video.play();
    const width = video.videoWidth & ~1;
    const height = video.videoHeight & ~1;

    this.venc = new VideoEncoder({
      output: (chunk, meta) => this.onVideoChunk(chunk, meta),
      error: (e) => this.onLog(`VideoEncoder error: ${e}`),
    });
    this.venc.configure({
      codec: 'avc1.640028',
      width,
      height,
      bitrate: 8_000_000,
      framerate: 30,
      latencyMode: 'realtime',
      avc: { format: 'avc' },
    });

    try {
      await this.startAudio(stream);
    } catch (e) {
      this.hasAudio = false;
      this.onLog(`音声なしで続行: ${e}`);
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
    this.onLog(`録画開始 ${width}x${height}`);
  }

  private captureFrame(video: HTMLVideoElement, now: number) {
    const venc = this.venc!;
    if (venc.encodeQueueSize > 6) {
      this.dropped++;
      return;
    }
    const ts = Math.round(now * 1000);
    const key = ts - this.lastKeyTs >= KEY_INTERVAL_US;
    if (key) this.lastKeyTs = ts;
    const frame = new VideoFrame(video, { timestamp: ts, duration: 33_333 });
    venc.encode(frame, { keyFrame: key });
    frame.close();

    this.frameCount++;
    if (now - this.fpsWindowStart >= 1000) {
      this.fps = (this.frameCount * 1000) / (now - this.fpsWindowStart);
      this.frameCount = 0;
      this.fpsWindowStart = now;
    }
  }

  private async startAudio(stream: MediaStream) {
    if (stream.getAudioTracks().length === 0) throw new Error('音声トラックなし');
    const ctx = new AudioContext();
    await ctx.resume();
    const url = URL.createObjectURL(new Blob([WORKLET_CODE], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    const aenc = new AudioEncoder({
      output: (chunk, meta) => this.onAudioChunk(chunk, meta),
      error: (e) => this.onLog(`AudioEncoder error: ${e}`),
    });
    aenc.configure({ codec: 'mp4a.40.2', sampleRate: ctx.sampleRate, numberOfChannels: 1, bitrate: 128_000 });

    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'cap');
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);
    node.port.onmessage = (e: MessageEvent<Float32Array>) => this.onPcm(e.data);

    this.audioCtx = ctx;
    this.aenc = aenc;
    this.hasAudio = true;
  }

  private onPcm(samples: Float32Array) {
    const ctx = this.audioCtx!;
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

  private onVideoChunk(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) {
    if (!this.vMeta && meta?.decoderConfig) this.vMeta = meta;
    const v: VChunk = { ts: chunk.timestamp, key: chunk.type === 'key', chunk };
    this.lastVideoTs = v.ts;
    this.vRing.push(v);
    for (const p of this.pending) p.video.push(v);
    this.prune(v.ts);
    this.finalizeReady();
  }

  private onAudioChunk(chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) {
    if (!this.aMeta && meta?.decoderConfig) this.aMeta = meta;
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
    if (!this.running || this.lastVideoTs < 0) return '録画中ではありません';
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
      (p) => this.lastVideoTs >= p.endTs && (!this.hasAudio || this.lastAudioTs >= p.endTs),
    );
    for (const p of ready) {
      this.pending.splice(this.pending.indexOf(p), 1);
      this.mux(p).catch((e) => this.onLog(`MP4化失敗: ${e}`));
    }
  }

  private async mux(p: Pending) {
    const base = p.video[0].ts;
    const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
    const vs = new EncodedVideoPacketSource('avc');
    output.addVideoTrack(vs);
    const withAudio = this.hasAudio && !!this.aMeta && p.audio.length > 0;
    const as = withAudio ? new EncodedAudioPacketSource('aac') : undefined;
    if (as) output.addAudioTrack(as);
    await output.start();

    const toPacket = (c: EncodedVideoChunk | EncodedAudioChunk) =>
      EncodedPacket.fromEncodedChunk(c).clone({ timestamp: (c.timestamp - base) / 1e6 });

    const videoJob = (async () => {
      for (let i = 0; i < p.video.length; i++) {
        await vs.add(toPacket(p.video[i].chunk), i === 0 ? this.vMeta : undefined);
      }
      vs.close();
    })();
    const audioJob = (async () => {
      if (!as) return;
      for (let i = 0; i < p.audio.length; i++) {
        await as.add(toPacket(p.audio[i].chunk), i === 0 ? this.aMeta : undefined);
      }
      as.close();
    })();
    await Promise.all([videoJob, audioJob]);
    await output.finalize();

    const buffer = output.target.buffer;
    if (!buffer) throw new Error('出力バッファが空です');
    const blob = new Blob([buffer], { type: 'video/mp4' });
    this.onClip({
      id: this.nextClipId++,
      blob,
      url: URL.createObjectURL(blob),
      durationSec: (p.endTs - base) / 1e6,
      markedAtSec: (p.markedAt - this.startedAtMs * 1000) / 1e6,
    });
  }

  getStats(): Stats {
    const first = this.vRing[0]?.ts ?? 0;
    const last = this.lastVideoTs < 0 ? 0 : this.lastVideoTs;
    let bytes = 0;
    for (const v of this.vRing) bytes += v.chunk.byteLength;
    for (const a of this.aRing) bytes += a.chunk.byteLength;
    return {
      bufferedSec: (last - first) / 1e6,
      bufferedMB: bytes / 1e6,
      fps: this.fps,
      dropped: this.dropped,
      encodeQueue: this.venc?.encodeQueueSize ?? 0,
      pending: this.pending.length,
      hasAudio: this.hasAudio,
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
    this.onLog('録画停止');
  }
}
