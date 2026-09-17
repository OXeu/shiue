import { clearLine, cursorTo } from 'node:readline';

const plain = text => String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
export function duration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.floor(ms / 60_000)}m ${((ms % 60_000) / 1000).toFixed(1)}s`;
}

export class Reporter {
  constructor(output = process.stdout, env = process.env) {
    this.output = output;
    this.tty = Boolean(output.isTTY && !env.CI);
    this.color = this.tty && !('NO_COLOR' in env) && env.TERM !== 'dumb';
  }
  paint(code, text) { return this.color ? `\x1b[${code}m${text}\x1b[0m` : text; }
  clear() { if (this.timer) { clearLine(this.output, 0); cursorTo(this.output, 0); } }
  line(message = '') { this.clear(); this.output.write(`${message}\n`); }
  start(name, steps) {
    this.line(this.paint('1;36', `┌ ${plain(name)}`));
    this.line(`│ ${steps.length} 个步骤 · ${new Date().toISOString()}`);
    this.line('└');
  }
  step(index, total, title) {
    this.stop();
    this.label = `[${index + 1}/${total}] ${plain(title)}`;
    this.line(`\n${this.paint('36', '▶')} ${this.paint('1', this.label)}`);
    if (this.tty) {
      const started = performance.now();
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      let frame = 0;
      this.timer = setInterval(() => {
        this.clear();
        this.output.write(`  ${this.paint('36', frames[frame++ % frames.length])} ${this.label} · ${duration(performance.now() - started)}`);
      }, 120);
      this.timer.unref();
    }
  }
  log(message, warning = false) {
    for (const line of plain(message).split(/\r?\n/)) {
      this.line(`  ${this.paint(warning ? '33' : '90', warning ? '!' : '│')} ${line}`);
    }
  }
  stop() {
    if (!this.timer) return;
    this.clear();
    clearInterval(this.timer);
    this.timer = undefined;
  }
  result(step) {
    this.stop();
    const symbols = { success: ['32', '✓'], warning: ['33', '!'], failed: ['31', '✗'], cancelled: ['33', '■'], skipped: ['90', '–'] };
    const [color, symbol] = symbols[step.status];
    this.line(`${this.paint(color, symbol)} ${plain(step.title)} · ${duration(step.durationMs)}${step.reason ? ` · ${plain(step.reason)}` : ''}`);
  }
  finish(report) {
    this.stop();
    this.line(`\n${this.paint('1', '── 部署构建汇总 ──')}`);
    for (const step of report.steps) this.result(step);
    const slowest = report.steps.filter(step => step.status !== 'skipped').sort((a, b) => b.durationMs - a.durationMs)[0];
    this.line(`总耗时 ${duration(report.durationMs)}${slowest ? ` · 最耗时：${plain(slowest.title)} ${duration(slowest.durationMs)}` : ''}`);
    this.line(report.status === 'success' ? '构建完成，静态产物已就绪；线上发布由托管平台执行。' : '构建未完成，不应发布本次产物。');
  }
}
