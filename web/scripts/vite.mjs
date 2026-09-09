// Vite rejects unknown flags. Translate --record into a bookmarkable URL for
// both the dev server and the production preview, without baking it into builds.
const args = process.argv.slice(2);
if (args.includes('--record')) {
  const open = args.indexOf('--open');
  if (open !== -1) {
    args.splice(open, args[open + 1] && !args[open + 1].startsWith('-') ? 2 : 1);
  }
  process.argv = [process.argv[0], process.argv[1],
    ...args.filter((arg) => arg !== '--record'), '--open', '/?record'];
}
await import(new URL('./bin/vite.js', import.meta.resolve('vite/package.json')).href);
