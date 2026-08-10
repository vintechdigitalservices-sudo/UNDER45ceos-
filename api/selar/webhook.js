import admin from 'firebase-admin';

// 1. Initialize Firebase Admin (uses existing Vercel environment variables)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Fixes formatting for multi-line private key strings in Vercel
      privateKey: process.env.FIREBASE_PRIVATE_KEY
        ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
        : undefined,
    }),
  });
}

const db = admin.firestore();

export default async function handler(req, res) {
  // Only accept POST requests from Zapier / Webhooks
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const payload = req.body;

    // 2. Safely extract Order Reference ID & Purchase Details
    const orderId = payload.reference || payload.order_id || payload.id;
    const amountPaid = Number(payload.amount || payload.total_paid || 0);
    const buyerName = payload.customer?.fullname || payload.customer?.name || 'Anonymous';
    const buyerEmail = payload.customer?.email || 'N/A';
    const buyerPhone = payload.customer?.phone || 'N/A';

    if (!orderId) {
      return res.status(400).json({ error: 'Invalid payload: Order ID missing' });
    }

    // 3. Extract Referral Code from Custom Fields or Form Inputs
    let referralCode = 'DIRECT';
    const customFields = payload.custom_fields || payload.checkout_fields || [];

    if (Array.isArray(customFields)) {
      // Looks for a field titled "Referral Code", "Volunteer Code", or similar
      const refField = customFields.find((field) => {
        const title = (field.title || field.name || '').toLowerCase();
        return title.includes('referral') || title.includes('volunteer') || title.includes('code');
      });

      if (refField && refField.value) {
        referralCode = String(refField.value).trim().toUpperCase();
      }
    } else if (typeof customFields === 'object' && customFields !== null) {
      // Handles cases where custom fields come through as key-value pairs
      const keys = Object.keys(customFields);
      const refKey = keys.find((k) => k.toLowerCase().includes('referral') || k.toLowerCase().includes('code'));
      if (refKey && customFields[refKey]) {
        referralCode = String(customFields[refKey]).trim().toUpperCase();
      }
    }

    // Fallback: Check standard affiliate parameters if present
    if (referralCode === 'DIRECT' && payload.affiliate?.code) {
      referralCode = String(payload.affiliate.code).trim().toUpperCase();
    }

    // 4. Save Sale Document to `ticket_sales` Collection
    const saleRef = db.collection('ticket_sales').doc(String(orderId));
    const saleDoc = await saleRef.get();

    // Prevent duplicate processing if Zapier sends the same webhook twice
    if (saleDoc.exists && saleDoc.data()?.processed) {
      return res.status(200).json({ status: 'already_processed', orderId });
    }

    await saleRef.set({
      orderId: String(orderId),
      buyerName,
      buyerEmail,
      buyerPhone,
      amountPaid,
      referralCode,
      source: 'selar_webhook',
      processed: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    // 5. Update Volunteer Stats in `volunteers` Collection
    if (referralCode !== 'DIRECT') {
      const volQuery = await db
        .collection('volunteers')
        .where('referralCode', '==', referralCode)
        .limit(1)
        .get();

      if (!volQuery.empty) {
        const volDoc = volQuery.docs[0];
        await volDoc.ref.update({
          totalSales: admin.firestore.FieldValue.increment(1),
          totalRevenue: admin.firestore.FieldValue.increment(amountPaid),
          lastSaleAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }

    return res.status(200).json({
      success: true,
      orderId,
      referralCode,
      message: 'Sale logged and volunteer updated successfully',
    });

  } catch (error) {
    console.error('Webhook Processing Error:', error);
    return res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
}