---
name: mercury-subtitles
description: Use Mercury's stable Exchange CLI to create or manage Chinese subtitle tasks from MP3 or external SRT/VTT/transcript JSON, apply dictionaries, pause/resume/safely retry work, automatically finalize AI changes by default or run opt-in manual review, and deliver approved SRT files. Trigger for Mercury subtitle workflows and task recovery, not for direct Provider calls, generic subtitle programming, or other subtitle products.
---

# Mercury Subtitles

Use only `mercury.cli/v1` machine commands. Never call a Provider directly. Never ask the user to paste a key. Do not read Mercury credentials/config files or edit task/workspace records directly.

## Workflow

1. Run `protocol capabilities`, `config status`, and stable `input inspect`. If models are not ready, ask the user to run interactive `mercury` → 模型中心; never request a secret.
2. Confirm whether an external SRT/VTT/JSON is `transcript_source` (skip ASR) or `reference` (still run ASR). Confirm any dictionary scope and any absolute approved-SRT delivery directory.
3. Unless the user explicitly requests manual review, say once: “默认自动采用 AI 校对并输出最终字幕；如需逐条确认请直接说。” Do not ask for confirmation. Derive and record one stable non-sensitive request ID from the logical request and inspected facts, write a 0600 request file following [commands.md](references/commands.md), then submit once.
4. Return the task ID immediately. Use only stable status/list/watch/result queries; queries never wake a Worker.
5. Use pause/resume/retry only according to the task's current `pause.allowed`, `resume.allowed`, and `retry.allowed` fields—not contract-level support—and [task-states.md](references/task-states.md). Always show a retry plan before executing it.
6. After completion, follow [review.md](references/review.md). Default to `auto_finalize`; use `manual_review` only for explicit “逐条检查/人工复核/先看修改/不要自动定稿” intent. Only a passed `approved_srt` is final. If delivery was requested, use its projection and at most one local-only `task deliver` recovery.

CLI and Skill are separate installations. Only check or update either one when the user asks. Use Mercury's stable update commands for the CLI; use the standard Skills CLI for this Skill. Never treat one update as proof that the other changed.

Read [commands.md](references/commands.md) for exact commands/request shape. Read [task-states.md](references/task-states.md) before any control or recovery action. Read [review.md](references/review.md) for decisions/finalize. Read [troubleshooting.md](references/troubleshooting.md) only after a structured failure.

## Safety

- Lost output or a new Agent session must reuse the same recorded request ID/request file. If identity or inputs are uncertain, query/list and ask; never improvise a replacement task.
- `outcome_unknown` is never safe to resume or retry. Do not switch models, inputs, roles, dictionaries, or delivery directory inside retry; changed intent requires a new stable request.
- Pause never means an in-flight Provider call was aborted. `pausing` means wait for a safe checkpoint.
- Do not copy `transcribed` or `calibrated` as a final result. Do not construct result paths; trust only passed artifacts in Mercury output.
- Do not paste full transcripts into chat unless the user asks to inspect specific text.
- Never run `update apply` without the user's explicit approval of the exact target. Do not silently run `npx skills update mercury-subtitles` or inspect third-party Skills CLI private state.
