/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/core/config';
import { k8s, k8sText } from '@/lib/infra/k8s';
import { trainingLogs } from '@/lib/science/training';
import { readDeploy, isServingRuntimeMisconfigured } from '@/lib/science/deploy';
import { deployRuntime } from '@/lib/science/adapters';
import type { ServiceModel } from '@/lib/science/types';

/**
 * GROUNDING for the Science LAUNCH-stage assistant — the mirror of `assistant-grounding.ts`
 * (Design stage). Where Design grounds the assistant in the caller's real datasets/columns, Launch
 * grounds it in what actually happened to THIS model's train + publish: the captured error, the
 * last N lines of the REAL training run log (the `train` init-container's stdout/stderr, where a
 * sklearn traceback / Trino read error lands), and the live deploy/KServe status for the model's
 * InferenceService (including a misconfigured-serving-runtime callout).
 *
 * Everything is REAL and bounded — read AS the platform through the in-cluster ServiceAccount the
 * poll routes already use (the model was already edit-scope-checked by the route), the log tail is
 * capped, and an unreachable cluster degrades to "no logs captured" honestly. Nothing is fabricated.
 */

/** The default number of training-log lines the launch assistant is grounded in. */
export const LAUNCH_LOG_TAIL_LINES = 30;

export type LaunchGrounding = {
  /** The captured training failure reason (failTraining → m.lastTrainingError), if any. */
  trainingError?: string;
  /** The captured deploy failure reason (failDeploy → m.lastDeployError), if any. */
  deployError?: string;
  /** The last N lines of the training run's real log (empty when none captured). */
  trainingLog: string;
  /** The live deploy/KServe status line for this model's InferenceService. */
  deployStatus?: string;
  /** True when the publish failure is a cluster serving-runtime misconfiguration (admin fix). */
  servingRuntimeMisconfigured: boolean;
};

/**
 * Collect the real launch signals for a model. Best-effort throughout: any cluster miss leaves the
 * corresponding field empty/absent rather than throwing, so the assistant is grounded only in what
 * truly happened. Off-cluster (`ml.enabled=false`) this returns just the captured errors.
 */
export async function collectLaunchGrounding(
  m: ServiceModel,
  tailLines: number = LAUNCH_LOG_TAIL_LINES,
): Promise<LaunchGrounding> {
  const trainingError = m.lastTrainingError || undefined;
  const deployError = m.lastDeployError || undefined;

  // The training run log tail — resolved from the model's persisted training-job handle when we
  // have one; otherwise from the last version's runId is not a Job name, so we can only read logs
  // while the Job (and its pod) still exists. TTL-expired jobs simply yield no log (honest).
  let trainingLog = '';
  const jobName = m.trainingJob;
  const namespace = m.trainingNamespace ?? config.platformNamespace;
  if (config.mlEnabled && jobName) {
    try {
      trainingLog = await trainingLogs(jobName, namespace, tailLines, k8s, k8sText);
    } catch {
      trainingLog = '';
    }
  }

  // The live deploy/KServe status for this model's InferenceService (never throws).
  let deployStatus: string | undefined;
  let servingRuntimeMisconfigured = isServingRuntimeMisconfigured(deployError);
  if (config.mlEnabled && (m.kserveService || m.buildState === 'deploying' || m.buildState === 'deploy_failed')) {
    try {
      const status = await readDeploy(m.model, deployRuntime());
      deployStatus = `InferenceService ${status.isvc}: ${status.phase} — ${status.reason}`;
      if (isServingRuntimeMisconfigured(status.reason)) servingRuntimeMisconfigured = true;
    } catch {
      deployStatus = undefined;
    }
  }

  return { trainingError, deployError, trainingLog, deployStatus, servingRuntimeMisconfigured };
}

/**
 * Render the launch grounding as a compact block prepended to the assistant conversation, so the
 * model can DIAGNOSE the failure and suggest a concrete next step instead of asking the user to
 * paste the error. Only real, present signals are included; nothing is fabricated.
 */
export function renderLaunchGrounding(g: LaunchGrounding): string {
  const parts: string[] = [];
  if (g.trainingError) parts.push(`Captured training error: ${g.trainingError}`);
  if (g.deployError) parts.push(`Captured publish (deploy) error: ${g.deployError}`);
  if (g.deployStatus) parts.push(`Live serving status: ${g.deployStatus}`);
  if (g.servingRuntimeMisconfigured) {
    parts.push(
      'DIAGNOSIS: this is a CLUSTER serving-runtime misconfiguration (the KServe predictor is ' +
        'starting with a malformed command — the model-name flag where the executable should be). ' +
        'The user\'s data and training are fine. A platform admin must install/repair the v2 ' +
        'mlserver ServingRuntime (see SCIENCE-KSERVE-FIX.md). Tell the user plainly that this is an ' +
        'admin fix, not something they can retry away, and to contact their platform admin.',
    );
  }
  if (g.trainingLog) {
    parts.push(`Last ${g.trainingLog.split('\n').length} line(s) of the training run log:\n${g.trainingLog}`);
  }
  if (!parts.length) {
    return 'Launch signals: no captured error or logs for this model yet (it has not failed, or the run is still in flight / its logs have expired).';
  }
  return `Launch signals (REAL, for this model — use them to diagnose and suggest ONE concrete next step):\n\n${parts.join('\n\n')}`;
}
