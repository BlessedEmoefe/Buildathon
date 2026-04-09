import express from 'express';
import cors from 'cors';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { GoogleGenAI, Type } from '@google/genai';
import multer from 'multer';
import PDFDocument from 'pdfkit';

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// Initialize Gemini API
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

// In-memory session store for the prototype
// In a real app, this would be Firestore
const sessions: Record<string, any> = {};

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

// --- API ROUTES ---

// 1. Webhook for WhatsApp (Simulated)
app.post('/api/webhook', async (req, res) => {
  try {
    const { from, message, type = 'text', mediaData, mimeType } = req.body;
    
    if (!from) {
      res.status(400).json({ error: 'Missing sender number' });
      return;
    }

    // Initialize session if not exists
    if (!sessions[from]) {
      sessions[from] = {
        phoneNumber: from,
        history: [],
        scores: [],
        state: 'ONBOARDING'
      };
    }
    
    const session = sessions[from];
    let replyText = '';
    let quickReplies: string[] = [];

    const msgLower = message?.toLowerCase() || '';

    // Handle Greetings / Onboarding
    if (['hi', 'hello', 'start', 'trust score'].includes(msgLower) && session.state === 'ONBOARDING') {
      replyText = "Welcome to TrustScore Bot! 🚀 I dey here to help you turn your daily transactions into a Trust Score so you can get better, cheaper loans. No more high-interest wahala! 💸\n\nWhat would you like to do?";
      quickReplies = ["Get My Trust Score", "How it Works", "Link Number"];
      session.state = 'READY';
    } 
    else if (msgLower === 'how it works') {
      replyText = "It's simple! 💡\n1. Send me your daily sales/expenses, forward SMS receipts, or upload screenshots of your OPay/Moniepoint app.\n2. I will analyze your money habits.\n3. I'll give you a Trust Score (0-100) and tell you how much loan you can get! 📈";
      quickReplies = ["Get My Trust Score"];
    }
    else if (msgLower === 'history' || msgLower === 'previous scores' || msgLower === 'my progress') {
      if (session.scores.length === 0) {
        replyText = "You don't have any scores yet! Send me some transactions to get started. 📊";
      } else {
        replyText = "Here is your progress: 📈\n\n" + session.scores.slice(-5).map((s: any, i: number) => {
          const trend = i === 0 ? '🆕' : (s.score >= session.scores[i-1].score ? '⬆️' : '⬇️');
          return `Date: ${new Date(s.date).toLocaleDateString()} | Score: ${s.score} ${trend}`;
        }).join('\n');
      }
    }
    else if (msgLower === 'get savings plan') {
       const response = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: "Generate a 30-day personalised micro-savings rules based on a typical informal worker in Nigeria.",
          config: {
            systemInstruction: "You are a helpful financial advisor for Nigerian informal workers. Keep it friendly, use emojis and Pidgin.",
          }
       });
       replyText = response.text || "Here is a simple plan: Save 10% of your daily profit! 💰";
    }
    else if (msgLower === 'help') {
      replyText = "Here are the commands you can use:\n- Start\n- Get My Trust Score\n- History\n- Get savings plan\n- Reset";
    }
    else if (msgLower === 'reset') {
      sessions[from] = { phoneNumber: from, history: [], scores: [], state: 'ONBOARDING' };
      replyText = "Session cleared! Send 'Hi' to start again. 🔄";
    }
    // Handle Transaction Input (Text, Image, Audio)
    else {
      replyText = "Analyzing your transactions... ⏳";
      
      let contents: any[] = [];
      
      if (type === 'text') {
        contents = [message];
      } else if (type === 'image' || type === 'audio') {
        contents = [
          {
            inlineData: {
              data: mediaData,
              mimeType: mimeType
            }
          },
          "Analyze this transaction data."
        ];
      }

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
          
          // Save score to history
          session.scores.push({
            score: result.score,
            date: new Date().toISOString(),
            details: result
          });

          replyText = `*Your Trust Score: ${result.score}/100* 🎯\n\n` +
                      `*Risk Level:* ${result.riskLevel}\n` +
                      `*Estimated Loan:* ${result.estimatedLoanAmount}\n\n` +
                      `📝 *Analysis:* ${result.explanation}\n\n` +
                      `💡 *Tip:* ${result.savingsTip}`;
                      
          quickReplies = ["Share Score with Lender", "Copy Shareable Link"];
        } catch (e) {
          console.error("Failed to parse Gemini response", e);
          replyText = "Sorry, I couldn't understand those transactions. Please try sending them again clearly! 🙏";
        }
      }
    }

    res.json({
      reply: replyText,
      quickReplies
    });

  } catch (error) {
    console.error('Webhook Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 2. Generate PDF Endpoint
app.get('/api/pdf/:phone', (req, res) => {
  const phone = req.params.phone;
  const session = sessions[phone];
  
  if (!session || session.scores.length === 0) {
    res.status(404).send('No scores found for this number.');
    return;
  }

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

// 3. Get Session Data (for dashboard)
app.get('/api/session/:phone', (req, res) => {
  res.json(sessions[req.params.phone] || null);
});


// --- VITE MIDDLEWARE ---
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(\`Server running on http://localhost:\${PORT}\`);
  });
}

startServer();
