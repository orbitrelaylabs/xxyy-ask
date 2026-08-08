export function renderAdminPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>XXYY Knowledge Admin</title>
    <link rel="stylesheet" href="/web-assets/index.css?v=2" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/web-assets/index.js?v=2"></script>
  </body>
</html>`;
}
