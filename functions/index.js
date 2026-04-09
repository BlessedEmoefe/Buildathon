const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { GoogleGenAI, Type } = require('@google/genai');
const PDFDocument = require('pdfkit');

admin.initializeApp();
const db = admin.firestore();

// Initialize Gemini API from Secret Manager or Environment Variable
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const TRUST_SCORE_SYSTEM_PROMPT = `You are the AI engine for "WhatsApp TrustScore Bot", an alternative credit scorer for informal workers in Nigeria.
Your job is to analyze mobile-money transaction footprints (from OPay, PalmPay, Moniepoint, Kuda, etc.) and generate an instant "Trust Score" (0-100).

You will receive input in various forms:
- Forwarded SMS receipts
- Natural language text (e.g., "Today sales: 18400, expenses: 7200")
- OCR text from screenshots
- Transcribed voice notes

Score Factors (0-100):
- Consistency of daily/weekly inflows (Higher is better)
- Profit margin stability (Inflows vs Outflows)
- Spending discipline (Rare negatives/overdrafts, avoiding gambling)
- Transaction volume & frequency
- Positive signals (Airtime top-ups, consistent savings patterns)

Output Requirements:
You MUST return a JSON object with the following exact structure:
{
  "score": number, // 0-100
  "explanation": string, // Short plain-English + Nigerian Pidgin explanation (max 4 lines). Be friendly! E.g., "You dey try well well! Your daily sales are steady, but try reduce your expenses small."
  "riskLevel": string, // "Low", "Medium", or "High"
  "estimatedLoanAmount": string, // e.g., "₦180,000 at 18–22%"
  "savingsTip": string // One personalised micro-savings tip based on their pattern.
}

Few-Shot Examples:
Input: "Today sales: 18400, expenses: 7200, airtime 1200. Yesterday: sales 15000, expenses 5000."
Output: {
  "score": 78,
  "explanation": "Ah, you dey try well well! 🌟 Your daily sales are very steady and your expenses are well managed. Keep up the good work!",
  "riskLevel": "Low",
  "estimatedLoanAmount": "₦50,000 - ₦100,000 at 15-18%",
  "savingsTip": "Try to save ₦1,000 every day from your profit. In 30 days, you'll have ₦30,000! 💰"
}

Input: "Debit: NGN 50,000 to Bet9ja. Balance: NGN 1,200."
Output: {
  "score": 35,
  "explanation": "Bros, this betting no go pay o. 🛑 Your spending discipline needs serious work before you can get a good loan.",
  "riskLevel": "High",
  "estimatedLoanAmount": "₦0 - ₦10,000 at 30%",
  "savingsTip": "Avoid betting sites. Put that ₦50,000 into a locked savings account instead. 🏦"
}

Always be friendly, trustworthy, and empowering. Use emojis heavily!`;

/**
 * Main Webhook Handler for WhatsApp Cloud API
 */
