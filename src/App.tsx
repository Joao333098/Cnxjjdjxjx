/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { 
  Send, 
  Terminal, 
  Globe, 
  Play, 
  Square, 
  Loader2, 
  ChevronRight,
  Monitor,
  MessageSquare,
  Activity,
  MousePointer2,
  Trash2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface Message {
  id: string;
  role: 'user' | 'agent';
  content: string;
  thought?: string;
  action?: string;
  params?: any;
  stepNumber?: number;
  plan?: string[];
}

export default function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [prompt, setPrompt] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState('Idle');
  const [isProcessing, setIsProcessing] = useState(false);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [browserInfo, setBrowserInfo] = useState({ url: '', title: '', accessibilityTree: null as any });
  const [isChatOpen, setIsChatOpen] = useState(true);
  const [isLocked, setIsLocked] = useState(false);
  const [previewScale, setPreviewScale] = useState(0.4);
  const [manualUrl, setManualUrl] = useState('');
  const [stepCount, setStepCount] = useState(0);
  const [currentPlan, setCurrentPlan] = useState<string[]>([]);
  const [lastClick, setLastClick] = useState<{x: number, y: number, label?: string} | null>(null);
  const [isContinuous, setIsContinuous] = useState(true);
  const [showElements, setShowElements] = useState(false);
  const [keyboardText, setKeyboardText] = useState('');
  const [isKeyboardFocused, setIsKeyboardFocused] = useState(false);
  const [consoleLogs, setConsoleLogs] = useState<{type: string, text: string, time: number}[]>([]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [showConsoleToast, setShowConsoleToast] = useState(false);
  const [lastLog, setLastLog] = useState<{type: string, text: string} | null>(null);
  const [isThinking, setIsThinking] = useState(false);
  const [showFullConsole, setShowFullConsole] = useState(false);
  const [activeTab, setActiveTab] = useState<'chat' | 'console'>('chat');
  const [lastHtml, setLastHtml] = useState<string | null>(null);
  
  const chatEndRef = useRef<HTMLDivElement>(null);
  const keyboardInputRef = useRef<HTMLInputElement>(null);
  const stateRef = useRef({ screenshot: '', url: '', title: '', accessibilityTree: null as any });
  const isProcessingRef = useRef(false);
  const userPromptRef = useRef('');
  const stepCountRef = useRef(0);
  const lastActionRef = useRef<any>(null);
  const watchdogRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    // Backup loop: if we are processing but idle for too long, trigger a step
    const interval = setInterval(() => {
      if (isProcessingRef.current && !isLocked && status === 'Idle' && isContinuous) {
        console.log('Backup loop triggered step');
        runAgentStep();
      }
    }, 10000);
    return () => clearInterval(interval);
  }, [isLocked, status, isContinuous]);

  useEffect(() => {
    const newSocket = io();
    setSocket(newSocket);

    newSocket.on('browser-update', (data) => {
      setScreenshot(`data:image/jpeg;base64,${data.screenshot}`);
      setBrowserInfo({ url: data.url, title: data.title, accessibilityTree: data.accessibilityTree });
      stateRef.current = data;
      if (data.isPopup) {
        setStatus('Popup detected! Switching context...');
      }
    });

    newSocket.on('action-completed', (data) => {
      console.log('Action completed:', data.action);
      if (isProcessingRef.current) {
        setStatus('Page settling...');
        // Small delay to let the browser settle and capture new state
        if (watchdogRef.current) clearTimeout(watchdogRef.current);
        
        setTimeout(() => {
          if (isProcessingRef.current) {
            setStatus('Idle');
            runAgentStep();
          }
        }, 3500);
      }
    });

    newSocket.on('agent-status', (data) => {
      setStatus(data.message);
    });

    newSocket.on('agent-error', (data) => {
      setStatus('Error');
      setMessages(prev => [...prev, { 
        id: Date.now().toString(), 
        role: 'agent', 
        content: `Error: ${data.message}` 
      }]);
      setIsProcessing(false);
      isProcessingRef.current = false;
    });

    newSocket.on('console-log', (data) => {
      setConsoleLogs(prev => [...prev.slice(-49), { ...data, time: Date.now() }]);
      setLastLog(data);
      setShowConsoleToast(true);
      setTimeout(() => setShowConsoleToast(false), 3000);
    });

    newSocket.on('action-result', (data) => {
      if (data.action === 'getHtml') {
        setLastHtml(data.result.html);
        setActiveTab('console');
      } else if (['click', 'clickByText', 'clickBySelector', 'type', 'fill', 'find'].includes(data.action)) {
        if (data.result?.element || data.result?.success) {
          const el = data.result.element || data.result;
          const label = el.text || el.id || el.tag || el.selector || 'Action';
          if (el.x && el.y) {
            setLastClick({ x: el.x, y: el.y, label });
          }
        }
      }
    });

    return () => {
      newSocket.disconnect();
    };
  }, []);

  const runAgentStep = async () => {
    console.log('Agent step triggered', { isProcessing: isProcessingRef.current, isLocked });
    if (!isProcessingRef.current || !socket || isLocked) return;

    // Clear any existing watchdog
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    
    // Set a new watchdog - if no action completed in 25s, retry
    watchdogRef.current = setTimeout(() => {
      console.log('Watchdog triggered - retrying step');
      if (isProcessingRef.current && !isLocked) {
        setIsLocked(false);
        runAgentStep();
      }
    }, 25000);

    const { screenshot, url, title, accessibilityTree } = stateRef.current;
    if (!screenshot) {
      console.log('No screenshot available, retrying in 1s...');
      setTimeout(runAgentStep, 1000);
      return;
    }

    setIsLocked(true);
    setIsThinking(true);
    stepCountRef.current += 1;
    setStepCount(stepCountRef.current);
    setStatus(`Thinking (Step ${stepCountRef.current})...`);
    
    const systemPrompt = `
      You are an elite autonomous browser agent. Your goal: "${userPromptRef.current}"
      
      CURRENT STEP: ${stepCountRef.current}
      LAST ACTION: ${lastActionRef.current ? JSON.stringify(lastActionRef.current) : 'None'}
      
      CONSOLE LOGS (Last 10):
      ${consoleLogs.slice(-10).map(l => `[${l.type}] ${l.text}`).join('\n')}

      ===== CRITICAL RULES (NEVER BREAK THESE) =====

      RULE 1 - ONLY DO WHAT WAS ASKED:
      - NEVER click "Create account", "Sign up", "Register", or any button that was NOT part of the user goal.
      - NEVER perform actions beyond the scope of the goal.
      - If you see a "Create account" button on a login page, IGNORE it. Your job is to LOG IN, not create an account.
      - Before clicking any button, ask yourself: "Did the user ask me to do this?" If no, skip it.

      RULE 2 - CAPTCHA FIELD IDENTIFICATION (MOST IMPORTANT):
      - When you see a CAPTCHA image on screen, you MUST follow this EXACT procedure:
        STEP A: Call getHtml() FIRST to see ALL input fields and their attributes (name, id, placeholder, aria-label, autocomplete).
        STEP B: Read every input field carefully. Identify them by their attributes:
          * Email/username field: has "email", "username", "identifier", "login" in its name/id/placeholder/autocomplete.
          * CAPTCHA field: has "captcha", "code", "challenge", "verification", "Type the text", "hear or see" in its placeholder or aria-label. It is usually EMPTY and positioned BELOW the CAPTCHA image.
        STEP C: NEVER type the CAPTCHA text into a field that already has content (like the email field).
        STEP D: Type the CAPTCHA text ONLY into the field identified as the CAPTCHA field in STEP B.
        STEP E: Use 'find' with placeholder="Type the text you hear or see" OR use the index of the CAPTCHA field from getHtml.
        STEP F: If you typed in the wrong field, immediately use type with clear=true to erase it, then type in the correct field.
      
      RULE 3 - FIELD ALREADY FILLED = DO NOT TOUCH IT:
      - If the accessibility tree or screenshot shows a field already has content (e.g., email already typed), DO NOT type in that field again.
      - Look at the screenshot: fields with text already in them are DONE. Move to the next empty required field.

      ===== GENERAL REASONING =====
      - Think like a careful human. Look at visual cues, colors, layout.
      - PRECISION: Use element index whenever available. It is 100% accurate.
      - SELF-CORRECTION: If last action failed (page unchanged, error in console), explain why and try a completely different approach.
      - INFINITE PROGRESSION: Do not stop until the goal is 100% achieved.
      
      Current Context:
      - URL: ${url}
      - Title: ${title}
      - Viewport: Desktop (1280x800)
      
      INSTRUCTIONS:
      1. Look at the screenshot carefully. Identify what is ALREADY done vs what still needs to be done.
      2. Check if any button you're about to click is outside the scope of the user goal. If yes, skip it.
      3. If a CAPTCHA is visible, run getHtml() first before typing anything.
      4. Choose the BEST tool and provide a brief PLAN (next 3-5 steps).
      
      TOOLS:
      - navigate(url: string)
      - click(index: number)
      - clickAt(x: number, y: number)
      - clickByText(text: string)
      - clickBySelector(selector: string)
      - type(index: number, text: string, clear?: boolean, pressEnter?: boolean)
      - typeAt(x: number, y: number, text: string, clear?: boolean, pressEnter?: boolean)
      - fill(selector: string, text: string, index?: number)
      - find(role?: string, text?: string, label?: string, placeholder?: string, action?: "click" | "fill" | "type", value?: string, name?: string)
      - scroll(direction: "up" | "down", amount: number)
      - wait(ms: number)
      - waitForSelector(selector: string)
      - goBack(), reload()
      - bypassVideo()
      - closePopup()
      - hover(x: number, y: number, index?: number)
      - runJs(code: string)
      - getHtml(selector?: string)
      - pressKey(key: string)
      - finish(message: string)
      
      RESPONSE FORMAT (JSON ONLY):
      - DO NOT use comments (//) in the JSON.
      - DO NOT use unescaped newlines in strings.
      - Return ONLY a valid JSON object.
      {
        "thought": "Step-by-step reasoning. State what fields are already filled. State which field needs action. If CAPTCHA, state what the CAPTCHA image says and which field index/selector is the CAPTCHA input.",
        "plan": ["step 1", "step 2", "step 3", "step 4", "step 5"],
        "action": "tool_name",
        "params": { ... }
      }
    `;

    try {
      // Add a tiny delay to avoid rate limits but keep it fast
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const response = await fetch('/api/nova', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: systemPrompt },
                ...(screenshot ? [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${screenshot}` } }] : []),
                { type: "text", text: `Accessibility Tree: ${JSON.stringify(accessibilityTree).slice(0, 15000)}` }
              ]
            }
          ],
          response_format: { type: "json_object" }
        })
      });

      if (!response.ok) throw new Error("Failed to call Nova API");
      const data = await response.json();
      
      const text = data.choices[0].message.content;
      if (!text) throw new Error("Empty response from AI");
      
      // Clean up markdown formatting if present
      let cleanedText = text.replace(/```json/gi, '').replace(/```/g, '').trim();
      
      // Extract just the JSON object if there's text before or after it
      const jsonMatch = cleanedText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        cleanedText = jsonMatch[0];
      }
      
      let result;
      try {
        result = JSON.parse(cleanedText);
      } catch (e) {
        console.error("Failed to parse JSON:", cleanedText);
        throw new Error(`JSON Parse error: ${(e as Error).message}`);
      }
      console.log('AI Decision:', result);
      
      if (result.plan) setCurrentPlan(result.plan);

      setMessages(prev => [...prev, { 
        id: Date.now().toString(), 
        role: 'agent', 
        content: '', 
        thought: result.thought, 
        action: result.action,
        params: result.params,
        stepNumber: stepCountRef.current,
        plan: result.plan
      }]);

      if (result.action === 'finish') {
        setStatus('Ready');
        setIsThinking(false);
        setMessages(prev => [...prev, { id: Date.now().toString(), role: 'agent', content: result.params?.message || 'Task complete' }]);
        isProcessingRef.current = false;
        setIsProcessing(false);
        lastActionRef.current = null;
        setLastClick(null);
      } else {
        setStatus(`Executing ${result.action}...`);
        setIsThinking(false);
        lastActionRef.current = { action: result.action, params: result.params };
        
        if (result.action === 'click' || result.action === 'type' || result.action === 'hover') {
          if (result.params.x !== undefined && result.params.y !== undefined) {
            setLastClick({ x: result.params.x, y: result.params.y });
          } else {
            setLastClick(null);
          }
        } else {
          setLastClick(null);
        }
        
        socket.emit('execute-action', { action: result.action, params: result.params });
      }
    } catch (error) {
      console.error("Agent step failed:", error);
      setStatus('Error');
      setIsThinking(false);
      setMessages(prev => [...prev, { 
        id: Date.now().toString(), 
        role: 'agent', 
        content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` 
      }]);
      setIsProcessing(false);
      isProcessingRef.current = false;
    } finally {
      setIsLocked(false);
    }
  };

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleStart = () => {
    if (!prompt.trim() || !socket) return;
    
    setIsProcessing(true);
    isProcessingRef.current = true;
    userPromptRef.current = prompt;
    stepCountRef.current = 0;
    setStepCount(0);
    setCurrentPlan([]);
    
    const userMsg: Message = { id: Date.now().toString(), role: 'user', content: prompt };
    setMessages(prev => [...prev, userMsg]);
    
    socket.emit('start-task');
    setPrompt('');
    
    // Start the loop after a short delay to allow browser to initialize
    setTimeout(runAgentStep, 2000);
  };

  const handleRetry = () => {
    if (isProcessingRef.current) {
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      setIsLocked(false);
      runAgentStep();
    }
  };

  const handleStop = () => {
    if (socket) {
      socket.emit('stop-task');
      setIsProcessing(false);
      isProcessingRef.current = false;
      setStatus('Stopped');
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
    }
  };

  const handleManualNavigate = () => {
    if (socket && manualUrl) {
      const url = manualUrl.startsWith('http') ? manualUrl : `https://${manualUrl}`;
      
      // Add as a manual step to the chat
      setMessages(prev => [...prev, { 
        id: Date.now().toString(), 
        role: 'agent', 
        content: `Manually navigating to ${url}`,
        action: 'navigate'
      }]);
      
      socket.emit('execute-action', { action: 'navigate', params: { url } });
      setManualUrl('');
      
      // If we weren't processing, maybe we should start?
      // For now, just let the action-completed trigger the next step if isProcessing is true
    }
  };

  const handleScreenshotClick = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!socket || isProcessing) return;
    
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 1280;
    const y = ((e.clientY - rect.top) / rect.height) * 800;
    
    // Check if we clicked an input to trigger the keyboard
    if (browserInfo.accessibilityTree) {
      const findInputAt = (node: any): any => {
        // Add a small margin (5px) for easier clicking on mobile
        const margin = 5;
        const isInside = x >= node.x - margin && x <= node.x + node.w + margin && 
                         y >= node.y - margin && y <= node.y + node.h + margin;
        
        if (isInside) {
          const isInput = ['input', 'textarea'].includes(node.tag) || 
                          node.role === 'textbox' || 
                          node.className?.includes('editable') ||
                          node.id?.includes('editable');
          if (isInput) return node;
        }
        
        if (node.children) {
          for (const child of node.children) {
            const found = findInputAt(child);
            if (found) return found;
          }
        }
        return null;
      };
      
      const inputNode = findInputAt(browserInfo.accessibilityTree);
      if (inputNode) {
        console.log('Input detected at click, focusing virtual keyboard');
        keyboardInputRef.current?.focus();
        setLastClick({ x: inputNode.x + inputNode.w / 2, y: inputNode.y + inputNode.h / 2 });
      } else {
        setLastClick({ x, y });
      }
    } else {
      setLastClick({ x, y });
    }
    
    socket.emit('manual-click', { x, y });
  };

  const handleKeyboardSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (socket && keyboardText && lastClick) {
      socket.emit('execute-action', { 
        action: 'type', 
        params: { x: lastClick.x, y: lastClick.y, text: keyboardText, pressEnter: true } 
      });
      setKeyboardText('');
      keyboardInputRef.current?.blur();
    }
  };

  return (
    <div className="flex h-screen bg-[#0a0a0a] text-white font-sans overflow-hidden relative">
      {/* Sidebar Toggle Button (Desktop) */}
      {!isSidebarOpen && (
        <button 
          onClick={() => setIsSidebarOpen(true)}
          className="absolute right-4 top-20 z-50 p-3 bg-emerald-500 text-black rounded-full shadow-2xl hover:scale-110 transition-transform"
        >
          <MessageSquare className="w-5 h-5" />
        </button>
      )}

      {/* Main Browser View - Always visible as background on mobile, side-by-side on desktop */}
      <div className="flex-1 relative flex flex-col bg-black h-full">
        {/* Browser Header */}
        <div className="h-14 border-b border-white/10 flex items-center px-4 gap-4 bg-[#0f0f0f] z-20">
          <div className="flex items-center gap-2 text-zinc-400">
            <Monitor className="w-4 h-4" />
            <span className="hidden md:inline text-[10px] font-bold uppercase tracking-widest">Live View</span>
          </div>
          <div className="flex-1 flex items-center gap-2">
            <div className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 flex items-center gap-2 overflow-hidden">
              <Globe className="w-3 h-3 text-zinc-500 flex-shrink-0" />
              <input 
                type="text"
                value={manualUrl}
                onChange={(e) => setManualUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleManualNavigate()}
                placeholder={browserInfo.url || "Enter URL..."}
                className="bg-transparent border-none outline-none text-[11px] text-zinc-300 w-full font-mono"
              />
            </div>
            <button 
              onClick={handleManualNavigate}
              className="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-emerald-500"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          
          <div className="flex items-center gap-3 border-l border-white/10 pl-4">
            {isProcessing && (
              <div className="flex items-center gap-2 px-2 py-1 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
                <span className="text-[10px] text-emerald-500 font-black uppercase tracking-widest">Step {stepCount}</span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-zinc-500 uppercase font-bold">Auto</span>
              <button 
                onClick={() => setIsContinuous(!isContinuous)}
                className={`w-8 h-4 rounded-full relative transition-colors ${isContinuous ? 'bg-emerald-500' : 'bg-zinc-700'}`}
              >
                <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-all ${isContinuous ? 'left-4.5' : 'left-0.5'}`} />
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-zinc-500 uppercase font-bold">Elements</span>
              <button 
                onClick={() => setShowElements(!showElements)}
                className={`w-8 h-4 rounded-full relative transition-colors ${showElements ? 'bg-emerald-500' : 'bg-zinc-700'}`}
              >
                <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-all ${showElements ? 'left-4.5' : 'left-0.5'}`} />
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-zinc-500 uppercase font-bold">Scale</span>
              <input 
                type="range" 
                min="0.3" 
                max="1" 
                step="0.1" 
                value={previewScale} 
                onChange={(e) => setPreviewScale(parseFloat(e.target.value))}
                className="w-16 h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-emerald-500"
              />
            </div>
            <button 
              onClick={() => socket?.emit('execute-action', { action: 'reload' })}
              className="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-zinc-500"
              title="Reload Page"
            >
              <Activity className="w-4 h-4" />
            </button>
            <button 
              onClick={() => socket?.emit('request-state')}
              className="p-2 hover:bg-white/10 rounded-lg transition-colors text-zinc-500"
              title="Refresh State"
            >
              <Globe className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Browser Content */}
        <div className="flex-1 relative overflow-hidden bg-[#050505] flex items-center justify-center group">
          
          {/* Manual Control Panel */}
          <div className="absolute bottom-6 left-6 z-40 bg-black/80 backdrop-blur-xl border border-white/10 rounded-2xl p-4 shadow-2xl flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-black uppercase tracking-widest text-zinc-400">Manual</span>
              <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            </div>
            <input 
              ref={keyboardInputRef}
              type="text"
              value={keyboardText}
              onChange={(e) => setKeyboardText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleKeyboardSubmit(e as any)}
              placeholder="Type here..."
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-[11px] text-white font-mono outline-none focus:border-emerald-500 w-40"
            />
            <button 
              onClick={() => {
                if (lastClick) {
                  socket?.emit('execute-action', { 
                    action: 'type', 
                    params: { x: lastClick.x, y: lastClick.y, text: keyboardText, pressEnter: true } 
                  });
                  setKeyboardText('');
                }
              }}
              className="px-3 py-1.5 bg-emerald-500 text-black text-[10px] font-bold uppercase tracking-widest rounded-lg hover:bg-emerald-400 transition-colors"
            >
              Type
            </button>
          </div>

          {/* Agent HUD - Floating Status Overlay */}
          <AnimatePresence>
            {isProcessing && (
              <motion.div 
                initial={{ y: -20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: -20, opacity: 0 }}
                className="absolute top-20 left-1/2 -translate-x-1/2 z-50 w-full max-w-md px-4"
              >
                <div className="bg-black/80 backdrop-blur-xl border border-emerald-500/20 rounded-2xl p-4 shadow-[0_0_50px_rgba(16,185,129,0.1)]">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center border ${isThinking ? 'bg-emerald-500/20 border-emerald-500/40 animate-pulse' : 'bg-zinc-800 border-white/10'}`}>
                        {isThinking ? <Activity className="w-5 h-5 text-emerald-400" /> : <Play className="w-5 h-5 text-zinc-400" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-emerald-500">Agent Status</p>
                        <p className="text-sm font-bold text-white truncate">{status}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button 
                        onClick={() => setShowFullConsole(!showFullConsole)}
                        className={`p-2 rounded-lg transition-colors ${showFullConsole ? 'bg-emerald-500 text-black' : 'hover:bg-white/10 text-zinc-400'}`}
                        title="Toggle Console"
                      >
                        <Terminal className="w-4 h-4" />
                      </button>
                      <button onClick={handleStop} className="p-2 hover:bg-red-500/20 text-red-500 rounded-lg transition-colors">
                        <Square className="w-4 h-4 fill-current" />
                      </button>
                    </div>
                  </div>

                  {/* Current Thought Overlay */}
                  {isThinking && messages.length > 0 && messages[messages.length - 1].thought && (
                    <motion.div 
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      className="mb-3 p-3 bg-emerald-500/5 border border-emerald-500/10 rounded-xl"
                    >
                      <p className="text-[11px] text-emerald-200/80 italic leading-relaxed">
                        "{messages[messages.length - 1].thought}"
                      </p>
                    </motion.div>
                  )}

                  {/* Current Plan Mini-View */}
                  {currentPlan.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <div className="h-[1px] flex-1 bg-white/5" />
                        <span className="text-[9px] font-black uppercase tracking-widest text-zinc-500">Next Steps</span>
                        <div className="h-[1px] flex-1 bg-white/5" />
                      </div>
                      <div className="grid grid-cols-1 gap-1.5">
                        {currentPlan.slice(0, 3).map((step, i) => (
                          <div key={i} className="flex items-center gap-3 text-[11px] text-zinc-400 bg-white/5 p-2 rounded-lg border border-white/5">
                            <span className="w-4 h-4 rounded bg-emerald-500/10 text-emerald-500 flex items-center justify-center text-[9px] font-bold">{i + 1}</span>
                            <span className="truncate">{step}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Console Toast Overlay */}
          <AnimatePresence>
            {showConsoleToast && lastLog && (
              <motion.div 
                initial={{ x: 50, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: 50, opacity: 0 }}
                className="absolute right-6 top-1/2 -translate-y-1/2 z-50 w-64"
              >
                <div className={`p-3 rounded-xl border backdrop-blur-xl shadow-2xl ${
                  lastLog.type === 'error' ? 'bg-red-500/10 border-red-500/20 text-red-400' :
                  lastLog.type === 'warn' ? 'bg-yellow-500/10 border-yellow-500/20 text-yellow-400' :
                  'bg-blue-500/10 border-blue-500/20 text-blue-400'
                }`}>
                  <div className="flex items-center gap-2 mb-1">
                    <Terminal className="w-3 h-3" />
                    <span className="text-[9px] font-black uppercase tracking-widest">Console Log</span>
                  </div>
                  <p className="text-[11px] font-mono line-clamp-3 leading-relaxed">{lastLog.text}</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Full Console Overlay */}
          <AnimatePresence>
            {showFullConsole && (
              <motion.div 
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="absolute inset-4 md:inset-10 z-[60] bg-black/90 backdrop-blur-3xl border border-white/10 rounded-3xl overflow-hidden flex flex-col shadow-2xl"
              >
                <div className="p-4 border-b border-white/10 flex items-center justify-between bg-white/5">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-zinc-800 flex items-center justify-center">
                      <Terminal className="w-4 h-4 text-emerald-500" />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold">System Console</h3>
                      <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-black">Live Debug Stream</p>
                    </div>
                  </div>
                  <button 
                    onClick={() => setShowFullConsole(false)}
                    className="p-2 hover:bg-white/10 rounded-lg text-zinc-500"
                  >
                    <ChevronRight className="w-5 h-5 rotate-90" />
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto p-4 font-mono text-[11px] space-y-2 scrollbar-hide">
                  {consoleLogs.map((log, i) => (
                    <div key={i} className={`flex gap-3 p-2 rounded-lg border ${
                      log.type === 'error' ? 'bg-red-500/5 border-red-500/10 text-red-400' :
                      log.type === 'warn' ? 'bg-yellow-500/5 border-yellow-500/10 text-yellow-400' :
                      'bg-white/5 border-white/5 text-zinc-400'
                    }`}>
                      <span className="text-zinc-600 flex-shrink-0">[{new Date(log.time).toLocaleTimeString()}]</span>
                      <span className="break-all">{log.text}</span>
                    </div>
                  ))}
                  {consoleLogs.length === 0 && (
                    <div className="h-full flex flex-col items-center justify-center opacity-20 py-20">
                      <Terminal className="w-12 h-12 mb-4" />
                      <p className="text-sm">No logs recorded yet</p>
                    </div>
                  )}
                </div>
                <div className="p-4 border-t border-white/10 bg-black">
                  <input 
                    type="text"
                    placeholder="agent-browser ..."
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[11px] text-white font-mono outline-none focus:border-emerald-500"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        socket?.emit('execute-cli-command', e.currentTarget.value);
                        e.currentTarget.value = '';
                      }
                    }}
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {screenshot ? (
            <div className="relative flex items-center justify-center p-4 md:p-8 w-full h-full overflow-auto scrollbar-hide">
              <div 
                style={{ 
                  width: '1280px', 
                  height: '800px', 
                  transform: `scale(${previewScale})`,
                  transformOrigin: 'center center',
                  transition: 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                  margin: 'auto',
                  boxSizing: 'content-box'
                }}
                className="relative flex-shrink-0 shadow-[0_0_100px_rgba(0,0,0,0.8)] rounded-xl border-[8px] border-[#1a1a1a] bg-white"
              >
                {/* Inner container that is exactly 1280x800 */}
                <div className="relative w-full h-full rounded-lg overflow-hidden">
                  <img
                    src={screenshot}
                    alt="Browser Preview"
                    onClick={handleScreenshotClick}
                    className="w-full h-full object-cover cursor-crosshair"
                  />

                  {/* Hidden Input to trigger mobile keyboard */}
                  <form onSubmit={handleKeyboardSubmit} className="absolute opacity-0 pointer-events-none">
                    <input 
                      ref={keyboardInputRef}
                      type="text" 
                      value={keyboardText}
                      onChange={(e) => setKeyboardText(e.target.value)}
                      onFocus={() => setIsKeyboardFocused(true)}
                      onBlur={() => {
                        setIsKeyboardFocused(false);
                        setKeyboardText('');
                      }}
                    />
                  </form>

                  {/* Keyboard Input Overlay */}
                  <AnimatePresence>
                    {isKeyboardFocused && (
                      <motion.div 
                        initial={{ y: 50, opacity: 0 }}
                        animate={{ y: 0, opacity: 1 }}
                        exit={{ y: 50, opacity: 0 }}
                        className="absolute bottom-10 left-4 right-4 bg-black/90 backdrop-blur-xl border border-emerald-500/50 p-4 rounded-2xl z-50 shadow-2xl"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex-1">
                            <p className="text-[10px] text-emerald-500 font-black uppercase tracking-widest mb-1">Manual Typing</p>
                            <p className="text-sm font-mono text-white break-all">
                              {keyboardText || <span className="text-zinc-500 italic">Type on your keyboard...</span>}
                              <span className="inline-block w-2 h-4 bg-emerald-500 ml-1 animate-pulse" />
                            </p>
                          </div>
                          <button 
                            onClick={handleKeyboardSubmit}
                            className="px-4 py-2 bg-emerald-500 text-black rounded-lg font-bold text-xs uppercase tracking-widest"
                          >
                            Send
                          </button>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {/* Clickable Elements Overlay */}
                  {showElements && browserInfo.accessibilityTree && (
                    <div className="absolute inset-0 pointer-events-none z-40">
                      {(() => {
                        const elements: any[] = [];
                        const flatten = (node: any) => {
                          if (node.w > 0 && node.h > 0) {
                            const isClickable = ['button', 'a', 'input', 'textarea', 'select'].includes(node.tag) || node.role === 'button' || node.role === 'link' || node.index;
                            if (isClickable) elements.push(node);
                          }
                          if (node.children) node.children.forEach(flatten);
                        };
                        flatten(browserInfo.accessibilityTree);
                        return elements.map((el, i) => (
                          <div 
                            key={i}
                            className="absolute border border-emerald-500/30 bg-emerald-500/5 flex items-center justify-center"
                            style={{ left: el.x, top: el.y, width: el.w, height: el.h }}
                          >
                            {el.index && (
                              <div className="bg-emerald-500 text-black text-[10px] font-black px-1 rounded-sm shadow-lg">
                                {el.index}
                              </div>
                            )}
                          </div>
                        ));
                      })()}
                    </div>
                  )}

                  {/* Last Click/Action Indicator */}
                  {lastClick && (
                    <motion.div 
                      initial={{ scale: 1.5, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      className="absolute z-50 pointer-events-none flex flex-col items-center"
                      style={{ left: lastClick.x, top: lastClick.y }}
                    >
                      <div className="w-10 h-10 -ml-5 -mt-5 border-2 border-emerald-500 rounded-lg flex items-center justify-center bg-emerald-500/10 shadow-[0_0_15px_rgba(16,185,129,0.5)]">
                        <div className="w-2 h-2 bg-emerald-500 rounded-sm animate-pulse" />
                      </div>
                      {lastClick.label && (
                        <motion.div 
                          initial={{ opacity: 0, y: 5 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="mt-2 px-2 py-1 bg-emerald-500 text-black text-[10px] font-black rounded shadow-2xl whitespace-nowrap uppercase tracking-tighter"
                        >
                          {lastClick.label}
                        </motion.div>
                      )}
                    </motion.div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4 opacity-20">
              <div className="w-24 h-24 rounded-full border-2 border-dashed border-white flex items-center justify-center animate-[spin_10s_linear_infinite]">
                <Globe className="w-10 h-10" />
              </div>
              <p className="text-sm font-mono tracking-widest uppercase">Waiting for browser...</p>
            </div>
          )}

          {/* Floating Agent Status Bar (Mobile) */}
          <div className="md:hidden absolute bottom-20 left-4 right-4 z-30">
            <motion.div 
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              className="bg-black/80 backdrop-blur-xl border border-white/10 p-3 rounded-2xl flex items-center justify-between shadow-2xl"
            >
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${isProcessing ? 'bg-emerald-500 animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-zinc-500'}`} />
                <span className="text-[10px] uppercase font-bold tracking-widest text-zinc-400">{status}</span>
              </div>
              <div className="flex gap-3">
                {isProcessing && (
                  <button onClick={handleRetry} className="text-[10px] font-bold text-emerald-500 uppercase tracking-widest">Retry</button>
                )}
                {isProcessing && (
                  <button onClick={handleStop} className="text-[10px] font-bold text-red-500 uppercase tracking-widest">Stop</button>
                )}
              </div>
            </motion.div>
          </div>
        </div>
      </div>

      {/* Sidebar / Bottom Sheet - Chat Interface */}
      <AnimatePresence>
        {isSidebarOpen && (
          <motion.div 
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className={`
              fixed md:relative top-0 right-0 h-full w-full md:w-[400px] 
              bg-[#0f0f0f]/95 backdrop-blur-2xl md:bg-[#0f0f0f] 
              border-l border-white/10 z-40 flex flex-col
            `}
          >
            <div className="p-4 border-b border-white/10 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-emerald-500 flex items-center justify-center">
                  <Globe className="w-5 h-5 text-black" />
                </div>
                <h1 className="font-bold text-lg tracking-tight">OmniBrowser</h1>
              </div>
              <div className="flex items-center gap-2">
                <button 
                  onClick={() => setMessages([])}
                  className="p-2 hover:bg-white/10 rounded-lg transition-colors text-zinc-500 hover:text-white"
                  title="Clear Chat"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
                <button 
                  onClick={() => setIsSidebarOpen(false)}
                  className="p-2 hover:bg-white/10 rounded-lg text-zinc-500"
                >
                  <ChevronRight className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-white/10">
              <button 
                onClick={() => setActiveTab('chat')}
                className={`flex-1 py-3 text-[10px] font-black uppercase tracking-widest transition-colors ${activeTab === 'chat' ? 'text-emerald-500 border-b-2 border-emerald-500' : 'text-zinc-500 hover:text-zinc-300'}`}
              >
                Agent History
              </button>
            </div>

            {/* Plan Display */}
            {activeTab === 'chat' && currentPlan.length > 0 && isProcessing && (
              <div className="mx-4 mt-4 p-3 bg-emerald-500/5 border border-emerald-500/10 rounded-xl">
                <div className="flex items-center gap-2 mb-2">
                  <Play className="w-3 h-3 text-emerald-500" />
                  <span className="text-[10px] font-black uppercase tracking-widest text-emerald-500">Current Plan</span>
                </div>
                <div className="space-y-1.5">
                  {currentPlan.map((step, i) => (
                    <div key={i} className="flex items-start gap-2 text-[11px] text-zinc-400">
                      <span className="text-emerald-500/50 font-mono">{i + 1}.</span>
                      <span className={i === 0 ? 'text-zinc-200 font-medium' : ''}>{step}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Messages Area */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-hide">
              {activeTab === 'chat' ? (
                <>
                  {messages.length === 0 && (
                    <div className="h-full flex flex-col items-center justify-center text-center space-y-4 opacity-40">
                      <div className="w-16 h-16 rounded-full border border-dashed border-white/20 flex items-center justify-center">
                        <MessageSquare className="w-8 h-8" />
                      </div>
                      <div className="space-y-1">
                        <p className="text-sm font-medium">No active task</p>
                        <p className="text-xs">Type a goal below to start the agent</p>
                      </div>
                    </div>
                  )}
                  <AnimatePresence initial={false}>
                    {messages.map((msg) => (
                      <motion.div
                        key={msg.id}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
                      >
                        <div className={`max-w-[90%] p-4 rounded-2xl shadow-lg ${
                          msg.role === 'user' 
                            ? 'bg-emerald-500 text-black font-semibold' 
                            : 'bg-[#1a1a1a] border border-white/10'
                        }`}>
                          {msg.content && <p className="text-sm leading-relaxed">{msg.content}</p>}
                          {msg.thought && (
                            <div className="space-y-3">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-emerald-500 font-black">
                                  <Activity className="w-3 h-3" />
                                  <span>Step {msg.stepNumber || 'Analysis'}</span>
                                </div>
                                <div className="px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-[9px] text-emerald-500 font-bold uppercase tracking-tighter">
                                  Active
                                </div>
                              </div>
                              <p className="text-sm text-zinc-300 leading-relaxed font-medium">{msg.thought}</p>
                              {msg.action && (
                                <div className="flex flex-col gap-2 p-3 bg-black/60 rounded-xl border border-white/10 shadow-inner">
                                  <div className="flex items-center gap-3">
                                    <div className="w-8 h-8 rounded-lg bg-emerald-500/20 flex items-center justify-center border border-emerald-500/30">
                                      <MousePointer2 className="w-4 h-4 text-emerald-400" />
                                    </div>
                                    <div className="flex flex-col">
                                      <span className="text-[9px] uppercase tracking-widest text-zinc-500 font-bold">Executing Action</span>
                                      <span className="text-xs font-mono text-emerald-400 font-bold">{msg.action}</span>
                                    </div>
                                  </div>
                                  {msg.params && (
                                    <div className="text-[10px] font-mono text-zinc-500 bg-black/40 p-2 rounded border border-white/5 overflow-x-auto">
                                      {JSON.stringify(msg.params, null, 2)}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </>
              ) : (
                <div className="space-y-2 font-mono text-[11px]">
                  {lastHtml && (
                    <div className="mb-4 p-3 bg-blue-500/10 border border-blue-500/20 rounded-xl">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2 text-blue-400">
                          <Globe className="w-3 h-3" />
                          <span className="text-[9px] font-black uppercase tracking-widest">HTML Inspector</span>
                        </div>
                        <button onClick={() => setLastHtml(null)} className="text-[9px] text-zinc-500 hover:text-white uppercase">Clear</button>
                      </div>
                      <pre className="whitespace-pre-wrap break-all text-zinc-300 bg-black/40 p-2 rounded border border-white/5 max-h-60 overflow-y-auto">
                        {lastHtml}
                      </pre>
                    </div>
                  )}
                  {consoleLogs.length === 0 && !lastHtml && (
                    <div className="h-full flex flex-col items-center justify-center text-center opacity-20 py-20">
                      <Terminal className="w-8 h-8 mb-2" />
                      <p>Console is empty</p>
                    </div>
                  )}
                  {consoleLogs.map((log, i) => (
                    <div key={i} className={`p-2 rounded border border-white/5 ${
                      log.type === 'error' ? 'bg-red-500/10 text-red-400 border-red-500/20' :
                      log.type === 'warning' ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20' :
                      'bg-white/5 text-zinc-400'
                    }`}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[9px] font-black uppercase tracking-tighter opacity-50">{log.type}</span>
                        <span className="text-[9px] opacity-30">{new Date(log.time).toLocaleTimeString()}</span>
                      </div>
                      <p className="break-all">{log.text}</p>
                    </div>
                  ))}
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Input Area */}
            <div className="p-4 border-t border-white/10 bg-black/20">
              <div className="relative">
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleStart())}
                  placeholder="Describe what the agent should do..."
                  className="w-full bg-white/5 border border-white/10 rounded-xl p-4 pr-12 text-sm focus:outline-none focus:border-emerald-500/50 transition-colors resize-none h-24"
                />
                <button
                  onClick={handleStart}
                  disabled={isProcessing || !prompt.trim()}
                  className="absolute bottom-3 right-3 p-2 rounded-lg bg-emerald-500 text-black hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isProcessing ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating Chat Toggle (Mobile) */}
      {!isChatOpen && (
        <button 
          onClick={() => setIsChatOpen(true)}
          className="md:hidden fixed bottom-6 right-6 w-14 h-14 bg-emerald-500 text-black rounded-full shadow-2xl flex items-center justify-center z-50 hover:scale-105 active:scale-95 transition-transform"
        >
          <MessageSquare className="w-6 h-6" />
        </button>
      )}
    </div>
  );
}
