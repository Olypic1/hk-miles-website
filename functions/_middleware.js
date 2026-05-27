/**
 * functions/_middleware.js  —  Cloudflare Pages edge middleware
 *
 * Two responsibilities:
 *
 * 1. Resolve PRETTY ARTICLE URLs:
 *      /asia-miles-2026-5            →  promotion article
 *      /everymile-card               →  credit-card article
 *    The middleware checks Sanity for a matching slug. If found, it serves
 *    the /article static HTML with the slug injected as window.__ARTICLE
 *    so the client knows which document to fetch, plus full <head> meta.
 *
 * 2. Inject SEO meta for legacy /article?slug=… / ?id=… / ?card=… URLs
 *    (kept working for back-compat — existing inbound links continue to
 *    serve correctly with rich previews for crawlers/social bots).
 *
 * Result: AI crawlers and social bots that skip JS see accurate
 * OG tags, Twitter card, canonical URL, and JSON-LD on every article URL.
 */

const SANITY = 'https://j3rszqec.api.sanity.io/v2024-01-01/data/query/promotions';
const BASE   = 'https://hkmiles.app';
const OG_IMG = `${BASE}/og-image.png`;

// Reserved path segments — never treat these as article slugs. Anything in
// this set falls through to the static-asset handler (ctx.next).
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

// ── Tiny helpers ──────────────────────────────────────────────────────────────

/** HTML-escape a value for use inside an attribute or text node */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape for safe interpolation into a JS string literal */
function jsEsc(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/</g, '\\u003c')
    .replace(/ /g, '\\u2028')
    .replace(/ /g, '\\u2029');
}

/** Extract plain text from a Portable Text block array */
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

/** Run a GROQ query against the Sanity CDN (cached 5 min at the edge) */
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

// ── Sanity fetches (only the fields we need) ──────────────────────────────────

function fetchCard(slug) {
  return sq(`*[_type=="creditCard"&&slug.current=="${slug}"][0]{
    title, bank, summary, "content2":content[0..1],
    "img":coalesce(imageUrl,mainImage.asset->url,cardImage.asset->url)
  }`);
}

function fetchPromo(id, slug) {
  const f = id ? `_id=="${id}"` : `slug.current=="${slug}"`;
  return sq(`*[_type=="promotion"&&${f}][0]{
    title, bank, categories,
    "img":mainImage.asset->url,
    "content2":content[0..1]
  }`);
}

/** Resolve a single-segment path to a promotion or credit-card document.
 *  Returns { type: 'promo'|'card', doc } or null. */
async function resolveSlug(seg) {
  const doc = await sq(`*[(_type=="promotion"||_type=="creditCard")&&slug.current=="${seg}"][0]{
    _type, _id, title, bank, summary, categories,
    "img": coalesce(imageUrl, mainImage.asset->url, cardImage.asset->url),
    "content2": content[0..1]
  }`);
  if (!doc) return null;
  return { type: doc._type === 'creditCard' ? 'card' : 'promo', doc };
}

// ── HTML head rewriter ────────────────────────────────────────────────────────

