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

## CLI and Skill updates

They are separate installation facts. Check the Mercury CLI only when the user asks:

```sh
mercury update check --json
```

This is a bounded read from Mercury's official npm registry and does not update the Skill. Show the current/target version, channel, detected installation source, compatibility, and action from the envelope. Never infer a successful install from metadata alone.

Only after the user explicitly approves the exact target may you run one stable apply command:

```sh
mercury update apply --channel latest --yes --json
mercury update apply --channel next --yes --json
mercury update apply --version <exact-semver> --yes --json
```

Do not add `--yes` on the user's behalf before confirmation. Mercury may auto-apply only to a verified writable npm-global installation; for local, npm exec/npx, source, or unknown origins, follow the returned manual action. Never add sudo, change registry, build a shell command, or retry a failed install silently.

The packaged Mercury Skill is updated independently with the standard Skills CLI:

```sh
npx skills update mercury-subtitles
```

Never run that command silently, parse a third-party Skills CLI private database, or claim the Skill changed because the CLI changed.

For `models.asr` and `models.chat`, copy only an exact Mercury model instance ID from `config status.data.defaults` or a ready `config status.data.models[].model_id`. Never use `provider`, `name`, or `category` as a model ID. If the selected model ID changes after a request was derived, that is a new logical request: derive a new stable request ID and write a new request file; never reuse the old ID.

## Create and maintain a dictionary

`--scope` is exactly `global` or `project`. A project dictionary also requires `--project <project-key>`. Create one, then copy `data.dictionary_id` and `data.revision` from the successful envelope:

```sh
mercury dictionary create --name "通用术语" --scope global --json
mercury dictionary create --name "项目术语" --scope project --project "demo-project" --json
```

Every entry ID must match `entry-[a-z0-9][a-z0-9-]{2,63}`. `--kind` is one of `term|person|brand|product|acronym|other`; repeat `--variant` or `--tag` for multiple values. Add the first entry with the current revision returned by create:

```sh
mercury dictionary entry add <dictionary-id> --revision <current-revision> --entry-id entry-product-name --canonical "Mercury" --variant "水星" --kind product --language zh-CN --case-sensitive false --number-sensitive false --enabled true --json
```

Every successful mutation returns `data.dictionary.revision`. Use that new revision for the next write. Never reuse an old revision; `DICTIONARY_REVISION_CONFLICT` means reread the dictionary and reapply only the intended change.

```sh
mercury dictionary show <dictionary-id> --json
mercury dictionary entry edit <dictionary-id> --revision <latest-revision> --entry-id entry-product-name --canonical "Mercury 字幕" --clear-variants --clear-tags --clear-notes --case-sensitive false --number-sensitive false --enabled true --json
mercury dictionary entry remove <dictionary-id> --revision <latest-revision> --entry-id entry-product-name --json
```

On edit, omit a field to keep it. Use explicit `true|false` for `--case-sensitive`, `--number-sensitive`, and `--enabled`; use `--clear-variants`, `--clear-tags`, or `--clear-notes` to clear those values.

The first positive flow is: create → read `data.dictionary_id` and `data.revision` → add an `entry-...` entry → read the mutation's new `data.dictionary.revision` (or run `dictionary show`) → put only the dictionary ID string in the Exchange request, for example `"selected": ["dict-project-terms"]`. Mercury pins that revision and content hash in the task snapshot.

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
  "dictionaries": { "project_key": null, "selected": ["dict-project-terms"], "task_overrides": [] },
  "output": { "formats": ["srt", "report"], "workspace_policy": "managed" },
  "extensions": {}
}
```

`dictionaries.selected` is an array of `dictionary_id` strings, never dictionary objects. For example, use `"selected": ["dict-project-terms"]`. Mercury pins each selected dictionary's revision and content hash in the task snapshot; do not put revision objects into `selected[]`.

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

Ordinary requests use the default auto-finalize sequence: read task result/review status → exact pending count → `accept-all --confirm-count <count> --actor skill` → reread pending=0 → finalize → reread and verify `approved_srt`. Do not ask for an extra accept-all confirmation. On `REVIEW_CONFIRM_COUNT_STALE`, refresh and retry at most once; a second stale response stops the flow.

Only explicit manual-review intent uses `review list` plus decide. In that mode, do not auto accept pending changes. Existing accepted/rejected/edited decisions always remain authoritative; accept-all handles only remaining pending.

`task deliver` is local-only and only retries the task's already-fixed approved directory. It never accepts a new directory and never calls a Provider.
