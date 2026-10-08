// London Drugs - Shopify predictive search, same as B&N in the bot
export async function scrapeLondonDrugs(keywords) {
  const results = []
  for (const kw of keywords) {
    const res = await fetch(`https://www.londondrugs.com/api/search/suggest?q=${encodeURIComponent(kw)}&resources[type]=product`, {
      headers: { "User-Agent": "Mozilla/5.0" }
    })
    const data = await res.json()
    const products = data.resources?.results?.products || []
    for (const p of products) {
      if (!p.title.toLowerCase().includes('pokemon')) continue
      results.push({
        id: `ld-${p.id}`,
        name: p.title,
        price: p.price? p.price / 100 : null,
        url: `https://www.londondrugs.com${p.url}`,
        inStock: p.available,
        retailer: 'London Drugs'
      })
    }
  }
  return results
}
