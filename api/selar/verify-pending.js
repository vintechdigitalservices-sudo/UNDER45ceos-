// api/selar/verify-pending.js
export default async function handler(req, res) {
    // Only accept GET requests (for cron jobs)
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const SELAR_API_KEY = process.env.SELAR_API_KEY;
        if (!SELAR_API_KEY) {
            return res.status(500).json({ error: 'SELAR_API_KEY not configured' });
        }

        // Fetch recent paid orders from Selar (last 50)
        const response = await fetch('https://api.selar.co/v1/orders?status=paid&limit=50', {
            headers: {
                'Authorization': `Bearer ${SELAR_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            return res.status(response.status).json({ 
                error: `Selar API error: ${response.statusText}` 
            });
        }

        const data = await response.json();
        const orders = data.data || [];
        
        let processed = 0;
        let failed = 0;

        // For each paid order, call the verify endpoint
        for (const order of orders) {
            try {
                // Get the base URL dynamically
                const baseUrl = req.headers.host ? 
                    `https://${req.headers.host}` : 
                    'https://under45ceos.udufafrica.org';

                const verifyResponse = await fetch(`${baseUrl}/api/selar/verify`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ orderId: order.id })
                });

                if (verifyResponse.ok) {
                    processed++;
                } else {
                    failed++;
                }
            } catch (err) {
                console.error('Error processing order:', order.id, err.message);
                failed++;
            }
        }

        return res.status(200).json({ 
            success: true,
            processed, 
            failed,
            totalOrders: orders.length,
            message: `Processed ${processed} orders, ${failed} failed`
        });

    } catch (error) {
        console.error('Cron error:', error);
        return res.status(500).json({ error: error.message });
    }
}