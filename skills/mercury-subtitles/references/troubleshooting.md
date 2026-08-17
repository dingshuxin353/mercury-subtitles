# Structured recovery

- Model/config readiness: direct the user to interactive `mercury` → 模型中心 and hidden secret input. Never request or inspect credentials.
- `REQUEST_ID_CONFLICT`: the stable ID is bound to different normalized facts. Preserve the existing task; confirm whether the user intends a genuinely new logical request.
- Lost submit output: reuse the recorded request file and ID. Lost identity: query/list and ask; never generate a random ID.
- `TASK_RESUME_UNSAFE`: evidence/checkpoint/outcome cannot prove same-attempt safety. Do not edit records or create a replacement silently.
- `TASK_INTERRUPTED_PROVIDER_UNKNOWN` or `RETRY_UNSAFE_PROVIDER_OUTCOME`: a Provider side effect may have occurred. Never replay/resume/retry this call.
- `RETRY_PLAN_STALE`/`RETRY_PLAN_EXPIRED`: rerun read-only retry-plan and show the changed facts; do not reuse the old plan.
- `TASK_PAUSE_UNAVAILABLE`: report the actual state. `pausing` is not a failure; wait/query the same task.
- Worker start failure: query `worker status`, fix the local runtime issue, then explicitly start. Never resubmit or fall back to synchronous Provider execution.
- Delivery failure: workspace approved remains authoritative. Fix only the stated local directory problem, then call `task deliver`; do not rerun ASR/Chat.
- Review stale/source errors: reload stable review state and reconfirm; never patch review/task JSON.

For unknown errors, show only the structured Chinese message/remediation. Do not expose technical Provider detail, stack traces, lock paths, Authorization data, or full response bodies.
