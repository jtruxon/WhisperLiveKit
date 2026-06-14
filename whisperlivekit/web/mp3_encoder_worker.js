// WAV Encoder Web Worker
// Accumulates Float32 PCM samples and encodes them to WAV format on flush.
// Despite the filename (kept for API consistency), this produces WAV audio
// which browsers can play natively without any external libraries.

let sampleRate = 16000;
let samples = [];
let totalSamples = 0;

self.onmessage = function (e) {
  switch (e.data.command) {
    case 'init':
      sampleRate = e.data.sampleRate || 16000;
      samples = [];
      totalSamples = 0;
      break;

    case 'encode':
      // Accumulate Float32 PCM samples
      if (e.data.buffer) {
        const chunk = new Float32Array(e.data.buffer);
        samples.push(chunk);
        totalSamples += chunk.length;
      }
      break;

    case 'flush':
      // Encode all accumulated samples into a WAV blob
      if (totalSamples > 0) {
        const wavBlob = encodeWAV(samples, totalSamples, sampleRate);
        self.postMessage({ type: 'mp3', blob: wavBlob });
      } else {
        self.postMessage({ type: 'mp3', blob: null });
      }
      // Reset after flush
      samples = [];
      totalSamples = 0;
      break;

    case 'reset':
      samples = [];
      totalSamples = 0;
      break;
  }
};

function encodeWAV(chunks, totalLength, rate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = totalLength * bytesPerSample;
  const headerSize = 44;
  const buffer = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true); // file size - 8
  writeString(view, 8, 'WAVE');

  // fmt sub-chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // sub-chunk size (16 for PCM)
  view.setUint16(20, 1, true);  // audio format (1 = PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, rate, true); // sample rate
  view.setUint32(28, rate * numChannels * bytesPerSample, true); // byte rate
  view.setUint16(32, numChannels * bytesPerSample, true); // block align
  view.setUint16(34, bitsPerSample, true);

  // data sub-chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Write PCM samples: convert Float32 [-1, 1] to Int16
  let offset = 44;
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    for (let i = 0; i < chunk.length; i++) {
      const s = Math.max(-1, Math.min(1, chunk[i]));
      const val = s < 0 ? s * 0x8000 : s * 0x7FFF;
      view.setInt16(offset, val, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
