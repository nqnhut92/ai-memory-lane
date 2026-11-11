export function memoryPage(mode: "local" | "neon", review = false): string {
  const title = review ? "Memory review" : "Memory";
  const id = review ? "memory-review" : "memory-app";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="light dark">
<title>${title} · Memory Lane</title><link rel="icon" href="/assets/memory.svg" type="image/svg+xml">
<script src="/assets/theme.js"></script>
<link rel="stylesheet" href="/assets/base.css"><link rel="stylesheet" href="/assets/scroll.css">
<link rel="stylesheet" href="/assets/memory.css"><link rel="stylesheet" href="/assets/shell.css">
<script type="module" src="/assets/shell.js"></script>
<script type="module" src="/assets/${review ? "memory-review" : "memory"}.js"></script>
</head><body class="memory-page">
<a class="skip-link" href="#main">Skip to content</a>
<header class="local-header wrap glass"><a class="local-brand" href="/memory"><img src="/assets/memory.svg" width="32" height="32" alt="">Memory Lane</a>
<nav aria-label="Main"><a href="/memory"${review ? "" : ' aria-current="page"'}>Memory</a><a href="/memory/review"${review ? ' aria-current="page"' : ""}>Review</a></nav>
<span class="database-mode${mode === "neon" ? " remote" : ""}">${mode === "neon" ? "Neon database · live changes" : "Local database"}</span>
<button class="local-theme glass-control" type="button" aria-label="Change appearance">Appearance</button></header>
<main id="main" class="wrap memory-shell"><div id="${id}" role="status" aria-label="Loading ${review ? "proposals" : "memories"}"><div class="memory-loading"></div></div><noscript>Enable JavaScript to read your memories.</noscript></main>
<template id="memory-scan-help">ask an AI client connected to this same database to “scan my memories”. It uses memory_propose to send proposals here. Nothing changes until you approve.</template>
</body></html>`;
}
