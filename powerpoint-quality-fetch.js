(() => {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === 'string' && input.startsWith('/api/presentation/state?')) {
      input = input.replace('/api/presentation/state?', '/api/quality/presentation/state?');
    }
    return nativeFetch(input, init);
  };
})();
