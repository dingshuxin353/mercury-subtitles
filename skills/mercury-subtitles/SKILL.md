---
name: mercury-subtitles
description: Use Mercury's stable Exchange CLI to create or manage Chinese subtitle tasks from MP3 or external SRT/VTT/transcript JSON, apply dictionaries, pause/resume/safely retry background work, review AI changes, and deliver approved SRT files. Trigger for Mercury subtitle workflows and task recovery, not for direct Provider calls, generic subtitle programming, or other subtitle products.
---

# Mercury Subtitles

Use only `mercury.cli/v1` machine commands. Never call a Provider directly. Never ask the user to paste a key. Do not read Mercury credentials/config files or edit task/workspace records directly.

## Workflow

1. Run `protocol capabilities`, `config status`, and stable `input inspect`. If models are not ready, ask the user to run interactive `mercury` → 模型中心; never request a secret.
2. Confirm whether an external SRT/VTT/JSON is `transcript_source` (skip ASR) or `reference` (still run ASR). Confirm any dictionary scope and any absolute approved-SRT delivery directory.
3. Derive and record one stable non-sensitive request ID from the logical user request plus the exact inspected hashes, modes, model IDs, dictionary revisions, and delivery directory. Never use a random ID. Write a 0600 request file following [commands.md](references/commands.md), then submit it once.
4. Return the task ID immediately. Use only stable status/list/watch/result queries; queries never wake a Worker.
5. Use pause/resume/retry only according to Mercury's advertised action fields and [task-states.md](references/task-states.md). Always show a retry plan before executing it.
6. After completion, follow [review.md](references/review.md). Only `approved_srt` is final. If delivery was requested, use the projected delivery state and local-only `task deliver` recovery.

Read [commands.md](references/commands.md) for exact commands/request shape. Read [task-states.md](references/task-states.md) before any control or recovery action. Read [review.md](references/review.md) for decisions/finalize. Read [troubleshooting.md](references/troubleshooting.md) only after a structured failure.

## Safety

- Lost output or a new Agent session must reuse the same recorded request ID/request file. If identity or inputs are uncertain, query/list and ask; never improvise a replacement task.
- `outcome_unknown` is never safe to resume or retry. Do not switch models, inputs, roles, dictionaries, or delivery directory inside retry; changed intent requires a new stable request.
- Pause never means an in-flight Provider call was aborted. `pausing` means wait for a safe checkpoint.
- Do not copy `transcribed` or `calibrated` as a final result. Do not construct result paths; trust only passed artifacts in Mercury output.
- Do not paste full transcripts into chat unless the user asks to inspect specific text.
