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
  ChevronRight,
  Monitor,
  MessageSquare,
  Activity,
  Trash2,
  RotateCcw,
  RefreshCw,
  Cpu,
  Zap,
  X,
  PanelRightClose,
  PanelRightOpen,
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
  const [isLocked, setIsLocked] = useState(false);
  const [previewScale, setPreviewScale] = useState(0.5);
  const [manualUrl, setManualUrl] = useState('');
  const [stepCount, setStepCount] = useState(0);
  const [currentPlan, setCurrentPlan] = useState<string[]>([]);
  const [lastClick, setLastClick] = useState<{ x: number; y: number; label?: string } | null>(null);
  const [isContinuous, setIsContinuous] = useState(true);
  const [showElements, setShowElements] = useState(false);
  const [keyboardText, setKeyboardText] = useState('');
  const [isKeyboardFocused, setIsKeyboardFocused] = useState(false);
  const [consoleLogs, setConsoleLogs] = useState<{ type: string; text: string; time: number }[]>([]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [lastLog, setLastLog] = useState<{ type: string; text: string } | null>(null);
  const [isThinking, setIsThinking] = useState(false);
  const [activeTab, setActiveTab] = useState<'chat' | 'console'>('chat');
  const [lastHtml, setLastHtml] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const keyboardInputRef = useRef<HTMLInputElement>(null);
  const stateRef = useRef({ screenshot: '', url: '', title: '', accessibilityTree: null as any });
  const isProcessingRef = useRef(false);
  const userPromptRef = useRef('');
  const stepCountRef = useRef(0);
  const lastActionRef = useRef<any>(null);
  const watchdogRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      if (isProcessingRef.current && !isLocked && status === 'Idle' && isContinuous) {
        runAgentStep();
      }
    }, 10000);
    return () => clearInterval(interval);
  }, [isLocked, status, isContinuous]);

  useEffect(() => {
    const newSocket = io({ transports: ['polling', 'websocket'] });
    setSocket(newSocket);

    newSocket.on('connect', () => setConnected(true));
    newSocket.on('disconnect', () => setConnected(false));

    newSocket.on('browser-update', (data) => {
      setScreenshot(`data:image/jpeg;base64,${data.screenshot}`);
      setBrowserInfo({ url: data.url, title: data.title, accessibilityTree: data.accessibilityTree });
      stateRef.current = data;
      if (data.isPopup) setStatus('Popup detectado! Trocando contexto...');
    });

    newSocket.on('action-completed', (data) => {
      if (isProcessingRef.current) {
        setStatus('Página carregando...');
        if (watchdogRef.current) clearTimeout(watchdogRef.current);
        setTimeout(() => {
          if (isProcessingRef.current) {
            setStatus('Idle');
            runAgentStep();
          }
        }, 3500);
      }
    });

    newSocket.on('agent-status', (data) => setStatus(data.message));

    newSocket.on('agent-error', (data) => {
      setStatus('Erro');
      setMessages((prev) => [
        ...prev,
        { id: Date.now().toString(), role: 'agent', content: `Erro: ${data.message}` },
      ]);
      setIsProcessing(false);
      isProcessingRef.current = false;
    });

    newSocket.on('console-log', (data) => {
      setConsoleLogs((prev) => [...prev.slice(-49), { ...data, time: Date.now() }]);
      setLastLog(data);
    });

    newSocket.on('action-result', (data) => {
      if (data.action === 'getHtml') {
        setLastHtml(data.result.html);
        setActiveTab('console');
      } else if (['click', 'clickByText', 'clickBySelector', 'type', 'fill', 'find'].includes(data.action)) {
        if (data.result?.element || data.result?.success) {
          const el = data.result.element || data.result;
          const label = el.text || el.id || el.tag || el.selector || 'Action';
          if (el.x && el.y) setLastClick({ x: el.x, y: el.y, label });
        }
      }
    });

    return () => { newSocket.disconnect(); };
  }, []);

  const runAgentStep = async () => {
    if (!isProcessingRef.current || !socket || isLocked) return;

    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    watchdogRef.current = setTimeout(() => {
      if (isProcessingRef.current && !isLocked) {
        setIsLocked(false);
        runAgentStep();
      }
    }, 25000);

    const { screenshot, url, title, accessibilityTree } = stateRef.current;
    if (!screenshot) {
      setTimeout(runAgentStep, 1000);
      return;
    }

    setIsLocked(true);
    setIsThinking(true);
    stepCountRef.current += 1;
    setStepCount(stepCountRef.current);
    setStatus(`Pensando (Passo ${stepCountRef.current})...`);

    const systemPrompt = `
      You are an elite autonomous browser agent. Your goal: "${userPromptRef.current}"
      
      CURRENT STEP: ${stepCountRef.current}
      LAST ACTION: ${lastActionRef.current ? JSON.stringify(lastActionRef.current) : 'None'}
      
      CONSOLE LOGS (Last 10):
      ${consoleLogs.slice(-10).map((l) => `[${l.type}] ${l.text}`).join('\n')}

      HUMAN-LIKE REASONING:
      - Think like a human user. Look at the visual cues (colors, icons, layout).
      - PRECISION: When clicking, aim for the EXACT center of the element.
      - SELECTORS: Use selectors (ID, class) whenever possible for 100% accuracy.
      - FORMS: If you need to write, use the 'fill' or 'type' tool with a selector.
      - SEARCH: Use 'find' to locate elements by their semantic role (e.g., 'textbox', 'button').
      - SELF-CORRECTION: If the last action didn't work, EXPLAIN WHY and try a different approach.
      - INFINITE PROGRESSION: Do not stop until the goal is 100% achieved.
      
      Current Context:
      - URL: ${url}
      - Title: ${title}
      - Viewport: Desktop (1280x800)
      
      TOOLS:
      - navigate(url: string)
      - click(x: number, y: number, selector?: string, index?: number)
      - clickByText(text: string)
      - clickBySelector(selector: string)
      - type(x: number, y: number, text: string, clear?: boolean, pressEnter?: boolean, selector?: string, index?: number)
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
      - finish(message: string)
      
      RESPONSE FORMAT (JSON ONLY):
      {
        "thought": "Reasoning for this step.",
        "plan": ["step 1", "step 2", "step 3", "step 4", "step 5"],
        "action": "tool_name",
        "params": { ... }
      }
    `;

    try {
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const response = await fetch('/api/nova', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: systemPrompt },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshot}` } },
                { type: 'text', text: `Accessibility Tree: ${JSON.stringify(accessibilityTree).slice(0, 15000)}` },
              ],
            },
          ],
          response_format: { type: 'json_object' },
        }),
      });

      if (!response.ok) throw new Error('Falha ao chamar a API');
      const data = await response.json();
      const text = data.choices[0].message.content;
      if (!text) throw new Error('Resposta vazia da IA');

      const result = JSON.parse(text);
      if (result.plan) setCurrentPlan(result.plan);

      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          role: 'agent',
          content: '',
          thought: result.thought,
          action: result.action,
          params: result.params,
          stepNumber: stepCountRef.current,
          plan: result.plan,
        },
      ]);

      if (result.action === 'finish') {
        setStatus('Concluído');
        setIsThinking(false);
        setMessages((prev) => [
          ...prev,
          { id: Date.now().toString(), role: 'agent', content: result.params?.message || 'Tarefa concluída' },
        ]);
        isProcessingRef.current = false;
        setIsProcessing(false);
        lastActionRef.current = null;
        setLastClick(null);
      } else {
        setStatus(`Executando ${result.action}...`);
        setIsThinking(false);
        lastActionRef.current = { action: result.action, params: result.params };
        if (['click', 'type', 'hover'].includes(result.action)) {
          setLastClick({ x: result.params.x, y: result.params.y });
        } else {
          setLastClick(null);
        }
        socket.emit('execute-action', { action: result.action, params: result.params });
      }
    } catch (error) {
      setStatus('Erro');
      setIsThinking(false);
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          role: 'agent',
          content: `Erro: ${error instanceof Error ? error.message : 'Erro desconhecido'}`,
        },
      ]);
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
    setMessages((prev) => [...prev, { id: Date.now().toString(), role: 'user', content: prompt }]);
    socket.emit('start-task');
    setPrompt('');
    setTimeout(runAgentStep, 2000);
  };

  const handleStop = () => {
    if (socket) {
      socket.emit('stop-task');
      setIsProcessing(false);
      isProcessingRef.current = false;
      setStatus('Parado');
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
    }
  };

  const handleRetry = () => {
    if (isProcessingRef.current) {
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      setIsLocked(false);
      runAgentStep();
    }
  };

  const handleManualNavigate = () => {
    if (socket && manualUrl) {
      const url = manualUrl.startsWith('http') ? manualUrl : `https://${manualUrl}`;
      setMessages((prev) => [
        ...prev,
        { id: Date.now().toString(), role: 'agent', content: `Navegando para ${url}`, action: 'navigate' },
      ]);
      socket.emit('execute-action', { action: 'navigate', params: { url } });
      setManualUrl('');
    }
  };

  const handleScreenshotClick = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!socket || isProcessing) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 1280;
    const y = ((e.clientY - rect.top) / rect.height) * 800;
    setLastClick({ x, y });
    socket.emit('manual-click', { x, y });
  };

  const handleKeyboardSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (socket && keyboardText && lastClick) {
      socket.emit('execute-action', {
        action: 'type',
        params: { x: lastClick.x, y: lastClick.y, text: keyboardText, pressEnter: true },
      });
      setKeyboardText('');
      keyboardInputRef.current?.blur();
    }
  };

  const statusColor = isProcessing
    ? isThinking
      ? 'text-violet-400'
      : 'text-emerald-400'
    : status === 'Erro'
    ? 'text-red-400'
    : 'text-zinc-400';

  const statusDot = isProcessing
    ? isThinking
      ? 'bg-violet-500'
      : 'bg-emerald-500'
    : status === 'Erro'
    ? 'bg-red-500'
    : 'bg-zinc-600';

  return (
    <div className="flex h-screen bg-[#0d0d0d] text-white font-sans overflow-hidden">

      {/* ─── LEFT: Browser Panel ─── */}
      <div className="flex-1 flex flex-col min-w-0">

        {/* Top Bar */}
        <header className="h-12 flex items-center gap-3 px-4 border-b border-white/8 bg-[#111] shrink-0">
          {/* Logo */}
          <div className="flex items-center gap-2 shrink-0">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-emerald-400 to-emerald-600 flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <Globe className="w-4 h-4 text-black" />
            </div>
            <span className="font-bold text-sm tracking-tight hidden sm:block">OmniBrowser</span>
          </div>

          <div className="w-px h-5 bg-white/10 shrink-0" />

          {/* URL Bar */}
          <div className="flex-1 flex items-center gap-2 min-w-0">
            <div className="flex-1 flex items-center gap-2 bg-white/5 border border-white/8 rounded-lg px-3 h-8 min-w-0">
              <Globe className="w-3 h-3 text-zinc-500 shrink-0" />
              <input
                type="text"
                value={manualUrl}
                onChange={(e) => setManualUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleManualNavigate()}
                placeholder={browserInfo.url || 'Digite uma URL...'}
                className="bg-transparent outline-none text-xs text-zinc-300 w-full font-mono placeholder:text-zinc-600"
              />
            </div>
            <button
              onClick={handleManualNavigate}
              className="h-8 w-8 flex items-center justify-center bg-white/5 hover:bg-white/10 border border-white/8 rounded-lg transition-colors text-emerald-400"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <div className="w-px h-5 bg-white/10 shrink-0" />

          {/* Controls */}
          <div className="flex items-center gap-3 shrink-0">
            {/* Step Badge */}
            {isProcessing && (
              <div className="flex items-center gap-1.5 px-2.5 h-7 bg-emerald-500/10 border border-emerald-500/20 rounded-full">
                <Zap className="w-3 h-3 text-emerald-400" />
                <span className="text-[11px] text-emerald-400 font-bold">Passo {stepCount}</span>
              </div>
            )}

            {/* Auto Toggle */}
            <label className="flex items-center gap-1.5 cursor-pointer">
              <span className="text-[10px] text-zinc-500 font-semibold uppercase tracking-wider">Auto</span>
              <button
                onClick={() => setIsContinuous(!isContinuous)}
                className={`w-8 h-4 rounded-full relative transition-colors ${isContinuous ? 'bg-emerald-500' : 'bg-zinc-700'}`}
              >
                <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-all shadow ${isContinuous ? 'left-[18px]' : 'left-0.5'}`} />
              </button>
            </label>

            {/* Elements Toggle */}
            <label className="flex items-center gap-1.5 cursor-pointer">
              <span className="text-[10px] text-zinc-500 font-semibold uppercase tracking-wider hidden sm:block">Elementos</span>
              <button
                onClick={() => setShowElements(!showElements)}
                className={`w-8 h-4 rounded-full relative transition-colors ${showElements ? 'bg-violet-500' : 'bg-zinc-700'}`}
              >
                <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-all shadow ${showElements ? 'left-[18px]' : 'left-0.5'}`} />
              </button>
            </label>

            {/* Scale */}
            <div className="flex items-center gap-1.5 hidden sm:flex">
              <span className="text-[10px] text-zinc-500 font-semibold uppercase tracking-wider">Zoom</span>
              <input
                type="range"
                min="0.3"
                max="1"
                step="0.05"
                value={previewScale}
                onChange={(e) => setPreviewScale(parseFloat(e.target.value))}
                className="w-16 h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-emerald-500"
              />
            </div>

            {/* Action Buttons */}
            <button
              onClick={() => socket?.emit('execute-action', { action: 'reload' })}
              className="w-8 h-8 flex items-center justify-center hover:bg-white/8 rounded-lg transition-colors text-zinc-500 hover:text-zinc-300"
              title="Recarregar"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => socket?.emit('request-state')}
              className="w-8 h-8 flex items-center justify-center hover:bg-white/8 rounded-lg transition-colors text-zinc-500 hover:text-zinc-300"
              title="Atualizar estado"
            >
              <Activity className="w-3.5 h-3.5" />
            </button>

            {/* Sidebar Toggle */}
            <button
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
              className="w-8 h-8 flex items-center justify-center hover:bg-white/8 rounded-lg transition-colors text-zinc-400 hover:text-zinc-200"
              title="Painel lateral"
            >
              {isSidebarOpen ? <PanelRightClose className="w-4 h-4" /> : <PanelRightOpen className="w-4 h-4" />}
            </button>
          </div>
        </header>

        {/* Browser Viewport */}
        <div className="flex-1 relative overflow-hidden bg-[#080808] flex items-center justify-center">

          {/* Status HUD */}
          <AnimatePresence>
            {isProcessing && (
              <motion.div
                initial={{ y: -10, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: -10, opacity: 0 }}
                className="absolute top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2.5 bg-black/80 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl"
              >
                <div className={`w-2 h-2 rounded-full ${statusDot} ${isThinking ? 'animate-pulse' : ''}`} />
                <span className={`text-xs font-medium ${statusColor}`}>{status}</span>
                <div className="flex gap-1.5 ml-1">
                  {isProcessing && (
                    <button
                      onClick={handleRetry}
                      className="w-6 h-6 flex items-center justify-center hover:bg-white/10 rounded-md transition-colors text-zinc-400"
                      title="Retry"
                    >
                      <RotateCcw className="w-3 h-3" />
                    </button>
                  )}
                  <button
                    onClick={handleStop}
                    className="w-6 h-6 flex items-center justify-center hover:bg-red-500/20 rounded-md transition-colors text-red-400"
                    title="Parar"
                  >
                    <Square className="w-3 h-3 fill-current" />
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Agent Thought Panel */}
          <AnimatePresence>
            {isThinking && messages.length > 0 && messages[messages.length - 1].thought && (
              <motion.div
                initial={{ x: -10, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: -10, opacity: 0 }}
                className="absolute top-4 left-4 z-40 max-w-xs"
              >
                <div className="bg-black/75 backdrop-blur-xl border border-violet-500/20 rounded-xl p-3 shadow-xl">
                  <div className="flex items-center gap-2 mb-2">
                    <Cpu className="w-3 h-3 text-violet-400" />
                    <span className="text-[10px] font-bold text-violet-400 uppercase tracking-wider">Pensando</span>
                  </div>
                  <p className="text-[11px] text-zinc-300 leading-relaxed italic line-clamp-4">
                    {messages[messages.length - 1].thought}
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Plan Panel */}
          <AnimatePresence>
            {currentPlan.length > 0 && isProcessing && (
              <motion.div
                initial={{ x: 10, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: 10, opacity: 0 }}
                className="absolute top-4 right-4 z-40 w-52"
              >
                <div className="bg-black/75 backdrop-blur-xl border border-emerald-500/20 rounded-xl p-3 shadow-xl">
                  <div className="flex items-center gap-2 mb-2">
                    <Zap className="w-3 h-3 text-emerald-400" />
                    <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider">Plano</span>
                  </div>
                  <div className="space-y-1.5">
                    {currentPlan.slice(0, 4).map((step, i) => (
                      <div key={i} className="flex items-start gap-2">
                        <span className="w-4 h-4 rounded bg-emerald-500/15 text-emerald-400 flex items-center justify-center text-[9px] font-bold shrink-0 mt-0.5">
                          {i + 1}
                        </span>
                        <span className="text-[10px] text-zinc-400 leading-snug line-clamp-2">{step}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Manual Type Bar */}
          <div className="absolute bottom-4 left-4 z-40 flex items-center gap-2 bg-black/80 backdrop-blur-xl border border-white/10 rounded-xl px-3 py-2 shadow-xl">
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              <span className="text-[10px] text-zinc-500 font-semibold uppercase tracking-wider">Manual</span>
            </div>
            <input
              ref={keyboardInputRef}
              type="text"
              value={keyboardText}
              onChange={(e) => setKeyboardText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleKeyboardSubmit(e as any)}
              onFocus={() => setIsKeyboardFocused(true)}
              onBlur={() => setIsKeyboardFocused(false)}
              placeholder="Digite aqui..."
              className="bg-transparent outline-none text-xs text-white font-mono placeholder:text-zinc-600 w-32"
            />
            <button
              onClick={() => {
                if (lastClick && socket) {
                  socket.emit('execute-action', {
                    action: 'type',
                    params: { x: lastClick.x, y: lastClick.y, text: keyboardText, pressEnter: true },
                  });
                  setKeyboardText('');
                }
              }}
              className="px-2.5 py-1 bg-emerald-500 text-black text-[10px] font-bold uppercase tracking-wider rounded-lg hover:bg-emerald-400 transition-colors"
            >
              Enviar
            </button>
          </div>

          {/* Screenshot or Placeholder */}
          {screenshot ? (
            <div className="w-full h-full flex items-center justify-center overflow-auto p-6">
              <div
                style={{
                  width: '1280px',
                  height: '800px',
                  transform: `scale(${previewScale})`,
                  transformOrigin: 'center center',
                  transition: 'transform 0.25s ease',
                  flexShrink: 0,
                }}
                className="relative shadow-[0_0_80px_rgba(0,0,0,0.9)] rounded-xl border-[6px] border-[#1c1c1c] bg-white overflow-hidden"
              >
                <img
                  src={screenshot}
                  alt="Browser Preview"
                  onClick={handleScreenshotClick}
                  className="w-full h-full object-cover cursor-crosshair"
                />

                {/* Hidden keyboard form */}
                <form onSubmit={handleKeyboardSubmit} className="absolute opacity-0 pointer-events-none">
                  <input ref={keyboardInputRef} type="text" value={keyboardText}
                    onChange={(e) => setKeyboardText(e.target.value)} />
                </form>

                {/* Elements Overlay */}
                {showElements && browserInfo.accessibilityTree && (
                  <div className="absolute inset-0 pointer-events-none z-40">
                    {(() => {
                      const elements: any[] = [];
                      const flatten = (node: any) => {
                        if (node.w > 0 && node.h > 0) {
                          const isClickable = ['button', 'a', 'input', 'textarea', 'select'].includes(node.tag)
                            || node.role === 'button' || node.role === 'link' || node.index;
                          if (isClickable) elements.push(node);
                        }
                        if (node.children) node.children.forEach(flatten);
                      };
                      flatten(browserInfo.accessibilityTree);
                      return elements.map((el, i) => (
                        <div
                          key={i}
                          className="absolute border border-violet-500/40 bg-violet-500/5"
                          style={{ left: el.x, top: el.y, width: el.w, height: el.h }}
                        >
                          {el.index && (
                            <div className="bg-violet-500 text-white text-[9px] font-bold px-1 rounded-sm absolute top-0 left-0">
                              {el.index}
                            </div>
                          )}
                        </div>
                      ));
                    })()}
                  </div>
                )}

                {/* Click Indicator */}
                {lastClick && (
                  <motion.div
                    key={`${lastClick.x}-${lastClick.y}`}
                    initial={{ scale: 2, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="absolute z-50 pointer-events-none"
                    style={{ left: lastClick.x - 16, top: lastClick.y - 16 }}
                  >
                    <div className="w-8 h-8 border-2 border-emerald-400 rounded-full flex items-center justify-center shadow-[0_0_12px_rgba(52,211,153,0.6)]">
                      <div className="w-1.5 h-1.5 bg-emerald-400 rounded-full" />
                    </div>
                  </motion.div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4 select-none">
              <div className="w-20 h-20 rounded-2xl border border-dashed border-white/10 flex items-center justify-center">
                <Monitor className="w-9 h-9 text-zinc-700" />
              </div>
              <p className="text-xs text-zinc-600 font-mono uppercase tracking-widest">Aguardando navegador...</p>
            </div>
          )}
        </div>
      </div>

      {/* ─── RIGHT: Sidebar ─── */}
      <AnimatePresence>
        {isSidebarOpen && (
          <motion.aside
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 380, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ type: 'spring', damping: 30, stiffness: 250 }}
            className="shrink-0 border-l border-white/8 bg-[#111] flex flex-col overflow-hidden"
          >
            {/* Sidebar Header */}
            <div className="px-4 pt-3 pb-0 shrink-0">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(52,211,153,0.8)]" />
                  <span className="text-xs text-zinc-400 font-medium">
                    {connected ? 'Conectado' : 'Desconectado'}
                  </span>
                  {browserInfo.title && (
                    <>
                      <span className="text-zinc-700">·</span>
                      <span className="text-xs text-zinc-500 truncate max-w-[160px]">{browserInfo.title}</span>
                    </>
                  )}
                </div>
                <button
                  onClick={() => setMessages([])}
                  className="w-7 h-7 flex items-center justify-center hover:bg-white/8 rounded-lg transition-colors text-zinc-600 hover:text-zinc-400"
                  title="Limpar conversa"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Tabs */}
              <div className="flex gap-1 bg-white/5 rounded-lg p-0.5">
                <button
                  onClick={() => setActiveTab('chat')}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-medium transition-all ${
                    activeTab === 'chat'
                      ? 'bg-white/10 text-white shadow-sm'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  <MessageSquare className="w-3 h-3" />
                  Chat
                </button>
                <button
                  onClick={() => setActiveTab('console')}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-medium transition-all ${
                    activeTab === 'console'
                      ? 'bg-white/10 text-white shadow-sm'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  <Terminal className="w-3 h-3" />
                  Console
                  {consoleLogs.length > 0 && (
                    <span className="w-4 h-4 bg-zinc-700 text-zinc-300 rounded-full text-[9px] flex items-center justify-center font-bold">
                      {Math.min(consoleLogs.length, 99)}
                    </span>
                  )}
                </button>
              </div>
            </div>

            {/* Tab Content */}
            <div className="flex-1 overflow-hidden flex flex-col min-h-0">

              {/* ── Chat Tab ── */}
              {activeTab === 'chat' && (
                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-white/10">
                  {messages.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full gap-4 py-16 text-center">
                      <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                        <Globe className="w-7 h-7 text-emerald-500" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-zinc-300 mb-1">Pronto para navegar</p>
                        <p className="text-xs text-zinc-600 max-w-[200px] leading-relaxed">
                          Descreva o que você quer fazer e o agente navegará automaticamente
                        </p>
                      </div>
                    </div>
                  )}

                  {messages.map((msg) => (
                    <motion.div
                      key={msg.id}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    >
                      {msg.role === 'user' ? (
                        <div className="max-w-[80%] bg-emerald-500 text-black px-3.5 py-2.5 rounded-2xl rounded-tr-sm text-sm font-medium shadow-lg shadow-emerald-500/10">
                          {msg.content}
                        </div>
                      ) : (
                        <div className="max-w-[90%] space-y-1.5">
                          {msg.stepNumber && (
                            <div className="flex items-center gap-1.5 px-1">
                              <span className="text-[10px] text-zinc-600 font-mono">#{msg.stepNumber}</span>
                              {msg.action && (
                                <>
                                  <span className="text-zinc-700">·</span>
                                  <span className="text-[10px] text-violet-400 font-mono">{msg.action}</span>
                                </>
                              )}
                            </div>
                          )}
                          {msg.thought && (
                            <div className="bg-zinc-900 border border-white/6 rounded-2xl rounded-tl-sm px-3.5 py-2.5">
                              <p className="text-[11px] text-zinc-400 leading-relaxed italic">{msg.thought}</p>
                            </div>
                          )}
                          {msg.content && (
                            <div className="bg-zinc-900 border border-white/6 rounded-2xl rounded-tl-sm px-3.5 py-2.5">
                              <p className="text-sm text-zinc-200 leading-relaxed">{msg.content}</p>
                            </div>
                          )}
                          {msg.plan && msg.plan.length > 0 && (
                            <div className="bg-zinc-900/50 border border-emerald-500/10 rounded-xl px-3 py-2.5">
                              <p className="text-[10px] font-bold text-emerald-500 uppercase tracking-wider mb-1.5">Plano</p>
                              <div className="space-y-1">
                                {msg.plan.slice(0, 3).map((step, i) => (
                                  <div key={i} className="flex items-start gap-2">
                                    <span className="text-[9px] text-emerald-600 font-bold mt-0.5">{i + 1}.</span>
                                    <span className="text-[11px] text-zinc-500 leading-snug">{step}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </motion.div>
                  ))}

                  {/* Thinking Indicator */}
                  {isThinking && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="flex justify-start"
                    >
                      <div className="flex items-center gap-1.5 bg-zinc-900 border border-white/6 rounded-2xl rounded-tl-sm px-4 py-3">
                        {[0, 1, 2].map((i) => (
                          <motion.div
                            key={i}
                            className="w-1.5 h-1.5 rounded-full bg-zinc-500"
                            animate={{ y: [0, -4, 0] }}
                            transition={{ duration: 0.6, delay: i * 0.15, repeat: Infinity }}
                          />
                        ))}
                      </div>
                    </motion.div>
                  )}

                  <div ref={chatEndRef} />
                </div>
              )}

              {/* ── Console Tab ── */}
              {activeTab === 'console' && (
                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1.5 font-mono scrollbar-thin scrollbar-track-transparent scrollbar-thumb-white/10">
                  {lastHtml && (
                    <div className="mb-3 p-3 bg-zinc-900 border border-white/6 rounded-xl">
                      <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-2">HTML Capturado</p>
                      <pre className="text-[10px] text-zinc-400 leading-relaxed whitespace-pre-wrap break-all line-clamp-20">
                        {lastHtml}
                      </pre>
                    </div>
                  )}
                  {consoleLogs.length === 0 && !lastHtml && (
                    <div className="flex flex-col items-center justify-center h-full gap-3 py-16 opacity-40">
                      <Terminal className="w-10 h-10 text-zinc-700" />
                      <p className="text-xs text-zinc-600 font-mono">Sem logs ainda</p>
                    </div>
                  )}
                  {consoleLogs.map((log, i) => (
                    <div
                      key={i}
                      className={`flex gap-2 p-2 rounded-lg text-[10px] border ${
                        log.type === 'error'
                          ? 'bg-red-500/5 border-red-500/10 text-red-400'
                          : log.type === 'warn'
                          ? 'bg-yellow-500/5 border-yellow-500/10 text-yellow-400'
                          : 'bg-white/3 border-white/5 text-zinc-500'
                      }`}
                    >
                      <span className="text-zinc-700 shrink-0">{new Date(log.time).toLocaleTimeString()}</span>
                      <span className="break-all leading-relaxed">{log.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Input Area */}
            <div className="px-4 pb-4 pt-3 border-t border-white/8 shrink-0">
              {/* Status Bar */}
              <div className="flex items-center gap-2 mb-2.5 px-1">
                <div className={`w-1.5 h-1.5 rounded-full ${statusDot} ${isProcessing ? 'animate-pulse' : ''}`} />
                <span className={`text-[11px] font-medium ${statusColor} truncate`}>{status}</span>
                {isProcessing && (
                  <button
                    onClick={handleStop}
                    className="ml-auto flex items-center gap-1 px-2 py-0.5 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 rounded-full text-red-400 text-[10px] font-medium transition-colors"
                  >
                    <Square className="w-2.5 h-2.5 fill-current" />
                    Parar
                  </button>
                )}
              </div>

              {/* Text Input */}
              <div className="flex gap-2 items-end">
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleStart();
                    }
                  }}
                  placeholder="Descreva o que fazer..."
                  rows={2}
                  disabled={isProcessing}
                  className="flex-1 bg-white/5 border border-white/8 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-emerald-500/40 resize-none transition-colors disabled:opacity-40"
                />
                <button
                  onClick={handleStart}
                  disabled={isProcessing || !prompt.trim()}
                  className="w-10 h-10 shrink-0 flex items-center justify-center bg-emerald-500 hover:bg-emerald-400 disabled:bg-zinc-800 disabled:text-zinc-600 text-black rounded-xl transition-colors shadow-lg shadow-emerald-500/20 disabled:shadow-none"
                >
                  {isProcessing ? (
                    <motion.div
                      animate={{ rotate: 360 }}
                      transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                    >
                      <RefreshCw className="w-4 h-4" />
                    </motion.div>
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                </button>
              </div>

              <p className="text-[10px] text-zinc-700 mt-2 text-center">
                Enter para enviar · Shift+Enter para nova linha
              </p>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  );
}
