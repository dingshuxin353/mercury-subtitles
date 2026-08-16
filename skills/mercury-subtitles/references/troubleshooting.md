# Troubleshooting

- `MODEL_NOT_CONFIGURED`, `MODEL_CHECK_NOT_PASSED`, or model readiness errors: ask the user to open interactive `mercury` and use the model center. Do not request credentials in chat.
- `REQUEST_ID_CONFLICT`: the ID belongs to different normalized input. Preserve the original task and ask whether the user wants a genuinely new task ID.
- `REQUEST_RESERVATION_IN_PROGRESS`: retry later with the same request ID only.
- `WORKER_START_FAILED`: run the read-only `mercury worker status --json`, show its remediation, and do not fall back to synchronous execution. After fixing the local cause, explicitly run `mercury worker start --json`; do not resubmit.
- Lost derive output: rerun `request id` with exactly the same absolute inputs, model options, mode and intent. Lost submit output: reuse the recorded derived ID. If any of those inputs are uncertain, inspect `task list --json` and ask the user rather than generating a new ID.
- `TASK_INTERRUPTED_PROVIDER_UNKNOWN`: explain that the request may have reached the Provider and Mercury intentionally will not replay it.
- `TASK_CANCELLATION_PENDING`: cancellation is persisted but waiting for a safe boundary; query the same task.
- `MACHINE_CONTRACT_UNAVAILABLE`: this is an older task or incompatible Mercury. Offer read-only status/results or ask the user to upgrade; do not edit its files.
- `REVIEW_NOT_READY`: AI calibration did not complete or this is a historical task. A transcribed SRT is not an approvable AI result.
- `REVIEW_CONFIRM_COUNT_STALE`: reload the page/count and reconfirm.
- `REVIEW_SOURCE_CONFLICT`: source artifacts changed. Stop without rebuilding or overwriting decisions.

For any unknown structured error, report the user message and remediation. Do not expose raw Provider details, stack traces, secrets, or internal lock paths.
