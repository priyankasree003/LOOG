import type { Context } from '@netlify/functions'
import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic()

interface SearchContext {
  shipments?: Array<{ id: string; origin: string; dest: string; carrier: string; status: string; eta: string }>
  inventory?: Array<{ sku: string; name: string; cat: string; qty: number; warehouse: string; status: string }>
  suppliers?: Array<{ name: string; country: string; cat: string; rel: number }>
}

interface SearchRequest {
  query: string
  context: SearchContext
}

export default async (req: Request, context: Context) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  let body: SearchRequest
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  const { query, context: dataContext = {} } = body
  const { shipments = [], inventory = [], suppliers = [] } = dataContext

  if (!query || query.trim().length < 2) {
    return Response.json({ results: [] })
  }

  const systemPrompt = `You are an intelligent search assistant for a logistics and supply chain management system.
Your job is to understand natural language queries and find relevant information from supply chain data.
Return ONLY valid JSON with no markdown or extra text.
Understand intent — "delayed packages" should match status:delayed shipments, "low stock" should match critical/low inventory items.`

  const dataSnapshot = `
SHIPMENTS (${shipments.length}):
${shipments.map(s => `  - ${s.id}: ${s.origin}→${s.dest}, ${s.carrier}, status:${s.status}, ETA:${s.eta}`).join('\n')}

INVENTORY (${inventory.length}):
${inventory.map(i => `  - ${i.sku}: ${i.name}, qty:${i.qty}, ${i.warehouse}, status:${i.status}`).join('\n')}

SUPPLIERS (${suppliers.length}):
${suppliers.map(s => `  - ${s.name}: ${s.country}, ${s.cat}, reliability:${s.rel}%`).join('\n')}`

  const userPrompt = `Query: "${query}"

Available data:
${dataSnapshot}

Find up to 5 most relevant results. Return JSON:
{
  "results": [
    {
      "type": "shipment|inventory|supplier",
      "category": "Shipment|Inventory|Supplier",
      "text": "descriptive match text",
      "relevance": 0.0-1.0
    }
  ]
}

Only include truly relevant matches. Consider synonyms and intent (e.g. "late" = delayed, "out of stock" = critical).`

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 400,
      messages: [{ role: 'user', content: userPrompt }],
      system: systemPrompt
    })

    const responseText = message.content[0].type === 'text' ? message.content[0].text : ''

    let parsed: { results?: Array<{ type: string; category: string; text: string; relevance: number }> }
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/)
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { results: [] }
    } catch {
      parsed = { results: [] }
    }

    return Response.json({
      results: (parsed.results || [])
        .filter(r => r.relevance > 0.3)
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, 5)
    })
  } catch (err) {
    console.error('Smart search error:', err)
    return Response.json({ results: [] })
  }
}

export const config = {
  path: '/api/smart-search'
}
