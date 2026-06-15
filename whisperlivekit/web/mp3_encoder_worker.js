// DEPRECATED: this file is a shim. Phase 2D-1 renamed the encoder worker to
// audio_encoder_worker.js to reflect that it actually emits WAV (and may
// emit MP3 in a future Phase 2D-2). The rewriter in web_interface.py was
// updated in lock-step so that BOTH '/web/mp3_encoder_worker.js' (legacy)
// and '/web/audio_encoder_worker.js' (canonical) resolve to the SAME Blob
// URL backed by the new audio_encoder_worker.js. Inlined HTML therefore
// never executes this file.
//
// This shim only runs in the unlikely scenario that the served HTML
// references '/web/mp3_encoder_worker.js' AND somehow bypasses the
// rewriter (e.g. raw static-file fetch of the legacy path). In that case
// we fall back to a no-op encoder that posts back an empty WAV blob on
// flush so the page does not crash.
//
// REMOVAL: planned for Phase 2D-3 after one release without breakage.
// See whisperlivekit/web/PHASE2_UI_DESIGN.md §9.3 step 3.

// Fallback no-op so the page does not crash if this shim runs unexpectedly.
self.onmessage = function (e) {
  const data = e.data || {};
  const command = data.command;
  if (command === 'flush') {
    self.postMessage({
      type: 'audio',
      format: 'wav',
      mimeType: 'audio/wav',
      blob: new Blob([], { type: 'audio/wav' })
    });
  }
};
