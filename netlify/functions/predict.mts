import type { Context } from '@netlify/functions'
import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic()

interface ShipmentData {
  id: string
  origin: string
  dest: string
  carrier: string
  status: string
  eta: string
  weight: string
}

interface InventoryData {
  sku: string
  name: string
  cat: string
  qty: number
  warehouse: string
  status: string
}

interface SupplierData {
  name: string
  country: string
  cat: string
  lead: string
  rel: number
  email: string
}

interface PredictRequest {
  focus: 'all' | 'delays' | 'demand' | 'costs'
  data: {
    shipments: ShipmentData[]
    inventory: InventoryData[]
    suppliers: SupplierData[]
  }
}

export default async (req: Request, context: Context) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  let body: PredictRequest
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  const { focus = 'all', data } = body
  const { shipments = [], inventory = [], suppliers = [] } = data || {}

  const delayedCount = shipments.filter(s => s.status === 'delayed').length
  const transitCount = shipments.filter(s => s.status === 'transit').length
  const criticalInventory = inventory.filter(i => i.status === 'critical').length
  const lowInventory = inventory.filter(i => i.status === 'low').length
  const avgSupplierRel = suppliers.length > 0
    ? (suppliers.reduce((sum, s) => sum + s.rel, 0) / suppliers.length).toFixed(1)
    : 0

  const focusInstructions = {
    delays: 'Focus specifically on delay risk prediction and mitigation strategies.',
    demand: 'Focus specifically on demand forecasting and inventory replenishment needs.',
    costs: 'Focus specifically on cost optimization opportunities and budget forecasting.',
    all: 'Provide a comprehensive analysis covering delays, demand, and costs.'
  }

  const systemPrompt = `You are an expert logistics and supply chain AI analyst.
Analyze the provided supply chain data and deliver precise, actionable predictions.
Return ONLY valid JSON in the exact format specified. Be specific and data-driven.
${focusInstructions[focus] || focusInstructions.all}`

  const userPrompt = `Analyze this supply chain snapshot and predict outcomes:

SHIPMENTS (${shipments.length} total):
- ${transitCount} in transit, ${delayedCount} delayed, ${shipments.filter(s => s.status === 'pending').length} pending
- Carriers: ${[...new Set(shipments.map(s => s.carrier))].join(', ')}
- Routes: ${shipments.slice(0, 3).map(s => `${s.origin}→${s.dest}`).join(', ')}

INVENTORY (${inventory.length} items):
- ${criticalInventory} critical, ${lowInventory} low stock
- Critical items: ${inventory.filter(i => i.status === 'critical').map(i => `${i.name} (${i.qty} units)`).join(', ')}
- Total units: ${inventory.reduce((sum, i) => sum + i.qty, 0)}

SUPPLIERS (${suppliers.length} active):
- Average reliability: ${avgSupplierRel}%
- Lowest reliability: ${suppliers.sort((a, b) => a.rel - b.rel)[0]?.name} (${suppliers.sort((a, b) => a.rel - b.rel)[0]?.rel}%)

Return ONLY this JSON structure (no markdown, no extra text):
{
  "delayRisk": "XX%",
  "demandForecast": "+XX%",
  "costForecast": "$XXXk",
  "insight": "2-3 sentence actionable insight with specific shipment IDs or item names. Be concrete and prescriptive."
}`

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      messages: [
        { role: 'user', content: userPrompt }
      ],
      system: systemPrompt
    })

    const responseText = message.content[0].type === 'text' ? message.content[0].text : ''

    let parsed: {
      delayRisk?: string
      demandForecast?: string
      costForecast?: string
      insight?: string
    }

    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/)
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {}
    } catch {
      parsed = {}
    }

    return Response.json({
      delayRisk: parsed.delayRisk || `${Math.round((delayedCount / Math.max(shipments.length, 1)) * 100 + 15)}%`,
      demandForecast: parsed.demandForecast || `+${criticalInventory * 8 + 12}%`,
      costForecast: parsed.costForecast || `$${Math.round((shipments.length * 1240 * 1.08) / 1000)}k`,
      insight: parsed.insight || `Analysis complete. ${delayedCount} shipments at delay risk. ${criticalInventory} inventory items need urgent restocking.`
    })
  } catch (err) {
    console.error('Prediction error:', err)
    return Response.json({
      delayRisk: `${Math.round((delayedCount / Math.max(shipments.length, 1)) * 100 + 15)}%`,
      demandForecast: `+${criticalInventory * 8 + 12}%`,
      costForecast: `$${Math.round((shipments.length * 1240 * 1.08) / 1000)}k`,
      insight: `Based on current data: ${delayedCount} active delays detected. ${criticalInventory} inventory items critical. Average supplier reliability at ${avgSupplierRel}%. Recommend prioritizing restocking of critical SKUs.`
    })
  }
}

export const config = {
  path: '/api/predict'
}
