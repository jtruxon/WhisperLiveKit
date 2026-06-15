# AGENTS.md

This file provides guidance to agents when working with code in this repository.

WhisperLiveKit is a real-time, multi-backend streaming ASR server (FastAPI + WebSocket). [`CLAUDE.md`](CLAUDE.md:1) is the longer canonical companion to this file — read it for the full architecture, the `TestHarness` API, and the recipe for adding a new ASR backend.

## Commands (uv only — never `pip` or `python` directly)

- Server: `uv run wlk --model base --language en` (entry point [`whisperlivekit.cli:main`](whisperlivekit/cli.py:1)) or `uv run whisperlivekit-server` ([`basic_server.py`](whisperlivekit/basic_server.py:336)).
- Diagnose a real audio file end-to-end: `uv run wlk diagnose path/to/audio.wav` (best first debug step).
- Install test deps: `uv sync --extra test` (extras, not deps).
- Full tests: `uv run pytest tests/ -v` — single test: `uv run pytest tests/test_pipeline.py::test_name -v`.
- Pipeline E2E with Qwen3 vLLM: `WLK_RUN_QWEN3_VLLM_E2E=1 uv run pytest tests/test_pipeline.py`.
- Lint (only check used in CI): `uv run ruff check .`. There is **no formatter configured** — do not introduce black/isort.
- CI runs only `ruff check` + an import-only smoke test across Py 3.11/3.12/3.13. **No tests run in CI.**

## Critical non-obvious rules

- **Singleton engine**: [`TranscriptionEngine`](whisperlivekit/core.py:37) is a double-checked-locked singleton; constructing it twice returns the same instance. `TranscriptionEngine.reset()` is **test-only** — calling it in production kills every active session. Tests use it inside `try/finally` to switch backends.
- **`engine.config` and `engine.args` are both kept on purpose** ([`core.py:94-97`](whisperlivekit/core.py:94)). `AudioProcessor` reads `self.args.*` for backward compat — never delete `args`.
- **Per-session language**: never mutate `asr.original_language` directly. Pass `language=` to `online_factory()` so it gets wrapped in [`SessionASRProxy`](whisperlivekit/session_asr_proxy.py:10), which serializes language swaps under a lazily-attached `_session_lock`. Direct mutation races across sessions.
- **Vendored Whisper fork** lives at [`whisperlivekit/whisper/`](whisperlivekit/whisper/__init__.py:1) (version `20250625`). Imports use `from whisperlivekit.whisper import …`, **not** PyPI's `openai-whisper`. Modifications support hookless decoding for SimulStreaming (per-session [`DecoderState`](whisperlivekit/simul_whisper/decoder_state.py:1) on a shared model). Fix bugs here, not upstream. Lint exemptions for this dir already exist in [`pyproject.toml`](pyproject.toml:153).
- **Wire format**: [`FrontData.to_dict()`](whisperlivekit/timed_objects.py:196) is the canonical message. Adding/renaming a field breaks the bundled JS client, the diff protocol ([`diff_protocol.py`](whisperlivekit/diff_protocol.py:39)), AND the OpenAI REST adapter ([`basic_server._format_openai_response`](whisperlivekit/basic_server.py:174)) — update all three. Speaker `-2` = silence (5s threshold).
- **Backend selection**: `--backend auto` only chooses among Whisper-family backends ([`_normalize_backend_choice`](whisperlivekit/local_agreement/whisper_online.py:164)). Voxtral / Qwen3 must be selected explicitly. When adding a backend, also touch: `--backend choices=` in [`parse_args.py:150`](whisperlivekit/parse_args.py:147), `BACKENDS` + `MODEL_CATALOG` in [`cli.py:52`](whisperlivekit/cli.py:52), and possibly `BATCH_FLUSH_BACKENDS` in [`tests/test_pipeline.py:78`](tests/test_pipeline.py:78).
- **Mutually-exclusive extras** are enumerated in [`[tool.uv.conflicts]`](pyproject.toml:84): e.g. `voxtral-hf` ⊥ `diarization-sortformer`, `qwen3-vllm` ⊥ `cu129`, `cpu` ⊥ `cu129`. `uv sync --extra A --extra B` will fail for these pairs.
- **Heavy backend calls run in `asyncio.to_thread`** (see [`audio_processor.py:308,408`](whisperlivekit/audio_processor.py:308)) because the processors live on the event loop. Never call `model.transcribe(...)` inline from an async task.
- **Sortformer raises `SystemExit` (not ImportError) on missing `nemo`** at module import ([`sortformer_backend.py:14`](whisperlivekit/diarization/sortformer_backend.py:13)) — beware import order.
- **Bundled web assets**: [`get_inline_ui_html`](whisperlivekit/web/web_interface.py:16) inlines HTML/CSS/JS/SVGs into a single `/` response and rewrites the strings `/web/pcm_worklet.js` and `/web/recorder_worker.js` into Blob URLs. Don't change those exact substrings in the JS or rewriting silently breaks.
- **Bundled VAD**: [`silero_vad_models/`](whisperlivekit/silero_vad_models/__init__.py:1) ships ONNX + JIT models. Without `onnxruntime` installed, the JIT model is loaded **per-session** (slow, memory-heavy) — install `onnxruntime` for multi-user deployments ([`core.py:104-114`](whisperlivekit/core.py:104)).
- **Corporate cert blocks** in both Dockerfiles and the workspace-root [`Zscaler Root CA.pem`](Zscaler%20Root%20CA.pem:1) are intentional (Corning/Zscaler proxy). Don't delete them.
- **`--never-fire` / `--cif-ckpt-path`**: there is no CIF checkpoint for `large-v3` ([`parse_args.py:316`](whisperlivekit/parse_args.py:316)); without one, the last decoded word is always trimmed unless `--never-fire` is set.
- **`--lora-path` works only with the native `whisper` backend**, not faster-whisper or mlx ([`parse_args.py:109`](whisperlivekit/parse_args.py:109)).
- **`.en` suffix on a model name forces English** regardless of `--language` ([`config.py:97-99`](whisperlivekit/config.py:97)).
- **Diff vs full mode**: `?mode=diff` opt-in. Full-mode messages have **no `type` field**; diff-mode messages do (`snapshot` | `diff`). See [`docs/API.md`](docs/API.md:1) for the canonical wire spec.
- **Tests**: pytest + pytest-asyncio, default discovery (no pytest config). Pipeline tests download real audio + models on first run. MLX/Voxtral/Qwen3 backends are silently skipped when unavailable — no `pytest.skip`. Mock-based unit tests are discouraged (use [`TestHarness`](whisperlivekit/test_harness.py:1)) **except** for low-level regression tests in [`tests/test_backend_deep_bugs.py`](tests/test_backend_deep_bugs.py:1).

## Code style ([`pyproject.toml`](pyproject.toml:145))

`ruff` only. `target-version = "py311"`, `line-length = 120`. Selected: `E,F,W,I`. Ignored: `E501` (line length warnings disabled despite the 120 setting), `E741`. Per-file ignores for the vendored whisper fork and MLX glue — preserve them when refactoring.