exports.whatsappWebhook = functions.https.onRequest(async (req, res) => {
  if (req.method === 'GET') {
    // Webhook verification for Meta
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  }

  try {
    const body = req.body;
    if (body.object) {
      if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]) {
        const message = body.entry[0].changes[0].value.messages[0];
        const from = message.from; // Sender's phone number
        const msgBody = message.text ? message.text.body : '';
        const msgType = message.type;
        
        // 1. Get or Create Session in Firestore
        const sessionRef = db.collection('sessions').doc(from);
        const sessionDoc = await sessionRef.get();
        let session = sessionDoc.exists ? sessionDoc.data() : { phoneNumber: from, history: [], scores: [], state: 'ONBOARDING' };

        let replyText = '';
        const msgLower = msgBody.toLowerCase();

        // 2. Handle Routing
        if (['hi', 'hello', 'start', 'trust score'].includes(msgLower) && session.state === 'ONBOARDING') {
          replyText = "Welcome to TrustScore Bot! 🚀 I dey here to help you turn your daily transactions into a Trust Score so you can get better, cheaper loans. No more high-interest wahala! 💸\n\nWhat would you like to do?\n1. Get My Trust Score\n2. How it Works\n3. Link Number";
          session.state = 'READY';
        } else if (msgLower === 'how it works') {
          replyText = "It's simple! 💡\n1. Send me your daily sales/expenses, forward SMS receipts, or upload screenshots of your OPay/Moniepoint app.\n2. I will analyze your money habits.\n3. I'll give you a Trust Score (0-100) and tell you how much loan you can get! 📈";
        } else if (msgLower === 'history' || msgLower === 'previous scores' || msgLower === 'my progress') {
          if (session.scores.length === 0) {
            replyText = "You don't have any scores yet! Send me some transactions to get started. 📊";
          } else {
            replyText = "Here is your progress: 📈\n\n" + session.scores.slice(-5).map((s, i) => {
              const trend = i === 0 ? '🆕' : (s.score >= session.scores[i-1].score ? '⬆️' : '⬇️');
              return \`Date: \${new Date(s.date).toLocaleDateString()} | Score: \${s.score} \${trend}\`;
            }).join('\n');
          }
        } else if (msgLower === 'get savings plan') {
           const response = await ai.models.generateContent({
              model: "gemini-3-flash-preview",
              contents: "Generate a 30-day personalised micro-savings rules based on a typical informal worker in Nigeria.",
              config: { systemInstruction: "You are a helpful financial advisor for Nigerian informal workers. Keep it friendly, use emojis and Pidgin." }
           });
           replyText = response.text || "Here is a simple plan: Save 10% of your daily profit! 💰";
        } else if (msgLower === 'help') {
          replyText = "Here are the commands you can use:\n- Start\n- Get My Trust Score\n- History\n- Get savings plan\n- Reset";
        } else if (msgLower === 'reset') {
          session = { phoneNumber: from, history: [], scores: [], state: 'ONBOARDING' };
          replyText = "Session cleared! Send 'Hi' to start again. 🔄";
        } else {
          // 3. Handle Transaction Analysis (Text, Image, Audio)
          replyText = "Analyzing your transactions... ⏳";
          
          let contents = [];
          if (msgType === 'text') {
            contents = [msgBody];
          } else if (msgType === 'image' || msgType === 'audio') {
            // In a real app, you would download the media from WhatsApp using the media ID
            // const mediaUrl = await getWhatsAppMediaUrl(message[msgType].id);
            // const mediaData = await downloadMedia(mediaUrl);
            // contents = [{ inlineData: { data: mediaData.toString('base64'), mimeType: message[msgType].mime_type } }, "Analyze this transaction data."];
            replyText = "Media analysis is simulated in this prototype.";
          }

          if (contents.length > 0) {
            const response = await ai.models.generateContent({
              model: "gemini-3-flash-preview",
              contents: contents,
              config: {
                systemInstruction: TRUST_SCORE_SYSTEM_PROMPT,
                responseMimeType: "application/json",
                responseSchema: {
                  type: Type.OBJECT,
                  properties: {
                    score: { type: Type.NUMBER },
                    explanation: { type: Type.STRING },
                    riskLevel: { type: Type.STRING },
                    estimatedLoanAmount: { type: Type.STRING },
                    savingsTip: { type: Type.STRING }
                  },
                  required: ["score", "explanation", "riskLevel", "estimatedLoanAmount", "savingsTip"]
                }
              }
            });

            const resultText = response.text;
            if (resultText) {
              try {
                const result = JSON.parse(resultText);
                session.scores.push({
                  score: result.score,
                  date: new Date().toISOString(),
                  details: result
                });

                replyText = \`*Your Trust Score: \${result.score}/100* 🎯\n\n\` +
                            \`*Risk Level:* \${result.riskLevel}\n\` +
                            \`*Estimated Loan:* \${result.estimatedLoanAmount}\n\n\` +
                            \`📝 *Analysis:* \${result.explanation}\n\n\` +
                            \`💡 *Tip:* \${result.savingsTip}\n\n\` +
                            \`Reply 'Share' to get a PDF report.\`;
              } catch (e) {
                console.error("Failed to parse Gemini response", e);
                replyText = "Sorry, I couldn't understand those transactions. Please try sending them again clearly! 🙏";
              }
            }
          }
        }

        // 4. Save Session
        await sessionRef.set(session);

        // 5. Send Reply via WhatsApp API
        // await sendWhatsAppMessage(from, replyText);
        console.log(\`Reply to \${from}: \${replyText}\`);
      }
      res.sendStatus(200);
    } else {
      res.sendStatus(404);
    }
  } catch (error) {
    console.error('Webhook Error:', error);
    res.sendStatus(500);
  }
});

/**
 * PDF Generator Endpoint
 */
exports.generatePdfReport = functions.https.onRequest(async (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.status(400).send('Missing phone number');

  const sessionDoc = await db.collection('sessions').doc(phone).get();
  if (!sessionDoc.exists) return res.status(404).send('No scores found');
  
  const session = sessionDoc.data();
  if (!session.scores || session.scores.length === 0) return res.status(404).send('No scores found');

  const latestScore = session.scores[session.scores.length - 1].details;

  const doc = new PDFDocument();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', \`attachment; filename=TrustScore_\${phone}.pdf\`);
  
  doc.pipe(res);
  
  doc.fontSize(25).text('TrustScore Report', { align: 'center' });
  doc.moveDown();
  doc.fontSize(16).text(\`Phone Number: \${phone}\`);
  doc.text(\`Date: \${new Date().toLocaleDateString()}\`);
  doc.moveDown();
  
  doc.fontSize(20).text(\`Trust Score: \${latestScore.score} / 100\`, { align: 'center' });
  doc.moveDown();
  
  doc.fontSize(14).text(\`Risk Level: \${latestScore.riskLevel}\`);
  doc.text(\`Estimated Comfortable Loan: \${latestScore.estimatedLoanAmount}\`);
  doc.moveDown();
  
  doc.fontSize(12).text('Analysis:', { underline: true });
  doc.text(latestScore.explanation);
  doc.moveDown();
  
  doc.text('Savings Tip:', { underline: true });
  doc.text(latestScore.savingsTip);
  
  doc.end();
});
