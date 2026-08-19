# Review and final approval

Choose one policy before acting:

- `auto_finalize` is the default for an ordinary subtitle request. Do not ask whether to accept all AI changes.
- `manual_review` is opt-in when the user explicitly says “逐条检查”, “人工复核”, “先看修改”, “不要自动定稿”, or an equivalent intent.

Always start with stable task result and `review status`. Continue only for a completed task with valid evidence. Failed, cancelled, interrupted, needs_input, outcome_unknown, invalid review evidence, or finalize failure must never produce or be described as final.

## Default auto finalize

For `not_required` or `finalized`, do not write again. Read the stable result and return only an `approved_srt` whose `exists=true` and `validation=passed`.

For pending changes:

1. Read the exact pending count from `review status`.
2. Run `review accept-all <task-id> --confirm-count <count> --actor skill --json` without another user confirmation.
3. Read `review status` again and require pending=0.
4. Run `review finalize <task-id> --json`.
5. Read result/status again; report final only from the verified absolute `approved_srt` path and hash.

Accept-all affects only remaining pending items. Preserve every existing accepted, rejected, or edited decision and its history.

If accept-all returns `REVIEW_CONFIRM_COUNT_STALE`, refresh review status read-only and retry once with the new exact count. A second stale response means concurrent review activity: stop, explain it, and do not guess or finalize.

If an approved artifact exists but requested delivery failed with a structured local recovery action, run `task deliver` at most once, then reread result. Never rerun ASR or Chat. Do not call deliver when approved is absent or invalid.

## Opt-in manual review

Page from the first pending change with `review list`. Show a small batch containing stable `change_id`, time range, pure-transcription `original_text`, AI `proposed_text`, and reason.

- accept: use `proposed_text`.
- reject: use `original_text`.
- edit: use exactly the non-empty text explicitly approved by the user.

Repeat the target change and decision before an edit. Use actor `skill`. A replayed identical decision is idempotent; a later different decision remains in history. Do not call accept-all unless the user explicitly chooses it and confirms the current exact count.

Call finalize only at zero pending. Repeated finalize returns the same verified artifact and never calls ASR or Chat. Clearly distinguish transcribed, calibrated, and approved identities.
