---
name: mercury-subtitles
description: Use Mercury to generate or proofread Chinese SRT subtitles from a local MP3, submit work to the local background queue, query/cancel/recover a Mercury task, find transcribed/calibrated/approved subtitle files, or review and approve AI text changes. Trigger for Mercury subtitle workflows and failures, not for general ASR/Gemini explanations, generic subtitle code, or other subtitle products.
---

# Mercury Subtitles

Use the installed `mercury` CLI as the only product interface. Keep long ASR/Chat work in Mercury's detached background Worker so the Agent session can return immediately.

## Core workflow

1. Confirm the local MP3 path and optional reference SRT/mode.
2. Choose a stable, non-sensitive logical-run key for this user request (prefer the Agent platform's stable conversation/request identity), derive and record the request ID with Mercury, then submit with that exact ID and `--background --json`. If output is lost, recompute/replay only the same ID.
3. Parse the JSON envelope. Report the task ID and current state; do not wait in the submit command.
4. Query with `task status --json`, list tasks when the user has no task ID, and use `task result --json` to report only Mercury-provided absolute paths.
5. For a completed new task, page through review changes, persist the user's accept/reject/edit decisions, then finalize only when pending is zero.

Read [commands.md](references/commands.md) for exact calls and fields. Read [task-states.md](references/task-states.md) before explaining cancellation, failure, or interruption. Read [review.md](references/review.md) for review operations. Read [troubleshooting.md](references/troubleshooting.md) only when a command fails or compatibility/configuration is unclear.

## Safety boundaries

- Never ask the user to paste a key, token, ADC content, `.env`, or credential reference into chat or a command. If models are not ready, direct them to run interactive `mercury`, which hides secret input.
- Never call a Provider directly, transcribe audio yourself, edit task JSON/events/review files, or construct result paths. Trust only Mercury machine output.
- Never retry with a new request ID after timeout or uncertain output. Never switch models or create a backup task without the user's decision.
- Reuse a logical-run key only for retries of the same user request. A user-approved intentional rerun needs a new stable request identity; never silently turn a retry into a rerun or permanently deduplicate future reruns.
- Treat status/list/result/watch and Worker status as read-only. If a queued task has no Worker, use the explicit Worker start command; never resubmit to wake it.
- Do not delete/kill task data or Worker processes to cancel; call `mercury task cancel`.
- Treat `interrupted` with an unknown Provider result as unsafe to replay. Explain that Mercury stopped to prevent duplicate calls or charges.
- Do not dump full subtitle text into chat unless the user explicitly asks to inspect specific content.
