// マイク入力の PCM をメインスレッドへ渡す AudioWorklet。
// CSP(script-src 'self')を厳しく保つため、Blob URL ではなく静的ファイルとして配信する。
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
