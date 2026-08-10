// api/selar/verify.js
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// Initialize Firebase Admin (only once)
if (!getApps().length) {
    initializeApp({
        credential: cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
    });
}

const db = getFirestore();

export default async function handler(req, res) {
    // Only accept POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { orderId } = req.body;

        if (!orderId) {
            return res.status(400).json({ error: 'Order ID required' });
        }

        // 1. Call Selar API to verify the order
        const SELAR_API_KEY = process.env.SELAR_API_KEY;
        
        const response = await fetch(`https://api.selar.co/v1/orders/${orderId}`, {
            headers: {
                'Authorization': `Bearer ${SELAR_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            return res.status(400).json({ error: 'Order not found or invalid' });
        }

        const order = await response.json();

        // 2. Check if payment is successful
        if (order.status !== 'paid' && order.status !== 'successful') {
            return res.status(400).json({ error: 'Payment not completed' });
        }

        // 3. Extract referral code from meta or custom_fields
        const referralCode = order.meta?.ref || order.custom_fields?.ref || null;

        if (!referralCode) {
            return res.status(400).json({ error: 'No referral code found' });
        }

        // 4. Find the volunteer with this referral code
        const volunteersQuery = await db.collection('volunteers')
            .where('referral_code', '==', referralCode)
            .get();

        if (volunteersQuery.empty) {
            return res.status(400).json({ error: 'Invalid referral code' });
        }

        const volunteerDoc = volunteersQuery.docs[0];
        const volunteerId = volunteerDoc.id;

        // 5. Check if this order was already processed
        const orderRef = db.collection('ticket_sales').doc(orderId);
        const orderDoc = await orderRef.get();

        if (orderDoc.exists) {
            return res.status(200).json({ message: 'Order already processed' });
        }

        // 6. Save the sale to Firestore
        await db.runTransaction(async (transaction) => {
            // Save ticket sale
            transaction.set(orderRef, {
                selarOrderId: orderId,
                buyerName: order.customer?.name || 'Anonymous',
                buyerEmail: order.customer?.email || '',
                buyerPhone: order.customer?.phone || '',
                ticket: order.product?.name || 'Summit Ticket',
                amount: order.amount || 0,
                referralCode: referralCode,
                volunteerId: volunteerId,
                paymentStatus: 'paid',
                createdAt: FieldValue.serverTimestamp()
            });

            // Update volunteer stats
            const volunteerRef = db.collection('volunteers').doc(volunteerId);
            transaction.update(volunteerRef, {
                'stats.total_referrals': FieldValue.increment(1),
                'stats.confirmed_referrals': FieldValue.increment(1),
                'stats.total_revenue': FieldValue.increment(order.amount || 0)
            });
        });

        return res.status(200).json({
            success: true,
            message: 'Payment verified and recorded',
            referralCode: referralCode,
            volunteerId: volunteerId
        });

    } catch (error) {
        console.error('Verification error:', error);
        return res.status(500).json({ error: error.message });
    }
}