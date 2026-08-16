# Machine commands

All JSON commands emit exactly one envelope with `contract_version: mercury-cli-experimental-v1`. Require `ok: true` before using `data`; otherwise use `error.code`, `error.message`, and `error.remediation`.

## Submit

Check non-sensitive model readiness first:

```sh
mercury model list --json
```

If either default model is missing, disabled, unchecked, or failed, direct the user to interactive `mercury`; never collect its credential in chat.

Before submission, derive a deterministic ID from the normalized input/model selection and a stable workflow label. Record `data.request_id` in Agent state before the mutating call:

```sh
mercury request id --audio "/absolute/input.mp3" --intent "skill:<stable-agent-request-key>" --json
mercury calibrate --audio "/absolute/input.mp3" --background --request-id "<data.request_id>" --json
```

Pass the same optional `--srt`, `--mode`, `--asr-model`, and `--chat-model` arguments to both commands. The intent key identifies one logical user request, not the media forever: prefer a stable platform conversation/request identity, reuse it for output-loss retries, and use a new stable identity only after the user intentionally requests another run. If derive output is lost, the same inputs and intent deterministically produce the same ID. If submit output is lost, replay that recorded ID. Never improvise a new ID. Do not include credentials or user text in the intent label.

## Query

```sh
mercury task status <task-id> --json
mercury task list --json
mercury task result <task-id> --json
mercury worker status --json
```

These query commands and `task watch` are strictly read-only and never start a Worker. If a queued task needs recovery after restart, make that action explicit:

```sh
mercury worker start --json
```

`task status` and `task result` successfully return failed/cancelled/interrupted task data with process exit 0. Use `data.execution`, `data.review`, `data.artifacts`, `data.error`, `data.next_action`, and `data.last_event_sequence`.

For an event stream:

```sh
mercury task watch <task-id> --jsonl --after <last-sequence>
```

Every stdout line is a persisted event. A reconnect begins after the last seen sequence and must not be treated as a new task action. Prefer the Agent platform's non-blocking wait mechanism when available; do not keep an ordinary tool call open while doing unrelated work.

## Cancel

```sh
mercury task cancel <task-id> --json
```

Read `data.pending`: false means cancellation is already terminal; true means the request is saved and the Worker must reach a safe boundary.

## Review

Add `--actor skill` on state-changing calls:

```sh
mercury review status <task-id> --json
mercury review list <task-id> --limit 10 --json
mercury review list <task-id> --after <change-id> --limit 10 --json
mercury review decide <task-id> --change <change-id> --accept --actor skill --json
mercury review decide <task-id> --change <change-id> --reject --actor skill --json
mercury review decide <task-id> --change <change-id> --text "用户批准文字" --actor skill --json
mercury review accept-all <task-id> --confirm-count <pending-count> --actor skill --json
mercury review finalize <task-id> --json
```

Do not invoke `accept-all` until the user confirms the exact task and currently displayed pending count.
