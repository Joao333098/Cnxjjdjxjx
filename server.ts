import express from "express";
import { createServer as createViteServer } from "vite";
import { Server } from "socket.io";
import http from "http";
import cors from "cors";
import path from "path";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { Browser, Page } from "playwright-chromium";
import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import OpenAI from "openai";

function loadConfig() {
  try {
    const raw = readFileSync(new URL('./config.json', import.meta.url), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const appConfig = loadConfig();

function findSystemChromium(): string | undefined {
  try {
    const p = execSync('which chromium || which chromium-browser || which google-chrome', { encoding: 'utf8' }).trim().split('\n')[0].trim();
    if (p) return p;
  } catch {}
  return undefined;
}

chromium.use(stealth());

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

const PORT = parseInt(process.env.PORT || "5000", 10);

// AI Setup removed from backend - Gemini must be called from frontend

async function startServer() {
  let browser: Browser | null = null;
  let page: Page | null = null;

  app.use(cors());
  app.use(express.json({ limit: '20mb' }));
  
  let activePage: Page | null = null;
  let browserContext: any = null;

  // API routes
  app.post("/api/nova", async (req, res) => {
    const { messages } = req.body;
    try {
      const apiKey = appConfig.nova_api_key || process.env.VITE_NOVA_API_KEY;
      if (!apiKey) throw new Error("API Key missing");

      const isOpenRouter = apiKey.startsWith('sk-or-');
      const baseURL = isOpenRouter ? 'https://openrouter.ai/api/v1' : 'https://api.nova.amazon.com/v1';
      const defaultModel = isOpenRouter ? 'amazon/nova-pro-v1' : (appConfig.nova_model || 'nova-pro-v1');
      const modelName = defaultModel;

      // Make raw fetch so we can inspect the actual response body on errors
      const rawResponse = await fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: modelName, messages, max_tokens: 8192 }),
      });

      if (!rawResponse.ok) {
        const errorText = await rawResponse.text().catch(() => "(unreadable body)");
        console.error(`Nova API ${rawResponse.status} error body:`, errorText);
        throw new Error(`Nova API ${rawResponse.status}: ${errorText || rawResponse.statusText}`);
      }

      const data = await rawResponse.json();
      res.json(data);
    } catch (error: any) {
      console.error("Nova API error:", error.message);
      res.status(500).json({ error: error.message || "Failed to call Nova API" });
    }
  });

  // Vite middleware
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { 
        middlewareMode: true,
        host: '0.0.0.0',
        allowedHosts: true,
      },
      watch: {
        ignored: (filePath: string) =>
          filePath.includes('/.local/') ||
          filePath.includes('/node_modules/') ||
          filePath.includes('/.git/'),
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Socket.io logic
  io.on("connection", (socket) => {
    console.log("Client connected");

    const stopFlags = new Map<string, boolean>();

    socket.on("start-task", async () => {
      try {
        if (!browser) {
          const systemChromium = findSystemChromium();
          const launchOptions: any = { 
            headless: true,
            args: [
              '--disable-blink-features=AutomationControlled',
              '--disable-features=IsolateOrigins,site-per-process',
              '--no-sandbox',
              '--disable-setuid-sandbox'
            ]
          };
          if (systemChromium) {
            launchOptions.executablePath = systemChromium;
            console.log(`Using system Chromium: ${systemChromium}`);
          }
          browser = await chromium.launch(launchOptions);
          browserContext = await browser.newContext({
            viewport: { width: 1280, height: 800 },
            deviceScaleFactor: 1,
            isMobile: false,
            hasTouch: false,
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          });
          
          browserContext.on('page', (newPage: Page) => {
            console.log('New page/popup detected');
            activePage = newPage;
            
            // Listen for close to switch back if needed
            newPage.on('close', () => {
              const pages = browserContext.pages();
              if (pages.length > 0) {
                activePage = pages[pages.length - 1];
              }
            });

            // Trigger update when new page is ready
            setTimeout(async () => {
              if (activePage) {
                const state = await capturePageState(activePage);
                socket.emit("browser-update", { ...state, isPopup: true });
              }
            }, 2000);
          });

          page = await browserContext.newPage();
          activePage = page;

          // Capture console logs
          browserContext.on('console', (msg: any) => {
            const log = {
              type: msg.type(),
              text: msg.text(),
              location: msg.location()
            };
            socket.emit('console-log', log);
          });

          // Capture page errors
          browserContext.on('pageerror', (err: any) => {
            socket.emit('console-log', { type: 'error', text: err.message });
          });
        }

        if (!activePage) return;

        socket.emit("agent-status", { message: "Browser ready. Waiting for instructions..." });
        
        // Initial state capture
        const state = await capturePageState(activePage);
        socket.emit("browser-update", state);
      } catch (error) {
        console.error("Error starting browser:", error);
        socket.emit("agent-error", { message: String(error) });
      }
    });

    socket.on("request-state", async () => {
      if (activePage) {
        const state = await capturePageState(activePage);
        socket.emit("browser-update", state);
      }
    });

    socket.on("execute-action", async ({ action, params }) => {
      if (activePage) {
        try {
          console.log(`Executing action: ${action}`, params);
          const result = await executeAction(activePage, action, params);
          
          // Wait for page to settle
          try {
            await activePage.waitForLoadState("load", { timeout: 3000 });
            await activePage.waitForLoadState("networkidle", { timeout: 3000 });
          } catch (e) {
            // Ignore timeout errors during wait
          }
          await activePage.waitForTimeout(200);
          
          // Send back new state
          const state = await capturePageState(activePage);
          socket.emit("browser-update", state);

          if (result) {
            socket.emit("action-result", { action, result });
          }
        } catch (error) {
          console.error("Action execution failed:", error);
          socket.emit("agent-error", { message: `Action ${action} failed: ${String(error)}` });
        } finally {
          socket.emit("action-completed", { action });
        }
      } else {
        socket.emit("agent-error", { message: "Browser not initialized. Start a task first." });
      }
    });

    socket.on("manual-click", async ({ x, y }) => {
      if (activePage) {
        try {
          const clickX = Math.round(x);
          const clickY = Math.round(y);
          
          // Perform the actual click
          await activePage.mouse.click(clickX, clickY);
          
          // JS Fallback for manual clicks too
          await activePage.waitForTimeout(100);
          await activePage.evaluate(`(function(x, y) {
            const getInteractiveElement = (x, y) => {
              const el = document.elementFromPoint(x, y);
              if (!el) return null;
              
              // Try to find the closest interactive element
              const interactive = el.closest('input, textarea, [contenteditable="true"], select, button, a, [role="button"], [role="link"]');
              if (interactive instanceof HTMLElement) return interactive;
              
              // If not found, search in a small radius (5px)
              const radius = 5;
              for (let dx = -radius; dx <= radius; dx += 2) {
                for (let dy = -radius; dy <= radius; dy += 2) {
                  const nearEl = document.elementFromPoint(x + dx, y + dy);
                  const nearInteractive = nearEl?.closest('input, textarea, [contenteditable="true"], select, button, a, [role="button"], [role="link"]');
                  if (nearInteractive instanceof HTMLElement) return nearInteractive;
                }
              }
              return el instanceof HTMLElement ? el : null;
            };

            const target = getInteractiveElement(x, y);
            if (target) {
              target.focus();
              target.click();
            }
          })(${clickX}, ${clickY})`);

          // Trigger a screenshot update immediately with lower quality for speed
          const screenshot = await activePage.screenshot({ type: "jpeg", quality: 40 });
          socket.emit("browser-update", {
            screenshot: screenshot.toString("base64"),
            url: activePage.url(),
            title: await activePage.title(),
          });
        } catch (e) {
          console.error("Manual click failed:", e);
        }
      }
    });

    socket.on("execute-cli-command", async (command: string) => {
      if (!activePage) {
        socket.emit("agent-error", { message: "Browser not initialized." });
        return;
      }
      
      try {
        console.log(`Executing CLI command: ${command}`);
        const parts = command.split(' ');
        if (parts[0] !== 'agent-browser') return;
        
        const action = parts[1];
        let result;

        switch (action) {
          case 'navigate':
          case 'open':
            result = await executeAction(activePage, 'navigate', { url: parts[2] });
            break;
          case 'click':
            result = await executeAction(activePage, 'click', { selector: parts[2] });
            break;
          case 'type':
            result = await executeAction(activePage, 'type', { selector: parts[2], text: parts.slice(3).join(' ') });
            break;
          case 'get':
            if (parts[2] === 'title') {
              const title = await activePage.title();
              socket.emit("action-result", { action: 'get title', result: title });
              return;
            }
            break;
          default:
            socket.emit("agent-error", { message: `Command ${action} not implemented yet.` });
            return;
        }

        const state = await capturePageState(activePage);
        socket.emit("browser-update", state);
        if (result) socket.emit("action-result", { action, result });
      } catch (error) {
        socket.emit("agent-error", { message: `Command failed: ${String(error)}` });
      }
    });

    socket.on("stop-task", () => {
      stopFlags.set(socket.id, true);
      console.log("Stop task requested for", socket.id);
    });

    socket.on("disconnect", () => {
      stopFlags.delete(socket.id);
      console.log("Client disconnected");
    });
  });

  // Kill any existing processes on this port before binding
  try { execSync(`fuser -k ${PORT}/tcp 24678/tcp 2>/dev/null || true`); } catch (_) {}
  await new Promise(r => setTimeout(r, 500));

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Exiting so the process manager can restart cleanly.`);
      process.exit(1);
    } else {
      console.error('Server error:', err);
      process.exit(1);
    }
  });
}

async function capturePageState(page: Page) {
  if (page.isClosed()) {
    return { screenshot: "", url: "", title: "Page Closed", accessibilityTree: [] };
  }

  let base64Screenshot = "";
  try {
    const screenshot = await page.screenshot({ type: "jpeg", quality: 50, timeout: 5000 });
    base64Screenshot = screenshot.toString("base64");
  } catch (error) {
    console.error("Failed to capture screenshot, retrying...", error instanceof Error ? error.message : error);
    try {
      await page.waitForTimeout(1000);
      const screenshot = await page.screenshot({ type: "jpeg", quality: 50, timeout: 5000 });
      base64Screenshot = screenshot.toString("base64");
    } catch (retryError) {
      console.error("Retry failed to capture screenshot:", retryError instanceof Error ? retryError.message : retryError);
    }
  }

  let url = "";
  let title = "";
  try {
    url = page.url();
    title = await page.title();
  } catch (e) {
    console.error("Failed to get url/title:", e);
  }

  let accessibilityTree = [];
  try {
    accessibilityTree = await page.evaluate(`(() => {
    const isInteractive = (node) => {
      const tag = node.tagName.toLowerCase();
      const role = node.getAttribute("role");
      const hasClick = node.onclick || node.getAttribute("onclick");
      const isFocusable = node.tabIndex >= 0;
      return ["button", "a", "input", "textarea", "select", "details", "summary"].includes(tag) || 
             ["button", "link", "checkbox", "menuitem", "option", "textbox"].includes(role) ||
             hasClick || isFocusable;
    };

    const hasText = (node) => {
      return node.childNodes.length === 1 && node.childNodes[0].nodeType === 3 && node.childNodes[0].textContent.trim().length > 0;
    };

    let elementIndex = 0;
    const walk = (node, depth = 0) => {
      if (depth > 20) return null;
      const rect = node.getBoundingClientRect();
      const tag = node.tagName ? node.tagName.toLowerCase() : '';
      const isInputLike = ['input', 'textarea', 'select', 'button'].includes(tag);
      // Skip zero-size non-interactive containers, but always keep input-like elements
      if ((rect.width === 0 || rect.height === 0) && !isInputLike) return null;

      const interactive = isInteractive(node);
      const textNode = hasText(node);
      
      // Only include if interactive, has direct text, or is a container for something interesting
      let children = [];
      if (node.children) {
        children = Array.from(node.children)
          .map(c => walk(c, depth + 1))
          .filter(c => c !== null);
      }

      if (!interactive && !textNode && children.length === 0) return null;

      const info = {
        tag: node.tagName.toLowerCase(),
        text: node.innerText?.slice(0, 100).trim() || undefined,
        role: node.getAttribute("role") || undefined,
        ariaLabel: node.getAttribute("aria-label") || undefined,
        placeholder: node.placeholder || undefined,
        id: node.id || undefined,
        name: node.getAttribute("name") || undefined,
        className: node.className?.slice(0, 50) || undefined,
        href: node.getAttribute("href") || undefined,
        title: node.getAttribute("title") || undefined,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      };

      if (interactive) {
        info.index = ++elementIndex;
        node.setAttribute('data-agent-index', info.index);
      }

      if (node.tagName === "INPUT" || node.tagName === "TEXTAREA" || node.tagName === "SELECT") {
        info.value = node.value;
        info.type = node.type;
      }

      if (children.length > 0) info.children = children;
      return info;
    };
    return walk(document.body);
  })()`);
  } catch (e) {
    console.error("Failed to evaluate accessibility tree:", e);
  }

  return {
    screenshot: base64Screenshot,
    url,
    title,
    accessibilityTree,
  };
}

// runAgentLoop removed - logic moved to frontend

async function executeAction(page: Page, action: string, params: any) {
  console.log(`Executing ${action} with params:`, params);
  
  try {
    // Ensure viewport is consistent with the agent's view (Desktop size)
    await page.setViewportSize({ width: 1280, height: 800 });
    
    switch (action) {
      case "navigate":
        let url = params.url;
        if (!url) throw new Error("URL is required for navigate action");
        if (!url.startsWith('http')) url = 'https://' + url;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(500); // Extra settling time
        break;
      case "clickAt":
        if (typeof params.x !== 'number' || typeof params.y !== 'number') {
          throw new Error("Invalid coordinates for clickAt");
        }
        const clickAtX = Math.max(0, params.x);
        const clickAtY = Math.max(0, params.y);
        
        // Move mouse first to trigger hover effects
        await page.mouse.move(clickAtX, clickAtY);
        await page.waitForTimeout(100);
        
        // Perform the actual click
        await page.mouse.click(clickAtX, clickAtY);
        
        // JS Fallback
        await page.waitForTimeout(100);
        const clickAtResult = await page.evaluate(`(function(x, y) {
          var sel = 'input, textarea, [contenteditable="true"], select, button, a, [role="button"], [role="link"]';
          var el = document.elementFromPoint(x, y);
          if (!el) return { success: false, reason: 'no element at coordinates' };
          var target = el.closest(sel);
          if (!target) {
            for (var dx = -5; dx <= 5; dx += 2) {
              for (var dy = -5; dy <= 5; dy += 2) {
                var near = document.elementFromPoint(x+dx, y+dy);
                if (near) { target = near.closest(sel); if (target) break; }
              }
              if (target) break;
            }
          }
          if (!target) target = el;
          if (target) { target.focus(); target.click(); return { success: true, tag: target.tagName.toLowerCase(), id: target.id }; }
          return { success: false, reason: 'no interactive element found at coordinates' };
        })(${clickAtX}, ${clickAtY})`);
        try { await page.waitForLoadState('domcontentloaded', { timeout: 5000 }); } catch (_) {}
        return clickAtResult;
      case "click":
        if (params.index !== undefined) {
          // Step 1: find element coords via JS
          const indexResult = await page.evaluate(`(function(index) {
            var target = document.querySelector('[data-agent-index="' + index + '"]');
            if (target) {
              target.scrollIntoView({ behavior: 'smooth', block: 'center' });
              var style = window.getComputedStyle(target);
              if (style.display === 'none' || style.visibility === 'hidden') return { success: false, reason: 'hidden' };
              var rect = target.getBoundingClientRect();
              return { success: true, tag: target.tagName.toLowerCase(), id: target.id, x: rect.x + rect.width/2, y: rect.y + rect.height/2 };
            }
            return { success: false, reason: 'not found' };
          })(${JSON.stringify(params.index)})`);
          if (indexResult && indexResult.success && typeof indexResult.x === 'number') {
            // Step 2: real Playwright mouse click at element center
            await page.mouse.move(indexResult.x, indexResult.y);
            await page.waitForTimeout(80);
            await page.mouse.click(indexResult.x, indexResult.y);
          } else {
            // Fallback: JS click
            await page.evaluate(`(function(index) {
              var t = document.querySelector('[data-agent-index="' + index + '"]');
              if (t) { t.focus(); t.click(); }
            })(${JSON.stringify(params.index)})`);
          }
          // Wait for any navigation triggered by the click
          try { await page.waitForLoadState('domcontentloaded', { timeout: 5000 }); } catch (_) {}
          return indexResult;
        }
        if (params.selector) {
          await page.click(params.selector, { timeout: 5000 });
          try { await page.waitForLoadState('domcontentloaded', { timeout: 5000 }); } catch (_) {}
          return { success: true, selector: params.selector };
        }
        if (typeof params.x !== 'number' || typeof params.y !== 'number') {
          throw new Error("Invalid coordinates for click");
        }
        const clickX = Math.max(0, params.x);
        const clickY = Math.max(0, params.y);
        
        // Move mouse first to trigger hover effects
        await page.mouse.move(clickX, clickY);
        await page.waitForTimeout(100);
        
        // Perform the actual click
        await page.mouse.click(clickX, clickY);
        
        // JS Fallback: If it's a focusable element, ensure it's focused and clicked
        await page.waitForTimeout(100);
        const clickResult = await page.evaluate(`(function(x, y) {
          var el = document.elementFromPoint(x, y);
          if (!el) return null;
          var sel = 'input, textarea, [contenteditable="true"], select, button, a, [role="button"], [role="link"]';
          var target = el.closest(sel);
          if (!target) {
            for (var dx = -15; dx <= 15; dx += 3) {
              for (var dy = -15; dy <= 15; dy += 3) {
                var near = document.elementFromPoint(x + dx, y + dy);
                if (near) { target = near.closest(sel); if (target) break; }
              }
              if (target) break;
            }
          }
          if (!target) target = el;
          if (target) {
            target.focus();
            target.click();
            return { tag: target.tagName.toLowerCase(), id: target.id, className: target.className, text: (target.innerText||'').slice(0,50), role: target.getAttribute('role') };
          }
          return null;
        })(${clickX}, ${clickY})`);
        // Wait for any navigation triggered by the click
        try { await page.waitForLoadState('domcontentloaded', { timeout: 5000 }); } catch (_) {}
        return { element: clickResult };
      case "clickByText":
        if (!params.text) throw new Error("Text is required for clickByText");
        const textResult = await page.evaluate(`(function(text) {
          var els = Array.from(document.querySelectorAll('button, a, [role="button"], [role="link"], input[type="button"], input[type="submit"]'));
          var target = els.find(function(el) { return (el.textContent||'').trim().toLowerCase().includes(text.toLowerCase()); });
          if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            target.focus();
            target.click();
            var rect = target.getBoundingClientRect();
            return { success: true, tag: target.tagName.toLowerCase(), id: target.id, x: rect.x + rect.width/2, y: rect.y + rect.height/2 };
          }
          return { success: false };
        })(${JSON.stringify(params.text)})`);
        try { await page.waitForLoadState('domcontentloaded', { timeout: 5000 }); } catch (_) {}
        return textResult;
      case "clickBySelector":
        if (!params.selector) throw new Error("Selector is required for clickBySelector");
        const selectorResult = await page.evaluate(`(function(selector) {
          const target = document.querySelector(selector);
          if (target instanceof HTMLElement) {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            target.focus();
            target.click();
            const rect = target.getBoundingClientRect();
            return {
              success: true,
              tag: target.tagName.toLowerCase(),
              id: target.id,
              x: rect.x + rect.width / 2,
              y: rect.y + rect.height / 2
            };
          }
          return { success: false };
        })(${JSON.stringify(params.selector)})`);
        return selectorResult;
      case "doubleClick":
        if (typeof params.x !== 'number' || typeof params.y !== 'number') {
          throw new Error("Invalid coordinates for doubleClick");
        }
        await page.mouse.move(params.x, params.y);
        await page.mouse.dblclick(params.x, params.y);
        break;
      case "rightClick":
        if (typeof params.x !== 'number' || typeof params.y !== 'number') {
          throw new Error("Invalid coordinates for rightClick");
        }
        await page.mouse.move(params.x, params.y);
        await page.mouse.click(params.x, params.y, { button: 'right' });
        break;
      case "typeAt": {
        if (typeof params.x !== 'number' || typeof params.y !== 'number') {
          throw new Error("Invalid coordinates for typeAt");
        }
        const typeAtX = Math.max(0, params.x);
        const typeAtY = Math.max(0, params.y);
        let taTyped = false;

        // Strategy 1: Search all frames for an input at the given viewport coordinates
        const allFrames = [page, ...page.frames()];
        for (const frame of allFrames) {
          try {
            // For iframes, translate viewport coords to frame-relative coords
            let fX = typeAtX, fY = typeAtY;
            if (frame !== (page as any)) {
              const frameEl = await (frame as any).frameElement();
              if (!frameEl) continue;
              const box = await frameEl.boundingBox();
              if (!box) continue;
              fX = typeAtX - box.x;
              fY = typeAtY - box.y;
              if (fX < 0 || fY < 0 || fX > box.width || fY > box.height) continue;
            }

            // Find input/textarea at these coordinates inside this frame
            const found = await frame.evaluate(([x, y]: [number, number]) => {
              const el = document.elementFromPoint(x, y) as HTMLElement | null;
              if (!el) return false;
              const target = (el.closest('input, textarea, [contenteditable="true"]') || el) as HTMLInputElement;
              if (!target) return false;
              const tag = target.tagName;
              if (!['INPUT', 'TEXTAREA'].includes(tag) && target.contentEditable !== 'true') return false;
              // Focus + clear
              target.focus();
              if ('value' in target) (target as HTMLInputElement).value = '';
              return true;
            }, [fX, fY] as [number, number]);

            if (found) {
              await page.waitForTimeout(150);
              await frame.evaluate(([x, y]: [number, number]) => {
                const el = document.elementFromPoint(x, y) as HTMLInputElement | null;
                if (el) { el.focus(); el.click(); }
              }, [fX, fY] as [number, number]);
              await page.waitForTimeout(150);
              await page.keyboard.type(params.text || '', { delay: 45 });
              taTyped = true;
              break;
            }
          } catch (_) { /* try next frame */ }
        }

        // Strategy 2: Plain mouse click + keyboard type (works for simple pages)
        if (!taTyped) {
          await page.mouse.move(typeAtX, typeAtY);
          await page.waitForTimeout(100);
          await page.mouse.click(typeAtX, typeAtY);
          await page.waitForTimeout(350);
          await page.mouse.click(typeAtX, typeAtY);
          await page.waitForTimeout(200);
          await page.keyboard.type(params.text || '', { delay: 45 });
          taTyped = true;
        }

        if (params.pressEnter) await page.keyboard.press('Enter');

        // Verify the text actually landed in some input field across all frames
        await page.waitForTimeout(200);
        const typedText = (params.text || '').trim();
        let verifiedValue = '';
        if (typedText.length > 0) {
          for (const f of [page, ...page.frames()]) {
            try {
              const snippet = typedText.substring(0, Math.min(4, typedText.length));
              const val = await f.evaluate((snip: string) => {
                const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea'));
                const match = inputs.find((el: any) => el.value && el.value.includes(snip));
                return match ? (match as any).value : '';
              }, snippet);
              if (val) { verifiedValue = val; break; }
            } catch (_) {}
          }
        }
        return { success: true, verified: verifiedValue.length > 0, fieldValue: verifiedValue };
      }
      case "forceTypeAt": {
        // Force-type by directly injecting value via JavaScript (bypasses focus/iframe issues)
        if (typeof params.x !== 'number' || typeof params.y !== 'number') {
          throw new Error("Invalid coordinates for forceTypeAt");
        }
        const ftX = params.x, ftY = params.y;
        const ftText = params.text || '';
        let ftDone = false;

        for (const frame of [page, ...page.frames()]) {
          try {
            let fX = ftX, fY = ftY;
            if (frame !== (page as any)) {
              const frameEl = await (frame as any).frameElement();
              if (!frameEl) continue;
              const box = await frameEl.boundingBox();
              if (!box) continue;
              fX = ftX - box.x; fY = ftY - box.y;
              if (fX < 0 || fY < 0 || fX > box.width || fY > box.height) continue;
            }
            const success = await frame.evaluate(([x, y, text]: [number, number, string]) => {
              const el = document.elementFromPoint(x, y) as HTMLElement | null;
              if (!el) return false;
              const target = (el.closest('input:not([type="hidden"]), textarea, [contenteditable="true"]') || el) as HTMLInputElement;
              if (!target) return false;
              const tag = target.tagName;
              if (!['INPUT', 'TEXTAREA'].includes(tag) && target.contentEditable !== 'true') return false;
              target.focus();
              target.click();
              // Use native value setter to bypass React controlled inputs
              const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
                || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
              if (nativeSetter) {
                nativeSetter.call(target, text);
              } else {
                (target as HTMLInputElement).value = text;
              }
              target.dispatchEvent(new Event('input', { bubbles: true }));
              target.dispatchEvent(new Event('change', { bubbles: true }));
              target.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: text.slice(-1) }));
              return true;
            }, [fX, fY, ftText] as [number, number, string]);
            if (success) { ftDone = true; break; }
          } catch (_) {}
        }

        // Verify it landed
        let ftVerified = false;
        if (ftDone && ftText.length > 0) {
          await page.waitForTimeout(150);
          const snip = ftText.substring(0, Math.min(4, ftText.length));
          for (const f of [page, ...page.frames()]) {
            try {
              const val = await f.evaluate((s: string) => {
                const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea'));
                const match = inputs.find((el: any) => el.value && el.value.includes(s));
                return match ? (match as any).value : '';
              }, snip);
              if (val) { ftVerified = true; break; }
            } catch (_) {}
          }
        }
        return { success: ftDone, verified: ftVerified };
      }
      case "type":
        if (params.index !== undefined) {
          const targetInfo = await page.evaluate(`(function(index) {
            var target = document.querySelector('[data-agent-index="' + index + '"]');
            if (target) {
              target.scrollIntoView({ behavior: 'smooth', block: 'center' });
              target.focus();
              if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') target.select();
              var rect = target.getBoundingClientRect();
              return { success: true, x: rect.x + rect.width/2, y: rect.y + rect.height/2 };
            }
            return { success: false };
          })(${JSON.stringify(params.index)})`);
          if (targetInfo.success) {
            if (params.clear) {
              await page.keyboard.down('Control');
              await page.keyboard.press('a');
              await page.keyboard.up('Control');
              await page.keyboard.press('Backspace');
            }
            await page.keyboard.type(params.text || "", { delay: 50 });
            if (params.pressEnter) {
              await page.waitForTimeout(300);
              await page.keyboard.press("Enter");
            }
            return targetInfo;
          }
          return { success: false, reason: 'Index not found' };
        }
        if (params.selector) {
          if (params.clear) await page.fill(params.selector, "");
          await page.type(params.selector, params.text || "", { delay: 30 });
          if (params.pressEnter) await page.keyboard.press("Enter");
          return { success: true, selector: params.selector };
        }
        if (typeof params.x !== 'number' || typeof params.y !== 'number') {
          if (params.text !== undefined) {
            if (params.clear) {
              await page.keyboard.down('Control');
              await page.keyboard.press('a');
              await page.keyboard.up('Control');
              await page.keyboard.press('Backspace');
            }
            await page.keyboard.type(params.text || "", { delay: 50 });
            if (params.pressEnter) {
              await page.waitForTimeout(300);
              await page.keyboard.press("Enter");
            }
            return { success: true };
          }
          throw new Error("Invalid coordinates for type");
        }
        const typeX = Math.max(0, params.x);
        const typeY = Math.max(0, params.y);

        // Click to focus first
        await page.mouse.click(typeX, typeY);
        await page.waitForTimeout(200);
        
        // JS Fallback for focus
        await page.evaluate(`(function(x, y) {
          var sel = 'input, textarea, [contenteditable="true"]';
          var el = document.elementFromPoint(x, y);
          if (!el) return;
          var target = el.closest(sel);
          if (!target) {
            for (var dx = -10; dx <= 10; dx += 2) {
              for (var dy = -10; dy <= 10; dy += 2) {
                var near = document.elementFromPoint(x+dx, y+dy);
                if (near) { target = near.closest(sel); if (target) break; }
              }
              if (target) break;
            }
          }
          if (!target) target = el;
          if (target) { target.focus(); if (target.tagName==='INPUT'||target.tagName==='TEXTAREA') target.select(); }
        })(${typeX}, ${typeY})`);

        await page.waitForTimeout(200);
        
        // Clear field if requested
        if (params.clear) {
          await page.keyboard.down('Control');
          await page.keyboard.press('a');
          await page.keyboard.up('Control');
          await page.keyboard.press('Backspace');
        }
        await page.keyboard.type(params.text || "", { delay: 50 });
        if (params.pressEnter) {
          await page.waitForTimeout(300);
          await page.keyboard.press("Enter");
        }
        break;
      case "typeBySelector": {
        if (!params.selector) throw new Error("selector required for typeBySelector");
        // Build candidate selector list: original + smart fallbacks
        const tbsCandidates: string[] = [params.selector];
        const tbsSel = params.selector.toLowerCase();
        if (tbsSel.includes('password')) {
          tbsCandidates.push('input[type="password"]', 'input[autocomplete*="password"]', 'input[autocomplete="current-password"]');
        }
        if (tbsSel.includes('email') || tbsSel.includes('username') || tbsSel.includes('user') || tbsSel.includes('identifier')) {
          tbsCandidates.push('input[type="email"]', 'input[name="email"]', 'input[name="username"]', 'input[name="identifier"]');
        }
        const tbsUniq = [...new Set(tbsCandidates)];

        // Retry up to 3 times with increasing wait — handles page transitions after click
        let tbsTyped = false;
        const tbsAttempts = [0, 1500, 3000]; // ms to wait before each attempt
        for (const tbsWait of tbsAttempts) {
          if (tbsWait > 0) {
            // Wait for page to settle after navigation
            try { await page.waitForLoadState('domcontentloaded', { timeout: tbsWait }); } catch (_) {}
            await page.waitForTimeout(tbsWait > 1000 ? 500 : 200);
          }
          const tbsFrames: any[] = [page, ...page.frames()];
          outer: for (const tbsCandidate of tbsUniq) {
            for (const tbsFrame of tbsFrames) {
              try {
                const tbsEl = tbsFrame.locator(tbsCandidate).first();
                await tbsEl.waitFor({ state: 'attached', timeout: 1500 });
                await tbsEl.scrollIntoViewIfNeeded({ timeout: 1500 });
                await tbsEl.click({ force: true, timeout: 1500 });
                await page.waitForTimeout(150);
                if (params.clear !== false) {
                  await page.keyboard.down('Control');
                  await page.keyboard.press('a');
                  await page.keyboard.up('Control');
                  await page.keyboard.press('Backspace');
                }
                await page.keyboard.type(params.text || "", { delay: 40 });
                if (params.pressEnter) await page.keyboard.press('Enter');
                tbsTyped = true;
                break outer;
              } catch (_) { /* try next frame/selector */ }
            }
          }
          if (tbsTyped) break;
        }
        if (!tbsTyped) {
          // Last resort: click the currently focused element (or first visible input) and type with keyboard
          try {
            const focused = await page.evaluate(`(function() {
              const el = document.activeElement;
              if (el && el !== document.body && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
                const r = el.getBoundingClientRect();
                return { x: r.x + r.width/2, y: r.y + r.height/2 };
              }
              // Find first visible unfilled input
              const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])'));
              const visible = inputs.find(inp => {
                const s = window.getComputedStyle(inp);
                if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
                const r = inp.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
              });
              if (visible) {
                const r = visible.getBoundingClientRect();
                return { x: r.x + r.width/2, y: r.y + r.height/2 };
              }
              return null;
            })()`);
            if (focused && typeof focused.x === 'number') {
              await page.mouse.click(focused.x, focused.y);
              await page.waitForTimeout(150);
              await page.keyboard.down('Control');
              await page.keyboard.press('a');
              await page.keyboard.up('Control');
              await page.keyboard.press('Backspace');
              await page.keyboard.type(params.text || "", { delay: 40 });
              if (params.pressEnter) await page.keyboard.press('Enter');
              tbsTyped = true;
            }
          } catch (_) {}
        }
        if (!tbsTyped) throw new Error(`typeBySelector: element not found with selector "${params.selector}" (also tried: ${tbsUniq.slice(1).join(', ')})`);
        return { success: true, selector: params.selector };
      }
      case "fill":
        if (params.selector) {
          await page.fill(params.selector, params.text || "");
          return { success: true, selector: params.selector };
        }
        // If no selector, use type logic
        return await executeAction(page, "type", { ...params, clear: true });
      case "find":
        // Support for agent-browser find role <role> <action> [value]
        const { role, text: findText, label, placeholder, action: findAction, value: findValue, name: findName } = params;
        let locator;
        if (role) {
          locator = page.getByRole(role as any, { name: findName });
        } else if (findText) {
          locator = page.getByText(findText);
        } else if (label) {
          locator = page.getByLabel(label);
        } else if (placeholder) {
          locator = page.getByPlaceholder(placeholder);
        }
        
        if (locator) {
          const firstLocator = locator.first();
          if (findAction === "click") await firstLocator.click();
          else if (findAction === "fill") await firstLocator.fill(findValue || "");
          else if (findAction === "type") await firstLocator.type(findValue || "");
          return { success: true };
        }
        throw new Error("No locator criteria provided for find");
      case "scroll":
        const scrollAmount = params.amount || 500;
        if (params.direction === "down") {
          await page.evaluate(`window.scrollBy(0, ${scrollAmount})`);
          await page.mouse.wheel(0, scrollAmount);
        } else if (params.direction === "up") {
          await page.evaluate(`window.scrollBy(0, -${scrollAmount})`);
          await page.mouse.wheel(0, -scrollAmount);
        } else if (params.direction === "right") {
          await page.evaluate(`window.scrollBy(${scrollAmount}, 0)`);
          await page.mouse.wheel(scrollAmount, 0);
        } else if (params.direction === "left") {
          await page.evaluate(`window.scrollBy(-${scrollAmount}, 0)`);
          await page.mouse.wheel(-scrollAmount, 0);
        }
        break;
      case "dragAndDrop":
        await page.mouse.move(params.fromX, params.fromY);
        await page.mouse.down();
        await page.mouse.move(params.toX, params.toY, { steps: 10 });
        await page.mouse.up();
        break;
      case "wait":
        await page.waitForTimeout(params.ms || 500);
        break;
      case "waitForSelector":
        await page.waitForSelector(params.selector, { timeout: 5000 });
        break;
      case "goBack":
        await page.goBack();
        break;
      case "goForward":
        await page.goForward();
        break;
      case "reload":
        await page.reload();
        break;
      case "hover":
        if (params.index !== undefined) {
          const hoverResult = await page.evaluate(`(function(index) {
            var target = document.querySelector('[data-agent-index="' + index + '"]');
            if (target) {
              target.scrollIntoView({ behavior: 'smooth', block: 'center' });
              var rect = target.getBoundingClientRect();
              return { success: true, tag: target.tagName.toLowerCase(), id: target.id, x: rect.x + rect.width/2, y: rect.y + rect.height/2 };
            }
            return { success: false };
          })(${JSON.stringify(params.index)})`);

          if (hoverResult.success) {
            await page.mouse.move(hoverResult.x, hoverResult.y);
          }
          return hoverResult;
        }
        await page.mouse.move(params.x, params.y);
        break;
      case "pressKey":
        await page.keyboard.press(params.key);
        break;
      case "runJs":
      case "runScript":
        if (!params.script && !params.code) throw new Error("Script code is required");
        await page.evaluate(params.script || params.code);
        break;
      case "getHtml":
        const selector = params.selector || 'body';
        const html = await page.evaluate(`(function(sel) {
          var el = document.querySelector(sel);
          return el ? el.outerHTML.slice(0, 10000) : "Element not found";
        })(${JSON.stringify(selector)})`);
        return { html };
      case "screenshot":
        // Manual screenshot request - just break and it will capture state after
        break;
      case "selectOption":
        await page.selectOption(params.selector, params.value);
        break;
      case "check":
        await page.check(params.selector);
        break;
      case "uncheck":
        await page.uncheck(params.selector);
        break;
      case "setInputFiles":
        await page.setInputFiles(params.selector, params.files);
        break;
      case "focus":
        await page.focus(params.selector);
        break;
      case "closePopup":
        // This is a special case handled by the loop to switch activePage
        // But we can also explicitly close the current activePage if it's a popup
        await page.close();
        break;
      case "bypassVideo":
        // Common video bypass script for Edgenuity/educational platforms
        await page.evaluate(`(() => {
          const videos = document.querySelectorAll('video');
          videos.forEach(v => {
            try {
              v.muted = true;
              v.play();
              v.currentTime = v.duration - 0.1;
              v.dispatchEvent(new Event('ended'));
            } catch(e) {}
          });
          // Try to find "Next" or "Continue" buttons that might be hidden or disabled
          const buttons = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
          const nextBtn = buttons.find(b => {
            const text = b.textContent?.toLowerCase() || "";
            return text.includes('next') || text.includes('continue') || text.includes('próximo') || text.includes('avançar');
          });
          if (nextBtn) {
            nextBtn.removeAttribute('disabled');
            nextBtn.classList.remove('disabled');
            nextBtn.click();
          }
        })()`);
        break;
      case "solveMath":
        // Placeholder for a more complex math solver script if needed
        break;
      case "extractText":
        // AI will use the accessibility tree mostly, but this can be a specific tool
        break;
      default:
        console.warn("Unknown action:", action);
    }
  } catch (e) {
    console.error(`Action ${action} failed:`, e);
    throw e;
  }
}

startServer();
