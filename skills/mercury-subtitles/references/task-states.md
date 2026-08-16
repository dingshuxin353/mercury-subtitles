# Task states and artifacts

Execution state and processing stage are separate.

- `queued`: saved and waiting. It is safe to leave the session.
- `running`: the single local Worker owns the task. `stage` describes preparing, ASR, alignment, Chat calibration, segmentation, or validation.
- `completed`: processing and output validation succeeded. Human review may still be pending; the Worker is not blocked by review.
- `needs_input`: Mercury needs corrected input, usually a reference/timeline issue. Create a new task only after the user fixes it.
- `failed`: a known terminal failure. Show any transcribed partial result and the supplied remediation; do not auto-retry.
- `cancelled`: cancellation took effect. Do not claim a remote request was withdrawn unless Mercury says so.
- `interrupted`: execution continuity or Provider outcome is uncertain. Never auto-replay or create a replacement.

Artifact identities:

- `transcribed`: raw ASR wording, not checked by Chat; may remain after Chat failure.
- `calibrated`: AI-checked wording and authoritative validated timing.
- `approved`: calibrated timing plus every persisted human decision.
- `report`: task evidence and summary.

Only present paths where `exists` is true and `validation` is `passed`. Historical tasks may expose older artifacts while reporting review/events as unsupported; do not manufacture missing capabilities.
