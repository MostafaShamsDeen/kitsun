// Rebuilds index.html here from renderer/index.html: the same page, with stub.js loaded first (in place of main's
// preload) and its paths pointing into renderer/. Run it after changing renderer/index.html.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'index.html'), 'utf8');
const swap = (text, from, to) => {
  if (!text.includes(from)) throw new Error(`renderer/index.html no longer has: ${from}`);
  return text.replace(from, to);
};
let html = swap(src, '<head>\n', `<head>
  <!-- Dev preview of the renderer in a normal browser (not shipped: the packager ignores scripts/). Built by make-index.js
       from renderer/index.html. Serve the repo root with any static server and open /scripts/home-preview/?state=full|empty|one
       (&scan=1 to show the scanning state, &dialog=settings to open the Settings dialog as the tray menu does, &dev=1 to
       show it as a run from source). -->
`);
html = swap(html, '<title>Kitsun</title>', '<title>Kitsun · Home preview</title>');
html = swap(html, 'href="styles.css"', 'href="../../renderer/styles.css"');
html = html.replace(/<script src="([a-z]+\.js)"><\/script>/g, '<script src="../../renderer/$1"></script>');
html = swap(html, '  <script src="../../renderer/fox.js"></script>', '  <script src="stub.js"></script>\n  <script src="../../renderer/fox.js"></script>');
fs.writeFileSync(path.join(__dirname, 'index.html'), html);
console.log('wrote scripts/home-preview/index.html');
