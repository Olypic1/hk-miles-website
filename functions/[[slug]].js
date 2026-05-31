/**
 * functions/[[slug]].js  —  Cloudflare Pages catchall Function
 *
 * Handles pretty article URLs like /asia-miles-2026-5 or /everymile-card.
 * The double-bracket [[slug]] is a CF Pages catchall that matches any
 * unmatched path segment. We resolve the segment as a Sanity slug; if
 * found, serve the /article template with full meta + window.__ARTICLE
 * bootstrap. If not, fall through (Cloudflare returns the static asset
 * or a 404).
 *
 * Why a separate file and not in _middleware.js? Cloudflare Pages
 * _middleware only reliably runs when a sibling Function exists to wrap.
 * A catchall Function gives us deterministic invocation for arbitrary
 * single-segment paths.
 */

const SANITY = 'https://j3rszqec.api.sanity.io/v2024-01-01/data/query/promotions';
const BASE   = 'https://hkmiles.app';
const OG_IMG = `${BASE}/og-image.png`;

const RESERVED = new Set([
  '', 'article', 'article.html',
  'promotions', 'promotions.html',
  'updates', 'updates.html',
  'index', 'index.html',
  'privacy', 'privacy.html',
  'terms', 'terms.html',
  'sitemap.xml', 'robots.txt', 'llms.txt',
  'og-image.png', 'og-preview.png',
  'articles-data.js', 'card-banner.psd',
  'assets', 'favicon.ico', 'apple-touch-icon.png',
]);

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function jsEsc(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/</g, '\\u003c');
}

function ptText(blocks, max = 160) {
  if (!Array.isArray(blocks)) return '';
  let t = '';
  for (const b of blocks) {
    if (b?._type === 'block')
      t += (b.children ?? []).map(c => c.text ?? '').join('') + ' ';
    if (t.length > max) break;
  }
  return t.trim().slice(0, max);
}

async function sq(groq) {
  try {
    const res = await fetch(
      `${SANITY}?query=${encodeURIComponent(groq)}`,
      { cf: { cacheTtl: 300, cacheEverything: true } }
    );
    return res.ok ? ((await res.json()).result ?? null) : null;
  } catch {
    return null;
  }
}

async function resolveSlug(seg) {
  const doc = await sq(`*[(_type=="promotion"||_type=="creditCard")&&slug.current=="${seg}"][0]{
    _type, _id, title, bank, summary, categories,
    "img": coalesce(imageUrl, mainImage.asset->url, cardImage.asset->url),
    "content2": content[0..1],
    _createdAt, publishedAt, _updatedAt
  }`);
  if (!doc) return null;
  return { type: doc._type === 'creditCard' ? 'card' : 'promo', doc };
}

function descFor(doc, type) {
  if (type === 'card') {
    return ptText(doc.summary) || ptText(doc.content2)
      || `${doc.title} 信用卡詳情、年費、回贈率及申請資格。更多香港信用卡攻略盡在 HK Miles。`;
  }
  return ptText(doc.content2)
    || `${doc.title} 優惠詳情、到期日及申請方法。更多香港信用卡優惠盡在 HK Miles。`;
}

function rewriteHead(html, { title, desc, img, url, type, articleScript, datePublished, dateModified }) {
  const T = esc(`${title} | HK Miles`);
  const D = esc(desc);
  const I = esc(img);
  const U = esc(url);

  const speakable = {
    '@type': 'SpeakableSpecification',
    cssSelector: ['h1.article-title', '.article-lede'],
  };

  const articleLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: title, description: desc, image: img, url,
    inLanguage: 'zh-HK',
    speakable,
    ...(datePublished && { datePublished }),
    ...(dateModified  && { dateModified }),
    author: { '@type': 'Organization', name: 'HK Miles', url: BASE },
    publisher: {
      '@type': 'Organization', name: 'HK Miles', url: BASE,
      logo: { '@type': 'ImageObject', url: OG_IMG },
    },
  };

  const ld = JSON.stringify([
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'HK Miles', item: BASE + '/' },
        { '@type': 'ListItem', position: 2, name: type === 'product' ? '信用卡' : '優惠情報', item: BASE + '/promotions' },
        { '@type': 'ListItem', position: 3, name: title, item: url },
      ],
    },
    type === 'product'
      ? {
          '@context': 'https://schema.org',
          '@type': 'FinancialProduct',
          name: title, description: desc, image: img, url,
          speakable,
          provider: { '@type': 'Organization', name: 'HK Miles', url: BASE },
        }
      : articleLd,
  ]);

  return html
    .replace(/<title>[^<]*<\/title>/,                                `<title>${T}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/,         `$1${D}$2`)
    .replace(/(<link rel="canonical" href=")[^"]*(")/,               `$1${U}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/,        `$1${T}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/,  `$1${D}$2`)
    .replace(/(<meta property="og:image" content=")[^"]*(")/,        `$1${I}$2`)
    .replace(/(<meta property="og:image:alt" content=")[^"]*(")/,    `$1${T}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/,          `$1${U}$2`)
    .replace(/(<meta property="og:type" content=")[^"]*(")/,         `$1${esc(type)}$2`)
    .replace(/(<meta name="twitter:title" content=")[^"]*(")/,       `$1${T}$2`)
    .replace(/(<meta name="twitter:description" content=")[^"]*(")/,  `$1${D}$2`)
    .replace(/(<meta name="twitter:image" content=")[^"]*(")/,       `$1${I}$2`)
    .replace('</head>', `${articleScript || ''}<script type="application/ld+json">${ld}</script>\n</head>`);
}

export async function onRequest(ctx) {
  const url = new URL(ctx.request.url);
  const seg = url.pathname.replace(/^\/|\/$/g, '');

  // Only resolve clean single-segment paths. Anything else: pass through.
  if (
    !seg ||
    seg.includes('/') ||
    seg.includes('.') ||
    RESERVED.has(seg)
  ) {
    return ctx.next();
  }

  const found = await resolveSlug(seg);
  if (!found) return ctx.next();

  // Fetch /article HTML template and rewrite it with meta + slug bootstrap.
  const articleRes = await fetch(new URL('/article', url), {
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!articleRes.ok) return ctx.next();

  const tmpl = await articleRes.text();
  const articleScript =
    `<script>window.__ARTICLE={type:"${jsEsc(found.type)}",slug:"${jsEsc(seg)}"};</script>`;

  const modified = rewriteHead(tmpl, {
    title:         found.doc.title || '文章',
    desc:          descFor(found.doc, found.type),
    img:           found.doc.img || OG_IMG,
    url:           `${BASE}/${seg}`,
    type:          found.type === 'card' ? 'product' : 'article',
    articleScript,
    datePublished: found.doc.publishedAt || found.doc._createdAt || null,
    dateModified:  found.doc._updatedAt || null,
  });

  return new Response(modified, {
    headers: {
      'Content-Type':  'text/html;charset=UTF-8',
      'Cache-Control': 'public,max-age=300,stale-while-revalidate=3600',
      'x-pretty-slug': seg,
    },
  });
}
