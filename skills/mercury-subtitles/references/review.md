# Human review

Start with `review status`, then page from the first pending change with `review list`. Show a small batch containing each stable `change_id`, time range, pure-transcription `original_text`, AI `proposed_text`, and reason.

Decision meanings:

- accept: use `proposed_text` in the approved subtitle.
- reject: use `original_text`.
- edit: use exactly the non-empty text explicitly approved by the user.

Repeat the target change and intended decision before an edit. State-changing calls are idempotent when the same decision is replayed; a later different decision remains in Mercury's history.

For “accept all”, first read the current pending count, tell the user the task and exact count, obtain confirmation, then pass that count to `--confirm-count`. If Mercury returns `REVIEW_CONFIRM_COUNT_STALE`, reload instead of guessing.

Call finalize only at zero pending. Repeated finalize returns the same verified artifact and never calls ASR or Chat. Clearly distinguish all three SRT identities in the final response.
