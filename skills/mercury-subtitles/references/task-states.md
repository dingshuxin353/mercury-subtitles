# Task control and artifacts

- `queued`: safely persisted and waiting. Querying does not start work.
- `running`: owned by one Worker.
- `pausing`: the pause intent is durable, but work has not reached a safe checkpoint. If a Provider call is in flight, wait; do not claim it was stopped.
- `paused`: safe checkpoint and same attempt are durable. Resume only when `capabilities.resume.supported` is true.
- `completed`: processing passed; review may still be pending.
- `failed`: a known failure. Read the deterministic retry plan; do not auto-execute it.
- `interrupted`: inspect `provider_outcome`. `outcome_unknown` forbids resume/retry; `response_persisted` may permit local-only resume.
- `cancelled`: final cancellation. A remote call was not necessarily withdrawn.
- `needs_input`: the user must provide/fix an input through the documented flow; retry does not repair input.

Control rules:

- queued pause is immediate and zero-call; running pause becomes pausing until a checkpoint.
- cancel wins a pause/cancel race. Completed/cancelled tasks cannot pause, resume or retry.
- resume preserves `attempt_id`/attempt count. A persisted response is consumed locally and never dispatched again.
- retry-plan must not change files or start a Worker. Retry requires the current, unexpired plan and creates exactly one new append-only attempt.
- changing a model, input, transcript role, dictionary selection, calibration mode, or delivery directory is a new request, never a retry.

Artifacts:

- `transcribed_srt`: ASR/provided wording before Chat.
- `calibrated_srt`: validated AI wording, not final human approval.
- `approved_srt`: current human-approved final SRT.
- `calibration_report`: evidence summary.

Only report absolute paths where `exists=true` and `validation=passed`. Historical tasks may truthfully advertise control capabilities as unsupported.
