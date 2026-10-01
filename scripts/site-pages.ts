// Renders CHANGELOG.md, PRIVACY.md and SECURITY.md into pages of the marketing site.
// The output depends only on those files and package.json, so test/site.test.ts can require the committed pages to match.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_URL = "https://github.com/getdomovoi/osnova";

interface PageSource {
  file: string;
  slug: string;
  title: string;
  description: string;
}

const SOURCES: readonly PageSource[] = [
  { file: "CHANGELOG.md", slug: "changelog", title: "Changelog", description: "Every osnova release: what was added, changed, fixed and broken, with what was measured." },
  { file: "PRIVACY.md", slug: "privacy", title: "Privacy", description: "Osnova runs on your machine. What it reads, what it writes, and what it sends: nothing." },
  { file: "SECURITY.md", slug: "security", title: "Security", description: "Supported versions, what osnova may touch, and how to report a vulnerability." },
];

// Links between the three documents stay on the site; any other relative link goes to the file on GitHub.
const SITE_LINKS = new Map(SOURCES.map((source) => [source.file, { href: `/${source.slug}/`, label: source.title }]));

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function linkTarget(target: string): string {
  if (/^https?:\/\//.test(target) || target.startsWith("#")) return target;
  return `${REPO_URL}/${target.endsWith("/") ? "tree" : "blob"}/main/${target}`;
}

function renderText(text: string): string {
  const pattern = /\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:])/g;
  let out = "";
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    out += escapeHtml(text.slice(last, match.index));
    const [whole, label, target, bare] = match;
    if (bare !== undefined) {
      out += `<a href="${escapeHtml(bare)}">${escapeHtml(bare)}</a>`;
    } else if (label !== undefined && target !== undefined) {
      const site = SITE_LINKS.get(target);
      out += site ? `<a href="${site.href}">${escapeHtml(site.label)}</a>` : `<a href="${escapeHtml(linkTarget(target))}">${renderInline(label)}</a>`;
    }
    last = (match.index ?? 0) + whole.length;
  }
  return out + escapeHtml(text.slice(last));
}

