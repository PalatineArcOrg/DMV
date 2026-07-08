// Render CHANGELOG.md → a self-contained, on-brand changelog.html for dmv.palatinearc.com.
import { readFileSync, writeFileSync } from 'node:fs';

const md = readFileSync('/root/DMV/CHANGELOG.md', 'utf8');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function inline(s) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*\s][^*]*?)\*/g, '<em>$1</em>'); // single-asterisk italic (after bold)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}

const lines = md.split('\n');
const out = [];
let inList = false, para = [], curLi = null;
const closePara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
// Accumulate a bullet's RAW text across continuation lines, then format ONCE — so inline
// markup (e.g. **bold**) that spans a line break still renders.
const closeLi = () => { if (curLi !== null) { out.push(`<li>${inline(curLi)}</li>`); curLi = null; } };
const closeList = () => { closeLi(); if (inList) { out.push('</ul>'); inList = false; } };
const flush = () => { closePara(); closeList(); };

for (const raw of lines) {
  const line = raw.replace(/\s+$/, '');
  if (/^#\s+Changelog\s*$/.test(line)) continue;                 // page has its own title
  if (line === '') { closePara(); closeLi(); continue; }
  const h3 = line.match(/^###\s+(.*)/), h2 = line.match(/^##\s+(.*)/), h1 = line.match(/^#\s+(.*)/);
  if (h3) { flush(); out.push(`<h3>${inline(h3[1])}</h3>`); continue; }
  if (h2) { flush(); out.push(`<h2>${inline(h2[1])}</h2>`); continue; }
  if (h1) { flush(); out.push(`<h2>${inline(h1[1])}</h2>`); continue; }
  const li = line.match(/^-\s+(.*)/);
  if (li) { closePara(); if (!inList) { out.push('<ul>'); inList = true; } closeLi(); curLi = li[1]; continue; }
  if (inList && curLi !== null && /^\s{2,}\S/.test(raw)) { curLi += ' ' + line.trim(); continue; }
  if (inList) closeList();
  para.push(line.trim());
}
flush();

const body = out.join('\n');
const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dead Man's Vault — Changelog</title>
<meta name="description" content="Release history for Dead Man's Vault, the autonomous crypto-inheritance protocol on Solana.">
<link rel="icon" href="/icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  :root { --bg:#07090F; --surface:#0F1521; --text:#E7ECF3; --muted:#9AA6B8; --accent:#00FFA3; --border:#1C2534; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
    font-family:'Space Grotesk',system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
    line-height:1.6; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:820px; margin:0 auto; padding:48px 22px 96px; }
  header { display:flex; align-items:center; gap:14px; margin-bottom:8px; }
  header img { width:40px; height:40px; border-radius:9px; }
  h1 { font-size:30px; font-weight:700; margin:0; letter-spacing:-0.02em; }
  .sub { color:var(--muted); font-size:14px; margin:4px 0 34px; }
  .sub a { color:var(--accent); text-decoration:none; }
  h2 { font-size:20px; font-weight:700; margin:44px 0 6px; padding-top:22px; border-top:1px solid var(--border);
    letter-spacing:-0.01em; }
  h2:first-of-type { border-top:none; padding-top:0; }
  h3 { font-size:13px; font-weight:500; text-transform:uppercase; letter-spacing:0.08em;
    color:var(--accent); margin:22px 0 8px; }
  p { margin:10px 0; color:#CFD7E3; }
  ul { margin:8px 0 8px; padding-left:20px; }
  li { margin:7px 0; color:#CFD7E3; }
  li::marker { color:var(--accent); }
  strong { color:#FFFFFF; font-weight:500; }
  em { color:#DCE3EC; font-style:italic; }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:0.86em;
    background:var(--surface); border:1px solid var(--border); border-radius:5px; padding:1px 5px; color:#B9F5DE; overflow-wrap:anywhere; }
  a { color:var(--accent); }
  .back { display:inline-block; margin-top:40px; color:var(--muted); text-decoration:none; font-size:14px; }
  .back:hover { color:var(--accent); }
  @media (max-width:600px){ .wrap{padding:32px 18px 72px;} h1{font-size:24px;} }
</style>
</head>
<body>
  <div class="wrap">
    <header><img src="/icon.png" alt=""><h1>Changelog</h1></header>
    <p class="sub">Dead Man's Vault — autonomous crypto inheritance on Solana (Devnet). &nbsp;·&nbsp;
      <a href="/">Home</a> &nbsp;·&nbsp; <a href="https://github.com/Romulus-Sol/DMV/releases" target="_blank" rel="noopener">Releases</a></p>
${body}
    <a class="back" href="/">← Back to dmv.palatinearc.com</a>
  </div>
</body>
</html>`;

writeFileSync('/var/www/dmv/changelog.html', page);
console.log('wrote /var/www/dmv/changelog.html —', page.length, 'bytes;', out.length, 'blocks');
