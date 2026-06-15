# Code Mode Rules — WhisperLiveKit (Non-Obvious Only)

Read [`AGENTS.md`](../../AGENTS.md:1) and [`CLAUDE.md`](../../CLAUDE.md:1) first. These are deltas for code-writing tasks.

- **`uv` is the package manager.** Use `uv add <pkg>`, `uv sync --extra <name>`, `uv run …`. Never `pip install` or run `python` directly — the Dockerfiles use `uv` too.
- **Heavy model calls MUST be wrapped in `asyncio.to_thread`** ([`audio_processor.py:308,408`](../../whisperlivekit/audio_processor.py:308)). Calling `model.transcribe(...)` inline from an async task blocks every WebSocket session in the worker.
- **Per-session language goes through [`SessionASRProxy`](../../whisperlivekit/session_asr_proxy.py:10)** — pass `language=` to `online_factory()`. Never assign `asr.original_language = …` directly: it races across sessions because the ASR is a shared singleton.
- **Adding a new ASR backend touches FIVE places**, not one:
  1. The backend class itself (interface in [`CLAUDE.md`](../../CLAUDE.md:1) — `transcribe`, `ts_words`, `segments_end_ts`, `use_vad`, `sep`, `original_language`, `backend_choice`, `SAMPLING_RATE`, `confidence_validation`, `tokenizer`, `buffer_trimming`, `buffer_trimming_sec`).
  2. `--backend choices=[…]` in [`parse_args.py:147`](../../whisperlivekit/parse_args.py:147).
  3. `BACKENDS` table + `MODEL_CATALOG` in [`cli.py:52`](../../whisperlivekit/cli.py:52) (so `wlk models` / `wlk pull` work).
  4. `_normalize_backend_choice` in [`whisper_online.py:164`](../../whisperlivekit/local_agreement/whisper_online.py:164) — **only if it's a Whisper-family backend** that should participate in `--backend auto`.
  5. `BATCH_FLUSH_BACKENDS` in [`tests/test_pipeline.py:78`](../../tests/test_pipeline.py:78) — if it's a generative streaming backend (looser thresholds, no monotonic-timestamp assertions).
- **Wire format = [`FrontData.to_dict()`](../../whisperlivekit/timed_objects.py:196).** Renaming/removing a field there silently breaks: (a) the bundled JS client in [`whisperlivekit/web/`](../../whisperlivekit/web/__init__.py:1), (b) [`diff_protocol.py`](../../whisperlivekit/diff_protocol.py:39), (c) [`basic_server._format_openai_response`](../../whisperlivekit/basic_server.py:174). Update all three.
- **Vendored Whisper fork at [`whisperlivekit/whisper/`](../../whisperlivekit/whisper/__init__.py:1)** is imported as `from whisperlivekit.whisper import …` — **never** add `openai-whisper` from PyPI. Fix bugs here. Lint exemptions for this dir + [`simul_whisper/mlx/`](../../whisperlivekit/simul_whisper/mlx/__init__.py:1) already exist in [`pyproject.toml:153`](../../pyproject.toml:153) — preserve them when refactoring.
- **Configuration source of truth = [`WhisperLiveKitConfig`](../../whisperlivekit/config.py:18) dataclass.** New options need a default and must work via both `from_namespace()` (CLI) and `from_kwargs()` (programmatic). Don't add a parallel config dict.
- **`engine.config` AND `engine.args` are both kept on purpose** ([`core.py:94-97`](../../whisperlivekit/core.py:94)). `args = Namespace(**asdict(config))` for backward compat with `AudioProcessor`. Don't "clean up" by deleting `args`.
- **`get_all_from_queue`** ([`audio_processor.py:28`](../../whisperlivekit/audio_processor.py:28)) deliberately uses the private `asyncio.Queue._queue` to peek without blocking. The peek-don't-block semantic is intentional for batching contiguous PCM chunks — preserve it.
- **`asr.original_language` already accounts for `.en`-suffix override** in [`config.py:97-99`](../../whisperlivekit/config.py:97). Don't re-derive from `--language`.
- **Mutually-exclusive extras** ([`pyproject.toml:84-109`](../../pyproject.toml:84)): `voxtral-hf` ⊥ `diarization-sortformer`, `qwen3-vllm` ⊥ `cu129`, `cpu` ⊥ `cu129`, etc. New extras need a row in `[tool.uv.conflicts]` if they bundle their own torch.
- **No formatter is configured.** `ruff check` only — do not run `ruff format`, black, or isort. `E501` is **ignored** despite `line-length=120`, so don't reformat existing long lines just to fit.
- **Sortformer's import raises `SystemExit`** if `nemo_toolkit` is missing ([`sortformer_backend.py:14`](../../whisperlivekit/diarization/sortformer_backend.py:13)) — guard imports with try/except `BaseException` if you must import it speculatively.
