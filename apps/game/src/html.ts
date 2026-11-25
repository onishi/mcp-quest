export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

const STYLE = `
:root{--bg:#f7f4ee;--fg:#22201c;--muted:#6b655a;--card:#fffdf8;--line:#e2dccf;--accent:#7a4b1d;--err:#a3271f}
@media (prefers-color-scheme: dark){:root{--bg:#1b1a17;--fg:#ece6da;--muted:#a59d8e;--card:#25231f;--line:#3a362f;--accent:#e0a96d;--err:#ff8a80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.7 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px 64px}h1{font-size:1.6rem;margin:0 0 .5rem}h2{font-size:1.1rem;margin:1.5rem 0 .5rem}
.muted{color:var(--muted)}.error{color:var(--err);font-weight:600}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:16px 0}
label{display:block;margin:.5rem 0}input{display:block;width:100%;padding:.6rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
button,.button{display:inline-block;margin-top:.75rem;padding:.6rem 1rem;border:0;border-radius:8px;background:var(--accent);color:var(--bg);font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
button.secondary{background:transparent;color:var(--muted);border:1px solid var(--line)}
.key{font:600 1.2rem ui-monospace,monospace;background:var(--card);border:1px dashed var(--accent);padding:12px;border-radius:8px;word-break:break-all}
ul.timeline{list-style:none;padding:0}ul.timeline li{border-left:3px solid var(--line);padding:4px 12px;margin:8px 0}code{font-family:ui-monospace,monospace;background:var(--card);padding:1px 4px;border-radius:4px}
`;

export function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}
