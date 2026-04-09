import React, { useState, useRef, useEffect } from 'react';
import { Send, FileText, Link as LinkIcon, RefreshCw, Upload, Mic, Image as ImageIcon } from 'lucide-react';

export default function App() {
  const [messages, setMessages] = useState<{text: string, sender: 'user' | 'bot', quickReplies?: string[]}[]>([
    { text: "Welcome to the TrustScore Admin Dashboard & Simulator! Type 'Hi' to start.", sender: 'bot' }
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [phoneNumber] = useState('2348012345678');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const sendMessage = async (text: string, type: string = 'text', mediaData?: string, mimeType?: string) => {
    if (!text && !mediaData) return;

    setMessages(prev => [...prev, { text: type === 'text' ? text : `[${type.toUpperCase()} UPLOADED]`, sender: 'user' }]);
    setInput('');
    setLoading(true);

    try {
      const response = await fetch('/api/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: phoneNumber,
          message: text,
          type,
          mediaData,
          mimeType
        })
      });

      const data = await response.json();
      
      if (data.reply) {
        setMessages(prev => [...prev, { 
          text: data.reply, 
          sender: 'bot',
          quickReplies: data.quickReplies 
        }]);
      }
    } catch (error) {
      console.error("Error sending message:", error);
      setMessages(prev => [...prev, { text: "Error connecting to server.", sender: 'bot' }]);
    } finally {
      setLoading(false);
    }
  };

  const handleQuickReply = (reply: string) => {
    if (reply === 'Share Score with Lender') {
      window.open(`/api/pdf/${phoneNumber}`, '_blank');
    } else if (reply === 'Copy Shareable Link') {
      navigator.clipboard.writeText(`${window.location.origin}/api/pdf/${phoneNumber}`);
      alert('Link copied to clipboard!');
    } else {
      sendMessage(reply);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>, type: 'image' | 'audio') => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64String = (reader.result as string).split(',')[1];
        sendMessage('', type, base64String, file.type);
      };
      reader.readAsDataURL(file);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col md:flex-row font-sans">
      
      {/* Admin Sidebar */}
      <div className="w-full md:w-1/3 bg-white border-r border-gray-200 p-6 flex flex-col">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 bg-green-600 rounded-xl flex items-center justify-center text-white font-bold text-xl">
            TS
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900">TrustScore Bot</h1>
            <p className="text-sm text-gray-500">Admin Dashboard</p>
          </div>
        </div>

        <div className="bg-green-50 rounded-xl p-5 mb-6 border border-green-100">
          <h2 className="font-semibold text-green-800 mb-2">Hackathon Demo Mode</h2>
          <p className="text-sm text-green-700 mb-4">
            Test the WhatsApp bot flow on the right. Try these inputs:
          </p>
          <ul className="text-sm text-green-800 space-y-2 list-disc pl-4">
            <li>"Hi"</li>
            <li>"Today sales: 18400, expenses: 7200"</li>
            <li>"Debit: NGN 50,000 to Bet9ja"</li>
            <li>"History"</li>
          </ul>
        </div>

        <div className="mt-auto">
          <button 
            onClick={() => sendMessage('Reset')}
            className="w-full py-2 px-4 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg flex items-center justify-center gap-2 transition-colors"
          >
            <RefreshCw size={16} />
            Reset Session
          </button>
        </div>
      </div>

      {/* WhatsApp Simulator */}
      <div className="flex-1 bg-[#efeae2] flex flex-col relative h-screen md:h-auto">
        {/* Header */}
        <div className="bg-[#00a884] text-white p-4 flex items-center gap-3 shadow-sm z-10">
          <div className="w-10 h-10 bg-gray-300 rounded-full flex items-center justify-center overflow-hidden">
            <img src="https://picsum.photos/seed/trustscore/100/100" alt="Bot Avatar" />
          </div>
          <div>
            <h2 className="font-semibold">TrustScore Bot 🇳🇬</h2>
            <p className="text-xs text-green-100">Online</p>
          </div>
        </div>

        {/* Chat Area */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-[url('https://user-images.githubusercontent.com/15075759/28719144-86dc0f70-73b1-11e7-911d-60d70fcded21.png')] bg-repeat opacity-90">
          {messages.map((msg, idx) => (
            <div key={idx} className={`flex flex-col ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}>
              <div 
                className={`max-w-[80%] rounded-lg p-3 shadow-sm whitespace-pre-wrap ${
                  msg.sender === 'user' 
                    ? 'bg-[#d9fdd3] text-gray-900 rounded-tr-none' 
                    : 'bg-white text-gray-900 rounded-tl-none'
                }`}
              >
                {msg.text}
              </div>
              
              {/* Quick Replies */}
              {msg.quickReplies && msg.quickReplies.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2 max-w-[80%]">
                  {msg.quickReplies.map((reply, rIdx) => (
                    <button
                      key={rIdx}
                      onClick={() => handleQuickReply(reply)}
                      className="bg-white border border-green-500 text-green-600 text-sm px-4 py-2 rounded-full hover:bg-green-50 transition-colors shadow-sm flex items-center gap-2"
                    >
                      {reply === 'Share Score with Lender' && <FileText size={14} />}
                      {reply === 'Copy Shareable Link' && <LinkIcon size={14} />}
                      {reply}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          {loading && (
            <div className="flex items-start">
              <div className="bg-white rounded-lg rounded-tl-none p-3 shadow-sm text-gray-500 text-sm flex items-center gap-2">
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></div>
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.4s' }}></div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <div className="bg-[#f0f2f5] p-3 flex items-center gap-2">
          <label className="p-2 text-gray-500 hover:text-gray-700 cursor-pointer transition-colors">
            <ImageIcon size={24} />
            <input type="file" accept="image/*" className="hidden" onChange={(e) => handleFileUpload(e, 'image')} />
          </label>
          <label className="p-2 text-gray-500 hover:text-gray-700 cursor-pointer transition-colors">
            <Mic size={24} />
            <input type="file" accept="audio/*" className="hidden" onChange={(e) => handleFileUpload(e, 'audio')} />
          </label>
          
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && sendMessage(input)}
            placeholder="Type a message..."
            className="flex-1 bg-white rounded-full px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-green-500 border-none"
          />
          <button 
            onClick={() => sendMessage(input)}
            disabled={!input.trim() || loading}
            className="p-2.5 bg-[#00a884] text-white rounded-full hover:bg-[#008f6f] disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center"
          >
            <Send size={20} className="ml-1" />
          </button>
        </div>
      </div>
    </div>
  );
}
