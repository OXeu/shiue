(() => {
  const search = document.querySelector('[data-search]');
  if (!search) return;
  const form = search.querySelector('form');
  const input = search.querySelector('input');
  const status = search.querySelector('[role="status"]');
  const results = search.querySelector('[data-search-results]');
  let indexPromise;
  let revision = 0;
  let timer;
  const normalize = text => String(text).normalize('NFKC').toLocaleLowerCase();
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const renderCard = item => {
    const card = element('article', 'post-card');
    if (item.image) {
      const cover = element('a', 'card-cover');
      cover.href = item.permalink;
      cover.tabIndex = -1;
      cover.setAttribute('aria-hidden', 'true');
      cover.dataset.progressiveImage = '';
      if (item.imageData?.blurhash) cover.dataset.blurhash = item.imageData.blurhash;
      if (item.imageData?.height) cover.dataset.ratio = item.imageData.width / item.imageData.height;
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      if (item.imageData?.srcset) {
        img.sizes = item.imageData.sizes;
        img.srcset = item.imageData.srcset;
      }
      if (item.imageData?.width) img.width = item.imageData.width;
      if (item.imageData?.height) img.height = item.imageData.height;
      img.src = item.image;
      cover.append(img);
      card.append(cover);
    }
    const body = element('div', 'card-body');
    body.append(element('div', 'card-taxonomy', item.tags.slice(0, 2).map(tag => `# ${tag}`).join('  ')));
    const title = element('h2', 'card-title');
    const link = element('a', '', item.title);
    link.href = item.permalink;
    title.append(link);
    body.append(title, element('p', 'card-summary', item.description));
    const meta = element('div', 'card-meta');
    const date = element('time', '', item.date);
    date.dateTime = item.date;
    meta.append(date, element('span', '', `${item.readingTime} 分钟阅读`));
    body.append(meta);
    card.append(body);
    return card;
  };
  const run = async () => {
    const current = ++revision;
    const query = input.value.trim();
    const url = new URL(location.href);
    if (query) url.searchParams.set('keyword', query);
    else url.searchParams.delete('keyword');
    history.replaceState(null, '', url);
    results.replaceChildren();
    if (!query) {
      status.textContent = '输入关键词开始搜索。';
      return;
    }
    status.textContent = '正在搜索…';
    try {
      indexPromise ??= fetch(search.dataset.index).then(response => {
        if (!response.ok) throw new Error('搜索索引加载失败');
        return response.json();
      }).catch(error => { indexPromise = undefined; throw error; });
      const index = await indexPromise;
      if (current !== revision) return;
      const words = normalize(query).split(/\s+/);
      const matches = index.map(item => {
        const title = normalize(item.title);
        const tags = normalize(item.tags.join(' '));
        const haystack = `${title} ${tags} ${normalize(item.content)}`;
        return { item, score: words.every(word => haystack.includes(word))
          ? 1 + words.reduce((score, word) => score + (title.includes(word) ? 10 : 0) + (tags.includes(word) ? 5 : 0), 0) : 0 };
      }).filter(result => result.score > 0).sort((a, b) => b.score - a.score);
      results.replaceChildren(...matches.map(({ item }) => renderCard(item)));
      status.textContent = matches.length ? `找到 ${matches.length} 篇相关文章` : `没有找到与「${query}」相关的文章，试试其他关键词。`;
    } catch {
      if (current === revision) status.textContent = '搜索暂时不可用，请重新搜索以重试。';
    }
  };
  form.addEventListener('submit', event => { event.preventDefault(); clearTimeout(timer); run(); });
  input.addEventListener('input', event => {
    if (event.isComposing) return;
    clearTimeout(timer);
    ++revision;
    timer = setTimeout(run, 180);
  });
  input.addEventListener('compositionend', () => { clearTimeout(timer); run(); });
  input.value = new URLSearchParams(location.search).get('keyword') || '';
  if (input.value) run();
})();
