#!/usr/bin/env node
// Unpacks the bundled HTML into a self-contained embeddable HTML file.
// Images/fonts become base64 data URIs.
// React, ReactDOM, Babel are swapped for CDN links (much smaller output).

const fs = require('fs');
const zlib = require('zlib');
const { promisify } = require('util');
const gunzip = promisify(zlib.gunzip);

const INPUT = '/root/.claude/uploads/9d488ebd-a4f5-478e-9661-0050eb9dbae2/7376366c-Hydration_Booster__Built_for_Chris.html';
const OUTPUT = '/home/user/claude-code/hydration-booster-embed.html';

// CDN replacements for the large bundled JS libs (React 18.3.1, Babel 7.18.14)
const CDN_REPLACEMENTS = {
  'eaef0965-6b03-41ac-abaa-e4d9190188a5': 'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
  '37096e2d-0361-480d-9d02-a002000a1c92': 'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
  '46372df1-acb8-4cf6-b469-a9475eef16c5': 'https://unpkg.com/@babel/standalone@7.18.14/babel.min.js',
};

async function decode(entry) {
  const bytes = Buffer.from(entry.data, 'base64');
  if (!entry.compressed) return bytes;
  try { return await gunzip(bytes); }
  catch (e) { console.warn(`gunzip failed (${entry.mime}):`, e.message); return bytes; }
}

async function main() {
  console.log('Reading file...');
  const html = fs.readFileSync(INPUT, 'utf8');
  const lines = html.split('\n');

  // File lines are 1-indexed; JS array is 0-indexed (lines[N-1] = file line N)
  console.log('Parsing manifest...');
  const manifest = JSON.parse(lines[162]);     // file line 163

  console.log('Parsing ext_resources...');
  const extResources = JSON.parse(lines[166]); // file line 167

  console.log('Parsing template...');
  let template = JSON.parse(lines[170]);       // file line 171

  const uuids = Object.keys(manifest);
  const jsUuids = new Set(uuids.filter(u => manifest[u].mime === 'text/javascript'));

  // Step 1: Replace <script src="UUID" ...></script> for CDN libs with CDN src
  console.log('Swapping bundled JS for CDN links...');
  for (const [uuid, cdnUrl] of Object.entries(CDN_REPLACEMENTS)) {
    const re = new RegExp(`<script[^>]*\\bsrc="${uuid}"[^>]*>\\s*<\\/script>`, 'gi');
    template = template.replace(re, `<script src="${cdnUrl}"></script>`);
    jsUuids.delete(uuid); // already handled
  }

  // Step 2: Inline any remaining JS assets (should be none, but as fallback)
  if (jsUuids.size > 0) {
    console.log(`Inlining ${jsUuids.size} remaining JS asset(s)...`);
    for (const uuid of jsUuids) {
      const jsBytes = await decode(manifest[uuid]);
      const jsContent = jsBytes.toString('utf8');
      const re = new RegExp(`<script[^>]*\\bsrc="${uuid}"[^>]*>\\s*<\\/script>`, 'gi');
      template = template.replace(re, `<script>\n${jsContent}\n</script>`);
    }
  }

  // Step 3: Build data URIs for non-JS assets (fonts, images, SVGs)
  console.log('Building data URIs for images and fonts...');
  const dataUrls = {};
  for (const uuid of uuids) {
    if (manifest[uuid].mime === 'text/javascript') continue;
    const bytes = await decode(manifest[uuid]);
    dataUrls[uuid] = `data:${manifest[uuid].mime};base64,${bytes.toString('base64')}`;
  }

  // Step 4: Replace UUID references in template with data URIs
  console.log('Replacing UUID references...');
  for (const [uuid, dataUrl] of Object.entries(dataUrls)) {
    template = template.split(uuid).join(dataUrl);
  }

  // Step 5: Strip integrity + crossorigin (not valid for CDN without SRI, or data URIs)
  template = template.replace(/\s+integrity="[^"]*"/gi, '').replace(/\s+crossorigin="[^"]*"/gi, '');

  // Step 6: Inject window.__resources (id -> data URI) after <head>
  const resourceMap = {};
  for (const entry of extResources) {
    if (dataUrls[entry.uuid]) resourceMap[entry.id] = dataUrls[entry.uuid];
  }
  const resourceScript = `<script>window.__resources = ${JSON.stringify(resourceMap)};<\/script>`;
  const headMatch = template.match(/<head[^>]*>/i);
  if (headMatch) {
    const i = headMatch.index + headMatch[0].length;
    template = template.slice(0, i) + resourceScript + template.slice(i);
  }

  const sizeMB = (Buffer.byteLength(template) / 1024 / 1024).toFixed(1);
  console.log(`Writing output (${sizeMB} MB)...`);
  fs.writeFileSync(OUTPUT, template, 'utf8');
  console.log('Done! Output:', OUTPUT);
}

main().catch(err => { console.error(err); process.exit(1); });
