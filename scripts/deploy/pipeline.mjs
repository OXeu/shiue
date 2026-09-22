// 步骤式流水线执行器。
//
// 步骤契约：{ id, title, skip?(context), run(context, io) }
//   - 默认串行；有界的并行工作应放在所属步骤内部完成
//   - io.warn 非致命，会记录到报告；抛错则停止流水线并跳过后续依赖步骤
//
// 无论成功失败都产出结构化报告（JSON），供 .cache/deploy/report.json 排查。

import { Reporter } from './reporter.mjs';
import { writeJSON } from './files.mjs';

export async function runPipeline({ name = 'Xeu · 部署构建', steps, context = {}, signal, reportPath, reporter = new Reporter() }) {
  if (new Set(steps.map(step => step.id)).size !== steps.length) throw new Error('部署步骤 ID 不能重复');

  const started = performance.now();
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), status: 'success', steps: [] };
  let failure;
  reporter.start(name, steps);
  try {
    for (const [index, step] of steps.entries()) {
      const row = { id: step.id, title: step.title, status: 'skipped', durationMs: 0, warnings: [] };
      report.steps.push(row);

      // 前置失败或已取消：后续步骤直接标记跳过，不再执行。
      if (failure || signal?.aborted) {
        failure ||= signal.reason;
        row.reason = signal?.aborted ? '任务已取消' : '前置步骤失败';
        continue;
      }

      reporter.step(index, steps.length, step.title);
      const stepStarted = performance.now();
      row.startedAt = new Date().toISOString();
      try {
        const skip = await step.skip?.(context);
        if (skip) {
          row.reason = skip;
        } else {
          row.details = (await step.run(context, {
            signal,
            log: message => reporter.log(message),
            warn: message => {
              row.warnings.push(String(message));
              reporter.log(message, true);
            },
          })) ?? {};
          signal?.throwIfAborted();
          row.status = row.warnings.length ? 'warning' : 'success';
        }
      } catch (error) {
        row.status = signal?.aborted ? 'cancelled' : 'failed';
        row.error = error.message;
        reporter.log(error.message, true);
        failure = error;
      } finally {
        row.durationMs = Math.round(performance.now() - stepStarted);
        row.finishedAt = new Date().toISOString();
        reporter.result(row);
      }
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    report.durationMs = Math.round(performance.now() - started);
    report.status = signal?.aborted ? 'cancelled' : failure ? 'failed' : 'success';
    reporter.finish(report);
    if (reportPath) {
      await writeJSON(reportPath, report);
      reporter.log(`耗时报告：${reportPath}`);
    }
  }

  if (failure) throw Object.assign(new Error('部署构建未完成', { cause: failure }), { report });
  return report;
}
