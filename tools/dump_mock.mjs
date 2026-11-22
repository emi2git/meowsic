// dump the mock library (title, artist, tags, kind) for the icon picker
const { buildMock } = await import(new URL('../web/js/mock.js', import.meta.url));
const d = buildMock();
console.log(JSON.stringify(d.items.map(({ title, artist, tags, kind }) => ({ title, artist, tags, kind }))));
