<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Agent schedules: CronJobs, the boot resync, and what to do after a restore

A cron schedule saved on an agent system becomes one Kubernetes CronJob, `agent-schedule-<system>`,
labelled `app.kubernetes.io/managed-by=os-ui` and `app.kubernetes.io/component=agent-schedule`
(`os-ui/tabs/agents/lib/schedule-cron.ts`). Each firing is a `curl` pod that posts to
`/api/agents/scheduled-run` with the shared service bearer (Secret `agent-runtime-token`, key
`token`). The chart's static `agentRuntime.schedules` are separate CronJobs
(`agent-runtime-schedule-<name>`, managed by Helm) and are never touched by os-ui.

## Who decides whether a firing runs: the receiver

The receiver reads the system **fresh from OpenSearch** on every firing (`scheduledRunGate` in
`tabs/agents/lib/build/scheduled.ts`) and refuses, with a log line `[scheduled-run] <id>: refused …`:

| Fresh read | Answer |
|---|---|
| OpenSearch unreachable | 503, nothing runs |
| system absent | 404 |
| system archived | 409 |
| os-ui CronJob (`X-Schedule-Source: os-ui`) whose `X-Schedule-Cron` is not the stored cron schedule (cleared, manual/event, edited) | 409 |
| the chart's static schedule (no marker) | runs; only `archived` is checked |

So a CronJob that should not exist any more cannot run the agent against the owner's choice. At
worst it fires and is refused.

## The boot resync

os-ui rewrites its schedule CronJobs to the current spec at boot. A CronJob is otherwise written
only when a schedule is saved, archived or deleted, so a deploy alone would not repair one an older
os-ui wrote. The resync:

- starts **3 minutes after boot**, so the old pod of a rolling update is gone, and retries every
  minute until one pass is clean (at most 60 passes);
- reads the wanted schedules **fresh and complete** from OpenSearch. A partial or failed read
  changes nothing;
- re-reads each system just before writing its CronJob, so it never resurrects a cleared schedule
  or reverts an edit;
- deletes os-ui's own schedule CronJobs that nothing wants after a second fresh read, with a `uid`
  precondition;
- logs one line per pass:
  `[agent-schedules] boot resync: done|incomplete — desired N, applied N, skipped N, orphans deleted N, failed N`.

### Mass-delete guard

A pass deletes nothing, and logs `MASS-DELETE GUARD` at error level, when either of these holds:

- the fresh read wants **no** schedule while schedule CronJobs exist;
- **more than half** of the listed schedule CronJobs would be deleted, when more than 2 are listed.

Either shape is what an empty or truncated `os-agent-systems` index looks like, for example right
after an OpenSearch restore, or with the wrong index.

## After an OpenSearch restore (or any rebuild of `os-agent-systems`)

1. Make sure the restore is complete. `GET os-agent-systems/_count` should match what you expect.
2. **Restart os-ui** (`kubectl -n agentic-os rollout restart deploy/os-ui`). Its resync then runs
   against the restored index, 3 minutes after the new pod starts.
3. Read the os-ui log for the `[agent-schedules] boot resync` line:
   - `done`: nothing more to do.
   - `MASS-DELETE GUARD`: the index the resync read is still missing most schedules, and the
     deletes were held. Check the restore first. If the schedules really were removed, clear them
     in the Agents tab (that deletes each CronJob through the normal path), or delete the listed
     `agent-schedule-*` CronJobs by hand.
4. Until then, any CronJob for a system the restored index does not show as on that cron schedule
   is refused by the receiver (404 or 409) and runs nothing.

## Find them

```bash
kubectl -n agentic-os get cronjobs -l app.kubernetes.io/managed-by=os-ui,app.kubernetes.io/component=agent-schedule
kubectl -n agentic-os logs deploy/os-ui -c os-ui | grep -E 'agent-schedules|scheduled-run'
```
