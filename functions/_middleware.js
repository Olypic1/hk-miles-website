/**
 * functions/_middleware.js  —  Cloudflare Pages edge middleware
 *
 * Injects SEO meta for legacy article URLs:
 *   /article?slug=…  /article?id=…  /article?card=…
 *
 * Pretty article URLs (e.g. /asia-miles-2026-5) are handled by the catchall
 * Function in functions/[[slug]].js, not here. This middleware exists only
 * to preserve back-compat for inbound /article?… links so social/AI bots
 * that don't run JS still see correct OG tags, Twitter card, canonical
 * URL, and JSON-LD.
 */

const SANITY = 'https://j3rszqec.api.sanity.io/v2024-01-01/data/query/promotions';
const BASE   = 'https://hkmiles.app';
const OG_IMG = `${BASE}/og-image.png`;

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

function fetchCard(slug) {
  return sq(`*[_type=="creditCard"&&slug.current=="${slug}"][0]{
    title, bank, summary, "content2":content[0..1],
    "img":coalesce(imageUrl,mainImage.asset->url,cardImage.asset->url),
    _createdAt, publishedAt, _updatedAt
  }`);
}

function fetchPromo(id, slug) {
  const f = id ? `_id=="${id}"` : `slug.current=="${slug}"`;
  return sq(`*[_type=="promotion"&&${f}][0]{
    title, bank, categories,
    "img":mainImage.asset->url,
    "content2":content[0..1],
    _createdAt, publishedAt, _updatedAt
  }`);
}

function rewriteHead(html, { title, desc, img, url, type, datePublished, dateModified }) {
  const T = esc(`${title} | HK Miles`);
  const D = esc(desc);
  const I = esc(img);
  const U = esc(url);

  const articleLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: title, description: desc, image: img, url,
    inLanguage: 'zh-HK',
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
    .replace('</head>', `<script type="application/ld+json">${ld}</script>\n</head>`);
}

function descFor(raw, type) {
  if (type === 'card') {
    return ptText(raw.summary) || ptText(raw.content2)
      || `${raw.title} 信用卡詳情、年費、回贈率及申請資格。更多香港信用卡攻略盡在 HK Miles。`;
  }
  return ptText(raw.content2)
    || `${raw.title} 優惠詳情、到期日及申請方法。更多香港信用卡優惠盡在 HK Miles。`;
}

export async function onRequest(ctx) {
  const url  = new URL(ctx.request.url);
  const p    = url.searchParams;
  const card = p.get('card');
  const id   = p.get('id');
  const slug = p.get('slug');

  // Only intercept the canonical /article path with article-meta query params.
  // /article.html gets 308-redirected by Cloudflare's pretty-URL feature
  // before reaching here, so we don't need to handle that case.
  const isArticlePath = url.pathname === '/article';
  if (!isArticlePath || (!card && !id && !slug))
    return ctx.next();

  const [pageRes, raw] = await Promise.all([
    ctx.next(),
    card ? fetchCard(card) : fetchPromo(id, slug),
  ]);

  if (!raw) return pageRes;

  const isCard = !!card;
  const modified = rewriteHead(await pageRes.text(), {
    title:         raw.title || '文章',
    desc:          descFor(raw, isCard ? 'card' : 'promo'),
    img:           raw.img || OG_IMG,
    url:           url.toString(),
    type:          isCard ? 'product' : 'article',
    datePublished: raw.publishedAt || raw._createdAt || null,
    dateModified:  raw._updatedAt || null,
  });

  return new Response(modified, {
    headers: {
      'Content-Type':  'text/html;charset=UTF-8',
      'Cache-Control': 'public,max-age=300,stale-while-revalidate=3600',
    },
  });
}
