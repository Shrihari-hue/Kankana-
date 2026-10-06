# Kankana website: going live

This folder is the complete website. The pages you already had (`index.html`, `studio.html` and the rest) are served by a small Node.js server in `server/`. That server runs the booking calendar, Razorpay payments, emails, PDFs and the studio admin.

It has **no dependencies**, so there is no `npm install` step. It only needs **Node.js 22.13 or newer**. The data lives in one SQLite file at `server/data/kankana.db`.

---

## 1. Try it on your Mac first (5 minutes)

```bash
cd ~/Kankana
cp server/.env.example server/.env        # then open server/.env and fill it in
npm run dev                                # test mode: payments are simulated
```

Open http://localhost:3000. Sign in to the admin at http://localhost:3000/admin with the `ADMIN_EMAIL` and `ADMIN_PASSWORD` from your `.env`.

To try the **real Razorpay checkout** in test mode, add your `rzp_test_…` keys to `.env` and run `npm start` instead of `npm run dev`.

---

## 2. What you need before launch

| What | Where to get it | Goes in `server/.env` |
|---|---|---|
| Razorpay account (KYC approved for live payments) | dashboard.razorpay.com → Account & Settings → API Keys | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` |
| Razorpay webhook | Dashboard → Webhooks → **Add**: URL `https://YOUR-DOMAIN/api/razorpay/webhook`, events `payment.captured` and `order.paid`, and a secret you choose | `RAZORPAY_WEBHOOK_SECRET` |
| A mailbox to send from | Zoho Mail / Google Workspace / Hostinger (use an *app password*), or resend.com | `SMTP_*` + `MAIL_FROM`, or `RESEND_API_KEY` |
| Your domain | wherever you bought it | `SITE_URL=https://www.yourdomain.in` |
| GSTIN, legal name, address | — | enter in **Admin → Settings** (these print on invoices) |

The webhook matters. If a customer pays and closes the tab before the confirmation screen loads, Razorpay still tells the server through the webhook, and the booking is confirmed anyway.

---

## 3. Put it online (choose one)

The server needs a **persistent disk** for the database, so pick a host that provides one.

### Option A: Render.com (easiest)
1. Push this folder to a **private** GitHub repo. `.gitignore` already keeps out `.env` and the database.
2. On Render: **New → Web Service** → pick the repo.
   - Runtime: Node
   - Build command: leave empty (or `echo ok`)
   - Start command: `npm start`
   - Instance: a paid instance type. The free tier has no persistent disk, so bookings would be lost.
3. **Disks → Add disk**: mount path `/var/data`, 1 GB.
4. **Environment**: paste everything from your `.env`, with `DATA_DIR=/var/data`.
5. **Settings → Custom domain**: add your domain and follow the DNS instructions. HTTPS is set up automatically.

### Option B: Railway.app
Same steps: deploy from GitHub, add a **Volume** mounted at `/data`, set `DATA_DIR=/data` and the other variables, then attach your domain.

### Option C: Your own VPS (Hostinger, DigitalOcean, AWS Lightsail…)
```bash
# on the server (Ubuntu)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
git clone <your repo> kankana && cd kankana && cp server/.env.example server/.env && nano server/.env
sudo npm i -g pm2 && pm2 start server/server.js --name kankana && pm2 save && pm2 startup
# HTTPS + domain: install Caddy and use this Caddyfile:
#   yourdomain.in { reverse_proxy localhost:3000 }
```

---

## 4. Launch checklist
- [ ] **Admin → Settings → System status** shows Payments, Webhook, Email and Site URL all green
- [ ] Settings: GSTIN, legal name, address, terms filled in
- [ ] **Venues & Pricing**: the real venues and prices are entered (the current ones are samples)
- [ ] Made one real test booking with `rzp_test_` keys and received the quotation, receipt and invoice emails
- [ ] Switched to `rzp_live_` keys and restarted
- [ ] Changed the admin password (Settings → Your account)
- [ ] Downloaded a backup (Settings → Download full backup). Do this regularly, or back up the disk.

## How it works (for a developer)
- `server/server.js` handles the HTTP routes, static files, admin sessions (scrypt passwords, HttpOnly cookies), rate limits, CSP and security headers.
- `server/lib/service.js` holds the booking rules. Double-booking is prevented inside a database transaction, and the quote is always recomputed on the server.
- `server/lib/razorpay.js` creates orders server-side and verifies the HMAC signature of every payment and webhook.
- `server/lib/pdf.js` generates the quotation, GST tax invoice (CGST+SGST or IGST) and receipt PDFs.
- `server/lib/mailer.js` sends email over SMTP (SSL or STARTTLS) or the Resend API, with PDF attachments.
- `assets/kankana-pricing.js` is the pricing code shared by the browser and the server.
