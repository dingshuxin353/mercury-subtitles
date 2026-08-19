# Structured recovery

- Model/config readiness: direct the user to interactive `mercury` → 模型中心 and hidden secret input. Never request or inspect credentials.
- `REQUEST_ID_CONFLICT`: the stable ID is bound to different normalized facts. Preserve the existing task. If the user intentionally changed a model ID, input hash/role, mode, dictionary revision, or delivery directory, derive a new stable ID for that new logical request; never reuse the conflicting ID or choose a random replacement.
- Lost submit output: reuse the recorded request file and ID. Lost identity: query/list and ask; never generate a random ID.
- `TASK_RESUME_UNSAFE`: evidence/checkpoint/outcome cannot prove same-attempt safety. Do not edit records or create a replacement silently.
- `TASK_INTERRUPTED_PROVIDER_UNKNOWN` or `RETRY_UNSAFE_PROVIDER_OUTCOME`: a Provider side effect may have occurred. Never replay/resume/retry this call.
- `RETRY_PLAN_STALE`/`RETRY_PLAN_EXPIRED`: rerun read-only retry-plan and show the changed facts; do not reuse the old plan.
- `TASK_PAUSE_UNAVAILABLE`: report the actual state. `pausing` is not a failure; wait/query the same task.
- Worker start failure: query `worker status`, fix the local runtime issue, then explicitly start. Never resubmit or fall back to synchronous Provider execution.
- Delivery failure with a passed `approved_srt`: workspace approved remains authoritative. Fix only the stated local directory problem, then call `task deliver`; do not rerun ASR/Chat. If `approved_srt.exists` is false, do not call `task deliver`; follow the task's primary error or finish review/finalize first.
- `REVIEW_CONFIRM_COUNT_STALE` during default auto-finalize: reload stable review state and retry once with the new exact count. If it is stale again, stop and report concurrent review activity; never guess, loop, finalize, or patch review/task JSON.
- Other review source/finalize errors: stop without claiming a final subtitle. Use only the structured remediation; never patch review/task JSON or substitute calibrated/transcribed output.
- CLI update check failure: keep using the installed CLI. Do not alter workspace data, switch registries, or call a Provider. Show the structured network/metadata/Node/install-source remediation.
- CLI update apply failure: report the verified installed version and returned recovery action. Never use sudo, retry silently, or treat a downloaded package as installed. CLI update does not update the Skill.
- Skill update: use `npx skills update mercury-subtitles` only after explicit user intent. Do not inspect or edit third-party Skills CLI private state.

For unknown errors, show only the structured Chinese message/remediation. Do not expose technical Provider detail, stack traces, lock paths, Authorization data, or full response bodies.
