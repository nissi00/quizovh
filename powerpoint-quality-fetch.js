(() => {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === 'string' && input.startsWith('/api/presentation/state?')) {
      input = input.replace('/api/presentation/state?', '/api/quality/presentation/state?');
    } else if (typeof input === 'string' && input.startsWith('/api/presentation/exam?')) {
      input = input.replace('/api/presentation/exam?', '/api/quality/presentation/exam?');
    }
    return nativeFetch(input, init);
  };
})();
