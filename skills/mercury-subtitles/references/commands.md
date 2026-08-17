# Stable machine commands

Every JSON command emits one `mercury.cli/v1` envelope. Require `ok: true`; otherwise use only the structured error and remediation. Never parse App text or `mercury-cli-experimental-v1`.

## Discover and inspect

```sh
mercury protocol version --json
mercury protocol capabilities --json
mercury config status --json
mercury input inspect --file "/absolute/input.mp3" --format mp3 --role media --json
mercury input inspect --file "/absolute/input.srt" --format auto --role transcript-source --json
mercury input inspect --file "/absolute/reference.vtt" --format auto --role reference --json
mercury dictionary list --json
mercury dictionary show <dictionary-id> --json
```

`config status` exposes only non-sensitive defaults/readiness. If not configured/current/ready, send the user to interactive `mercury` → 模型中心. Do not inspect config files.

For `models.asr` and `models.chat`, copy only an exact Mercury model instance ID from `config status.data.defaults` or a ready `config status.data.models[].model_id`. Never use `provider`, `name`, or `category` as a model ID. If the selected model ID changes after a request was derived, that is a new logical request: derive a new stable request ID and write a new request file; never reuse the old ID.

## Build and submit Exchange request v1

Create a private temporary JSON file (0600). `request_id` must be stable and non-random: hash a stable Agent/user logical-run key together with the exact inspected input hashes, selected model IDs, mode, dictionary references and delivery directory; use `req-` plus 40 lowercase hex characters. Record the ID and file path before submit. Never put transcript text or credentials in the logical key.

Provider ASR request (an external `reference` is optional):

```json
{
  "contract": "mercury.exchange.request/v1",
  "request_id": "req-<40-hex>",
  "created_at": "<UTC ISO timestamp fixed for this logical request>",
  "operation": "subtitle_calibration",
  "inputs": {
    "media": { "path": "/absolute/input.mp3", "sha256": "<inspect sha256>", "mime_type": "audio/mpeg" },
    "transcript": null
  },
  "transcription_mode": "provider",
  "calibration": { "mode": "text-only", "source_language": "zh-CN" },
  "models": { "asr": "<ready default/selected ASR>", "chat": "<ready default/selected Chat>" },
  "dictionaries": { "project_key": null, "selected": [], "task_overrides": [] },
  "output": { "formats": ["srt", "report"], "workspace_policy": "managed" },
  "extensions": {}
}
```

For external SRT/VTT/transcript JSON that replaces ASR, set `transcription_mode` to `provided`, set `models.asr` to null, and set `inputs.transcript` to its absolute path, inspected hash, `srt|vtt|transcript_json`, and role `transcript_source`. For a reference, keep provider mode/ASR and use role `reference`. Never infer role from extension.

After the user confirms an absolute business directory, add `output.approved_srt_directory`. Relative paths and `~` are forbidden. Changing it changes the request fingerprint.

```sh
mercury task submit --request "/absolute/private-request.json" --json
```

If output is lost, replay the byte-identical request file/same ID. Do not generate a new ID.

## Query and Worker

```sh
mercury task status <task-id> --json
mercury task list --limit 20 --json
mercury task result <task-id> --json
mercury task watch <task-id> --after <last-sequence> --jsonl
mercury worker status --json
mercury worker start --json
```

Queries are strictly read-only. Use explicit Worker start only when a safe queued task has no active Worker.

## Control

```sh
mercury task pause <task-id> --json
mercury task resume <task-id> --json
mercury task retry-plan <task-id> --json
mercury task retry <task-id> --plan <plan-id> --json
mercury task cancel <task-id> --json
```

Use the task's current `pause.allowed`, `resume.allowed`, and `retry.allowed` fields, not contract-level `capabilities.*.supported`, to decide whether an action is currently valid. Pause/resume are same-attempt operations. Retry creates one append-only attempt and may add the exact Provider calls shown in the plan. `retry-plan` is read-only: show its checkpoint, reuse/discard lists, call estimates, models, risk, and reason before asking permission to execute. Never execute a disallowed/stale/expired/unknown-outcome plan.

## Review and final delivery

```sh
mercury review status <task-id> --json
mercury review list <task-id> --limit 10 --json
mercury review decide <task-id> --change <change-id> --accept --actor skill --json
mercury review decide <task-id> --change <change-id> --reject --actor skill --json
mercury review decide <task-id> --change <change-id> --text "用户批准文字" --actor skill --json
mercury review accept-all <task-id> --confirm-count <pending-count> --actor skill --json
mercury review finalize <task-id> --json
mercury task deliver <task-id> --json
```

`task deliver` is local-only and only retries the task's already-fixed approved directory. It never accepts a new directory and never calls a Provider.
