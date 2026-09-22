export function extractEndingKeys(window) {
  const evalInWindow = (expr) => {
    try { return window.eval(expr); } catch { return null; }
  };
  const oneliner = evalInWindow("typeof ENDING_ONELINER !== 'undefined' ? ENDING_ONELINER : {}") || {};
  const hints = evalInWindow("typeof ENDING_HINTS !== 'undefined' ? ENDING_HINTS : {}") || {};
  const rarityOf = (name) => {
    try {
      const r = window.eval(`rarityOf(${JSON.stringify(name)})`);
      return Array.isArray(r) ? r[0] : null;
    } catch {
      return null;
    }
  };
  return Object.keys({ ...hints, ...oneliner })
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
    .map((name) => ({
      ending_id: name,
      ending_name: name,
      rarity: rarityOf(name) || undefined,
      oneliner: oneliner[name] || undefined,
    }));
}

export function engineVersionFromHtml(html) {
  const m = String(html).match(/TokenLife\s+v([0-9]+(?:\.[0-9]+)*)/);
  return m ? `v${m[1]}` : null;
}