function rewriteHead(html, { title, desc, img, url, type, articleScript }) {
  const T = esc(`${title} | HK Miles`);
  const D = esc(desc);
  const I = esc(img);
  const U = esc(url);

  // Server-rendered JSON-LD (replaces the client-injected version)
  const ld = JSON.stringify([
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'HK Miles',                             item: BASE + '/' },
        { '@type': 'ListItem', position: 2, name: type === 'product' ? '信用卡' : '優惠情報', item: BASE + '/promotions' },
        { '@type': 'ListItem', position: 3, name: title,                                  item: url },
      ],
    },
    type === 'product'
      ? {
          '@context': 'https://schema.org',
          '@type': 'FinancialProduct',
          name: title, description: desc, image: img, url,
          provider: { '@type': 'Organization', name: 'HK Miles', url: BASE },
        }
      : {
          '@context': 'https://schema.org',
          '@type': 'Article',
          headline: title, description: desc, image: img, url,
          inLanguage: 'zh-HK',
          author:    { '@type': 'Organization', name: 'HK Miles', url: BASE },
          publisher: {
            '@type': 'Organization', name: 'HK Miles', url: BASE,
            logo: { '@type': 'ImageObject', url: OG_IMG },
          },
        },
  ]);

  return html
    // Core
    .replace(/<title>[^<]*<\/title>/,                                `<title>${T}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/,         `$1${D}$2`)
    .replace(/(<link rel="canonical" href=")[^"]*(")/,               `$1${U}$2`)
    // Open Graph
    .replace(/(<meta property="og:title" content=")[^"]*(")/,        `$1${T}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/,  `$1${D}$2`)
    .replace(/(<meta property="og:image" content=")[^"]*(")/,        `$1${I}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/,          `$1${U}$2`)
    .replace(/(<meta property="og:type" content=")[^"]*(")/,         `$1${esc(type)}$2`)
    // Twitter
    .replace(/(<meta name="twitter:title" content=")[^"]*(")/,       `$1${T}$2`)
    .replace(/(<meta name="twitter:description" content=")[^"]*(")/,  `$1${D}$2`)
    .replace(/(<meta name="twitter:image" content=")[^"]*(")/,       `$1${I}$2`)
    // Inject server-rendered JSON-LD + optional window.__ARTICLE bootstrap
    .replace('</head>', `${articleScript || ''}<script type="application/ld+json">${ld}</script>\n</head>`);
}

/** Compose a description from a fetched doc + type ('promo' | 'card'). */
function descFor(doc, type) {
  if (type === 'card') {
    return ptText(doc.summary) || ptText(doc.content2)
      || `${doc.title} 信用卡詳情、年費、回贈率及申請資格。更多香港信用卡攻略盡在 HK Miles。`;
  }
  return ptText(doc.content2)
    || `${doc.title} 優惠詳情、到期日及申請方法。更多香港信用卡優惠盡在 HK Miles。`;
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function onRequest(ctx) {
  const url  = new URL(ctx.request.url);
  const seg  = url.pathname.replace(/^\/|\/$/g, '');
  const dbg  = { seg, matched: false, resolved: false, tmpl_ok: false };

  // ── Path A: pretty article URL  /asia-miles-2026-5 ────────────────────────
  // Single segment, no extension, not a reserved route name.
  if (
    seg &&
    !seg.includes('/') &&
    !seg.includes('.') &&
    !RESERVED.has(seg)
  ) {
    dbg.matched = true;
    const found = await resolveSlug(seg);
    dbg.resolved = !!found;
    if (found) {
      // Fetch the /article static HTML to use as the template.
      const articleRes = await fetch(new URL('/article', url), {
        cf: { cacheTtl: 300, cacheEverything: true },
      });
      dbg.tmpl_ok = articleRes.ok;
      dbg.tmpl_status = articleRes.status;
      if (articleRes.ok) {
        const tmpl = await articleRes.text();
        const articleScript = `<script>window.__ARTICLE={type:"${jsEsc(found.type)}",slug:"${jsEsc(seg)}"};</script>`;
        const modified = rewriteHead(tmpl, {
          title: found.doc.title || '文章',
          desc:  descFor(found.doc, found.type),
          img:   found.doc.img || OG_IMG,
          url:   `${BASE}/${seg}`,
          type:  found.type === 'card' ? 'product' : 'article',
          articleScript,
        });
        return new Response(modified, {
          headers: {
            'Content-Type':  'text/html;charset=UTF-8',
            'Cache-Control': 'public,max-age=300,stale-while-revalidate=3600',
            'x-mw-debug':    JSON.stringify(dbg),
          },
        });
      }
    }
    // Not a known slug — fall through to static handler (likely a 404).
  }

  // ── Path B: legacy /article?slug=… / ?id=… / ?card=… ──────────────────────
  const p    = url.searchParams;
  const card = p.get('card');
  const id   = p.get('id');
  const slug = p.get('slug');

  // Cloudflare's pretty-URL feature 308-redirects /article.html → /article
  // BEFORE the middleware runs for the canonical path. Don't intercept
  // /article.html ourselves: ctx.next() returns the redirect response, and
  // rewriting an empty body silently ships "200 OK + empty page" to the
  // client. Only intercept the canonical /article path with article params.
  const isArticlePath = url.pathname === '/article';
  if (!isArticlePath || (!card && !id && !slug)) {
    const passThrough = await ctx.next();
    // Attach debug for fall-through responses too (lets us see if path A skipped)
    const h = new Headers(passThrough.headers);
    h.set('x-mw-debug', JSON.stringify(dbg));
    return new Response(passThrough.body, { status: passThrough.status, headers: h });
  }

  // Fetch the static file and Sanity meta in parallel.
  const [pageRes, raw] = await Promise.all([
    ctx.next(),
    card ? fetchCard(card) : fetchPromo(id, slug),
  ]);

  if (!raw) return pageRes;

  const isCard = !!card;
  const modified = rewriteHead(await pageRes.text(), {
    title: raw.title || '文章',
    desc:  descFor(raw, isCard ? 'card' : 'promo'),
    img:   raw.img || OG_IMG,
    url:   url.toString(),
    type:  isCard ? 'product' : 'article',
  });

  return new Response(modified, {
    headers: {
      'Content-Type':  'text/html;charset=UTF-8',
      'Cache-Control': 'public,max-age=300,stale-while-revalidate=3600',
    },
  });
}
