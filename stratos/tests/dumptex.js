const fs = await import('node:fs');
const items = await page.evaluate(() => {
  const g = window.game; const seen = new Set(); const out = [];
  g.player.model.root.traverse((o) => {
    const m = o.material; if (!m || Array.isArray(m)) return;
    for (const k of ['map', 'normalMap', 'roughnessMap']) {
      const t = m[k]; if (!t || seen.has(t) || !t.image || !t.image.toDataURL) continue;
      seen.add(t);
      const c = document.createElement('canvas'); const s = Math.min(1, 1024 / t.image.width);
      c.width = t.image.width * s; c.height = t.image.height * s;
      c.getContext('2d').drawImage(t.image, 0, 0, c.width, c.height);
      out.push([`${o.name || 'mesh'}_${k}_${t.image.width}`, c.toDataURL('image/png')]);
    }
  });
  return out;
});
for (const [n, d] of items) { fs.writeFileSync(`tests/output/tex_${n.replace(/[^a-z0-9_]/gi, '')}.png`, Buffer.from(d.split(',')[1], 'base64')); console.log(n); }
