// Serve only from Playwright routes; never included in the site's assets.
export function turnstileScript(scenario = 'success') {
  function install(mode) {
    window.turnstileRenders = 0;
    window.turnstileRemovals = 0;
    const widgets = new Map();
    window.turnstile = {
      ready(callback) { callback(); },
      render(container, options) {
        window.turnstileRenders++;
        const id = crypto.randomUUID();
        const iframe = document.createElement('iframe');
        iframe.title = 'Cloudflare security verification';
        iframe.width = options.size === 'compact' ? '150' : '300';
        iframe.height = options.size === 'compact' ? '140' : '65';
        iframe.style.border = '0';
        iframe.srcdoc = '<!doctype html><html lang="zh"><body style="margin:0;padding:12px;box-sizing:border-box;background:#f5f5f5;color:#222;font:14px sans-serif"><button type="button">确认验证</button></body></html>';
        container.append(iframe);
        const complete = () => options.callback(btoa(JSON.stringify({ success: true, hostname: location.hostname, action: options.action, cdata: options.cData, challenge_ts: new Date().toISOString(), id })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''));
        if (mode === 'interaction') iframe.onload = () => iframe.contentDocument.querySelector('button').addEventListener('click', complete);
        const timer = setTimeout(() => {
          if (mode === 'success') complete();
          if (mode === 'widget-error') options['error-callback']('300030');
          if (mode === 'unsupported') options['unsupported-callback']();
          if (mode === 'expired-callback') options['expired-callback']();
        }, 30);
        widgets.set(id, { container, timer });
        return id;
      },
      remove(id) {
        const widget = widgets.get(id);
        if (!widget) throw new Error('Unknown widget');
        window.turnstileRemovals++;
        clearTimeout(widget.timer);
        widget.container.replaceChildren();
        widgets.delete(id);
      },
    };
  }
  return `(${install.toString()})(${JSON.stringify(scenario)})`;
}
