// Canadian Tire - uses their search API
export async function scrapeCanadianTire(keywords) {
  const results = []
  for (const kw of keywords) {
    const res = await fetch(`https://www.canadiantire.ca/api/search?q=${encodeURIComponent(kw)}`, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
    })
    const data = await res.json().catch(()=>({}))
    const products = data.products || data.results || []
    for (const p of products) {
      if (!p.title?.toLowerCase().includes('pokemon')) continue
      results.push({
        id: `ct-${p.code || p.id}`,
        name: p.title,
        price: p.price?.value || p.salePrice,
        url: p.url? `https://www.canadiantire.ca${p.url}` : `https://www.canadiantire.ca/search?q=${encodeURIComponent(kw)}`,
        inStock: p.stockStatus!== 'outOfStock',
        retailer: 'Canadian Tire'
      })
    }
  }
  return results
}
