#!/usr/bin/env node
/**
 * generate-sitemap.js
 * Fetches all active promotions and credit cards from Sanity and writes
 * sitemap.xml. Run before every deploy:
 *
 *   node generate-sitemap.js
 *
 * Requires Node 18+ (uses native fetch).
 */

const fs   = require('fs');
const path = require('path');

const SANITY_PROJECT = 'j3rszqec';
const SANITY_DATASET = 'promotions';
const SANITY_API     = `https://${SANITY_PROJECT}.api.sanity.io/v2024-01-01/data/query/${SANITY_DATASET}`;
const BASE_URL       = 'https://hkmiles.app';
const OUT_FILE       = path.join(__dirname, 'sitemap.xml');

async function query(groq) {
  const url = `${SANITY_API}?query=${encodeURIComponent(groq)}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`Sanity query failed: ${res.status}`);
  const data = await res.json();
  return data.result || [];
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function urlEntry({ loc, lastmod, changefreq = 'weekly', priority = '0.7' }) {
  return [
    '  <url>',
    `    <loc>${loc}</loc>`,
    `    <lastmod>${lastmod}</lastmod>`,
    `    <changefreq>${changefreq}</changefreq>`,
    `    <priority>${priority}</priority>`,
    '  </url>',
  ].join('\n');
}

async function main() {
  console.log('Fetching promotions…');
  const promotions = await query(
    `*[_type == "promotion" && !(_id in path("drafts.**")) && status == "Active"]
     | order(_createdAt desc)
     { _id, "slug": slug.current, _updatedAt }`
  );

  console.log('Fetching credit cards…');
  const cards = await query(
    `*[_type == "creditCard" && !(_id in path("drafts.**")) && status == "Active"]
     | order(bank asc, title asc)
     { "slug": slug.current, _updatedAt }`
  );

  console.log(`  promotions: ${promotions.length}, cards: ${cards.length}`);

  // Use pretty URLs (Cloudflare Pages strips .html automatically)
  const staticPages = [
    urlEntry({ loc: `${BASE_URL}/`,            lastmod: today(), changefreq: 'daily',   priority: '1.0' }),
    urlEntry({ loc: `${BASE_URL}/promotions`,  lastmod: today(), changefreq: 'daily',   priority: '0.9' }),
    urlEntry({ loc: `${BASE_URL}/updates`,     lastmod: today(), changefreq: 'weekly',  priority: '0.6' }),
  ];

  const promoEntries = promotions.map(p => {
    const loc      = p.slug
      ? `${BASE_URL}/${p.slug}`
      : `${BASE_URL}/article?id=${encodeURIComponent(p._id)}`;
    const lastmod  = p._updatedAt ? p._updatedAt.slice(0, 10) : today();
    return urlEntry({ loc, lastmod, changefreq: 'weekly', priority: '0.7' });
  });

  const cardEntries = cards
    .filter(c => c.slug)
    .map(c => {
      const loc     = `${BASE_URL}/${c.slug}`;
      const lastmod = c._updatedAt ? c._updatedAt.slice(0, 10) : today();
      return urlEntry({ loc, lastmod, changefreq: 'monthly', priority: '0.8' });
    });

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...staticPages,
    ...cardEntries,
    ...promoEntries,
    '</urlset>',
  ].join('\n');

  fs.writeFileSync(OUT_FILE, xml, 'utf8');
  console.log(`✓ sitemap.xml written — ${staticPages.length + cardEntries.length + promoEntries.length} URLs`);
}

main().catch(err => { console.error(err); process.exit(1); });
