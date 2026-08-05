#!/bin/bash
# ─────────────────────────────────────────────────────────────────
# Munchingo — Enable Two-Step Verification via Graph API
#
# Meta's UI has a bug (blank error). This script does the same
# thing via the API, which works reliably.
#
# HOW TO USE:
#   1. Replace YOUR_6_DIGIT_PIN below with a PIN you choose (e.g. 482917)
#      Keep this PIN safe — you'll need it if you ever re-register the number
#   2. Run: bash enable-2sv.sh
# ─────────────────────────────────────────────────────────────────

PHONE_NUMBER_ID="1245334191995122"
TOKEN="$(grep WHATSAPP_TOKEN .env | cut -d '=' -f2)"

# ⚠️  REPLACE THIS with your chosen 6-digit PIN before running
PIN="REPLACE_WITH_YOUR_PIN"

if [ "$PIN" = "REPLACE_WITH_YOUR_PIN" ]; then
  echo "❌ Please edit this script and set your 6-digit PIN first."
  exit 1
fi

echo "Enabling two-step verification for phone number ID: $PHONE_NUMBER_ID ..."

curl -s -X POST \
  "https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/register" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"messaging_product\": \"whatsapp\", \"pin\": \"${PIN}\"}" | python3 -m json.tool

echo ""
echo "If you see {\"success\": true} above, two-step verification is enabled! ✅"
echo "Now go back to Meta > WhatsApp Manager > Phone Numbers and submit the Official Business Account request."