// Code spans first, so their contents are never read as links; everything between them is plain text.
function renderInline(text: string): string {
  return text
    .split(/(`[^`]+`)/)
    .map((part) => (part.startsWith("`") && part.endsWith("`") && part.length > 1 ? `<code>${escapeHtml(part.slice(1, -1))}</code>` : renderText(part)))
    .join("");
}

function slugify(text: string): string {
  const version = /^(\d+\.\d+\.\d+)/.exec(text);
  if (version?.[1]) return `v${version[1].replace(/\./g, "-")}`;
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

interface Rendered {
  body: string;
  sections: { id: string; text: string }[];
}

function renderMarkdown(markdown: string): Rendered {
  const blocks: string[] = [];
  const sections: { id: string; text: string }[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let section = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const heading = /^(#{1,6}) (.*)$/.exec(line);
    if (line.trim() === "") {
      i += 1;
    } else if (heading) {
      const level = heading[1]?.length ?? 1;
      const text = heading[2]?.trim() ?? "";
      if (level === 1) {
        blocks.push(`<h1 data-words>${renderInline(text)}</h1>`);
      } else {
        const id = level === 2 ? slugify(text) : `${section}-${slugify(text)}`;
        if (level === 2) {
          section = id;
          sections.push({ id, text });
        }
        blocks.push(`<h${level} id="${id}">${renderInline(text)}</h${level}>`);
      }
      i += 1;
    } else if (line.startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith("- ")) {
        items.push(`<li>${renderInline((lines[i] ?? "").slice(2).trim())}</li>`);
        i += 1;
      }
      blocks.push(`<ul>\n${items.join("\n")}\n</ul>`);
    } else {
      const paragraph: string[] = [];
      while (i < lines.length && (lines[i] ?? "").trim() !== "" && !/^(#{1,6} |- )/.test(lines[i] ?? "")) {
        paragraph.push((lines[i] ?? "").trim());
        i += 1;
      }
      blocks.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
    }
  }
  return { body: blocks.join("\n"), sections };
}

const MARK = '<rect x="4.4" y="2.6" width="3.1" height="17.9" rx="0.4"/><rect x="10.45" y="5.6" width="3.1" height="14.9" rx="0.4"/><rect x="16.5" y="4.1" width="3.1" height="16.4" rx="0.4"/><rect x="1.6" y="10.9" width="20.8" height="2.6" rx="0.4"/><rect x="1.6" y="17.4" width="20.8" height="3.1" rx="0.4"/>';

function page(source: PageSource, rendered: Rendered, version: string): string {
  // A long document gets a jump list of its sections after the opening paragraph.
  let body = rendered.body;
  if (rendered.sections.length > 6) {
    // A version heading such as "0.11.0 (2026-09-30)" shows as its version, with the full heading as the tooltip.
    const label = (text: string) => /^\d+\.\d+\.\d+/.exec(text)?.[0] ?? text;
    const items = rendered.sections.map((s) => `<li><a href="#${s.id}" title="${escapeHtml(s.text)}">${renderInline(label(s.text))}</a></li>`);
    const toc = `<nav class="doc-toc" aria-label="${escapeHtml(source.title)} sections">\n<ul>\n${items.join("\n")}\n</ul>\n</nav>`;
    const firstParagraphEnd = body.indexOf("</p>");
    body = firstParagraphEnd === -1 ? `${toc}\n${body}` : `${body.slice(0, firstParagraphEnd + 4)}\n${toc}${body.slice(firstParagraphEnd + 4)}`;
  }
  const footLinks = [
    `<a href="${REPO_URL}">GitHub</a>`,
    `<a href="https://www.npmjs.com/package/@getdomovoi/osnova">npm</a>`,
    `<a href="${REPO_URL}/blob/main/docs/reference.md">Reference</a>`,
    ...SOURCES.map((s) => `<a href="/${s.slug}/"${s.slug === source.slug ? ' aria-current="page"' : ""}>${s.title}</a>`),
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(source.title)}, osnova</title>
<meta name="description" content="${escapeHtml(source.description)}">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#0D0E0F" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#F5F3EF" media="(prefers-color-scheme: light)">
<link rel="canonical" href="https://getosnova.dev/${source.slug}/">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600&family=IBM+Plex+Sans:wght@400;500&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">
<script src="/main.js" defer></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<!-- Generated by scripts/site-pages.ts from ${source.file}; edit the source and run pnpm site:pages. -->
<header class="bar">
  <div class="wrap bar-inner">
    <a class="brand" href="/" aria-label="osnova home">
      <svg class="mark" viewBox="0 0 24 24" aria-hidden="true">${MARK}</svg>
      <span class="wordmark">osnova</span>
    </a>
    <nav class="nav" aria-label="Primary">
      <a href="/#install">Install</a>
      <a href="/#tools">Tools</a>
      <a href="/#evidence">Evidence</a>
      <a href="${REPO_URL}">GitHub</a>
    </nav>
    <a class="version" href="https://www.npmjs.com/package/@getdomovoi/osnova" aria-label="Latest version on npm">npm <span data-npm-version>${escapeHtml(version)}</span></a>
  </div>
</header>
<main id="main" class="doc wrap">
<article class="doc-inner">
${body}
<p class="doc-source">This page is built from <a href="${REPO_URL}/blob/main/${source.file}">${source.file}</a> in the repository.</p>
</article>
</main>
<footer class="foot" data-reveal>
  <div class="wrap foot-inner">
    <div class="foot-brand">
      <svg class="mark mark-static" viewBox="0 0 24 24" aria-hidden="true">${MARK}</svg>
      <p><em>Osnova</em> is the Slavic word for base or foundation. That is the job: give an agent solid ground to stand on before it edits code.</p>
    </div>
    <nav class="foot-links" aria-label="Project">
      ${footLinks.join("\n      ")}
    </nav>
    <p class="foot-note">Apache-2.0, by getdomovoi. This site sets no cookies and runs no analytics. It loads fonts from Google Fonts and asks the npm registry for the latest version number.</p>
  </div>
  <div class="foot-plinth" aria-hidden="true"></div>
</footer>
</body>
</html>
`;
}

export function renderSitePages(root: string): Record<string, string> {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
  const pages: Record<string, string> = {};
  for (const source of SOURCES) {
    const rendered = renderMarkdown(fs.readFileSync(path.join(root, source.file), "utf8"));
    pages[`${source.slug}/index.html`] = page(source, rendered, pkg.version);
  }
  return pages;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  for (const [rel, html] of Object.entries(renderSitePages(root))) {
    const file = path.join(root, "site", "public", rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, html);
    process.stdout.write(`wrote site/public/${rel}\n`);
  }
}
