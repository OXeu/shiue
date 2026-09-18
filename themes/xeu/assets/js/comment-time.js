const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

export function commentTime(dateTime, now = Date.now()) {
  const date = new Date(dateTime);
  if (!Number.isFinite(date.getTime())) return null;
  // Omitting timeZone deliberately uses the reader's browser time zone, including DST.
  const parts = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const part = type => parts.find(value => value.type === type).value;
  const absolute = `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
  const elapsed = now - date.getTime();
  let relative = null;
  if (elapsed >= 0 && elapsed < 3 * day) {
    relative = elapsed < minute ? '刚刚' : elapsed < hour ? `${Math.floor(elapsed / minute)} 分钟前`
      : elapsed < day ? `${Math.floor(elapsed / hour)} 小时前` : `${Math.floor(elapsed / day)} 天前`;
  }
  return { absolute, relative };
}

export function setupCommentTimes(root = document) {
  const entries = [...root.querySelectorAll('[data-comment-time]')].map(element => ({ element, absolute: false }));
  const render = entry => {
    const value = commentTime(entry.element.dateTime);
    if (!value) return;
    const { element } = entry;
    element.textContent = entry.absolute || !value.relative ? value.absolute : value.relative;
    if (value.relative) {
      element.setAttribute('role', 'button');
      element.tabIndex = 0;
      element.setAttribute('aria-label', `${element.textContent}，点击显示${entry.absolute ? '相对' : '绝对'}时间`);
      element.title = entry.absolute ? '点击显示相对时间' : `${value.absolute}（本地时间），点击切换`;
    } else {
      for (const attribute of ['role', 'tabindex', 'aria-label']) element.removeAttribute(attribute);
      element.title = '本地时间';
      entry.absolute = false;
    }
  };
  for (const entry of entries) {
    const toggle = () => {
      if (commentTime(entry.element.dateTime)?.relative) entry.absolute = !entry.absolute;
      render(entry);
    };
    entry.element.addEventListener('click', toggle);
    entry.element.addEventListener('keydown', event => {
      if (entry.element.getAttribute('role') === 'button' && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault(); toggle();
      }
    });
    render(entry);
  }
  // Refresh elapsed labels and retire the toggle as a comment passes the three-day boundary.
  if (entries.length) {
    setInterval(() => { if (!document.hidden) entries.forEach(render); }, 30_000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) entries.forEach(render); });
    window.addEventListener('pageshow', () => entries.forEach(render));
  }
}
