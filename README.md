# Under 45 CEOs - Selar Payment Integration

## 🔑 API Keys & Secrets
These keys are stored in Vercel Environment Variables. Do NOT expose them in frontend code.

| Key | Where it lives | Purpose |
|-----|----------------|---------|
| `SELAR_API_KEY` | Vercel Env Vars | Used to verify Selar payments |
| `FIREBASE_PRIVATE_KEY` | Vercel Env Vars | Allows Vercel to write to Firestore |

## 📞 Who to contact if something breaks

**Technical Lead / System Admin**
- Name: Immanuel
- Phone: 09021773508
- Email: vintechdigitalservices@gmail.com

**If the referral system stops updating:**
1. Check Vercel Logs (`https://vercel.com/under45ceos-submit/logs`)
2. Verify that the Selar API key is still valid and active.
3. Contact the Technical Lead above.

## 🔄 Auto-Refresh Schedule
- The system checks Selar for new paid orders every **5 minutes**.
- If a payment isn't showing up after 30 minutes, contact support.