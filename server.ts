import express from "express";
import { createServer as createViteServer } from "vite";
import { Server } from "socket.io";
import http from "http";
import cors from "cors";
import path from "path";
import { Browser, Page } from "playwright-chromium";
import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import OpenAI from "openai";

chromium.use(stealth());

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

const PORT = process.env.PORT || 3000;

// AI Setup removed from backend - Gemini must be called from frontend

async function startServer() {
  let browser: Browser | null = null;
  let page: Page | null = null;

  app.use(cors());
  app.use(express.json());
  
  let activePage: Page | null = null;
  let browserContext: any = null;

  // API routes
  app.post("/api/nova", async (req, res) => {
    const { messages, response_format } = req.body;
    try {
      const apiKey = process.env.VITE_NOVA_API_KEY;
      if (!apiKey) throw new Error("API Key missing");
      
      // Determine the correct endpoint and model based on the key
      // Amazon does not provide a direct "api.nova.amazon.com" OpenAI-compatible endpoint.
      // If using OpenRouter to access Nova:
      const isOpenRouter = apiKey.startsWith('sk-or-');
      const baseURL = isOpenRouter ? 'https://openrouter.ai/api/v1' : 'https://api.nova.amazon.com/v1';
      const modelName = isOpenRouter ? 'amazon/nova-pro-v1' : 'nova-pro-v1';

      const openai = new OpenAI({
        baseURL,
        apiKey,
        defaultHeaders: {
          'HTTP-Referer': 'https://localhost:3000',
          'X-Title': 'AI Browser Agent',
          'x-api-key': apiKey // Added for custom API Gateways that require it
        }
      });
      
      const response = await openai.chat.completions.create({
        model: modelName,
        messages,
        response_format,
        max_tokens: 8192
      });
      res.json(response);
    } catch (error: any) {
      console.error("Nova API error:", error);
      res.status(500).json({ error: error.message || "Failed to call Nova API" });
    }
  });

  // Vite middleware
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
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
          browser = await chromium.launch({ 
            headless: true,
            args: [
              '--disable-blink-features=AutomationControlled',
              '--disable-features=IsolateOrigins,site-per-process',
              '--no-sandbox',
              '--disable-setuid-sandbox'
            ]
          });
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

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
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
    console.error("Failed to capture screenshot, retrying...", error);
    try {
      await page.waitForTimeout(1000);
      const screenshot = await page.screenshot({ type: "jpeg", quality: 50, timeout: 5000 });
      base64Screenshot = screenshot.toString("base64");
    } catch (retryError) {
      console.error("Retry failed to capture screenshot:", retryError);
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
      if (rect.width === 0 || rect.height === 0) return null;

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
        const clickAtResult = await page.evaluate(({ x, y }) => {
          const getInteractiveElement = (x, y) => {
            const el = document.elementFromPoint(x, y);
            if (!el) return null;
            const interactive = el.closest('input, textarea, [contenteditable="true"], select, button, a, [role="button"], [role="link"]');
            if (interactive instanceof HTMLElement) return interactive;
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
            return { success: true, tag: target.tagName.toLowerCase(), id: target.id };
          }
          return { success: false, reason: 'no interactive element found at coordinates' };
        }, { x: clickAtX, y: clickAtY });
        
        return clickAtResult;
      case "click":
        if (params.index) {
          const indexResult = await page.evaluate((index) => {
            const target = document.querySelector(`[data-agent-index="${index}"]`);
            if (target instanceof HTMLElement) {
              target.scrollIntoView({ behavior: 'smooth', block: 'center' });
              // Ensure it's visible
              const style = window.getComputedStyle(target);
              if (style.display === 'none' || style.visibility === 'hidden') return { success: false, reason: 'hidden' };
              
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
            return { success: false, reason: 'not found' };
          }, params.index);
          return indexResult;
        }
        if (params.selector) {
          await page.click(params.selector, { timeout: 5000 });
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
        const clickResult = await page.evaluate(({ x, y }) => {
          const getInteractiveElement = (x, y) => {
            const el = document.elementFromPoint(x, y);
            if (!el) return null;
            
            const interactive = el.closest('input, textarea, [contenteditable="true"], select, button, a, [role="button"], [role="link"]');
            if (interactive instanceof HTMLElement) return interactive;
            
            const radius = 15; // Increased radius for desktop
            for (let dx = -radius; dx <= radius; dx += 3) {
              for (let dy = -radius; dy <= radius; dy += 3) {
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
            return {
              tag: target.tagName.toLowerCase(),
              id: target.id,
              className: target.className,
              text: target.innerText?.slice(0, 50),
              role: target.getAttribute('role')
            };
          }
          return null;
        }, { x: clickX, y: clickY });
        return { element: clickResult };
      case "clickByText":
        if (!params.text) throw new Error("Text is required for clickByText");
        const textResult = await page.evaluate((text) => {
          // Search for all interactive elements
          const elements = Array.from(document.querySelectorAll('button, a, [role="button"], [role="link"], input[type="button"], input[type="submit"]'));
          const target = elements.find(el => 
            el.textContent?.trim().toLowerCase().includes(text.toLowerCase())
          );
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
        }, params.text);
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
      case "typeAt":
        if (typeof params.x !== 'number' || typeof params.y !== 'number') {
          throw new Error("Invalid coordinates for typeAt");
        }
        const typeAtX = Math.max(0, params.x);
        const typeAtY = Math.max(0, params.y);

        // Click to focus first
        await page.mouse.click(typeAtX, typeAtY);
        await page.waitForTimeout(200);
        
        // JS Fallback for focus
        await page.evaluate(({ x, y }) => {
          const getInteractiveElement = (x, y) => {
            const el = document.elementFromPoint(x, y);
            if (!el) return null;
            const input = el.closest('input, textarea, [contenteditable="true"]');
            if (input instanceof HTMLElement) return input;
            
            const radius = 10;
            for (let dx = -radius; dx <= radius; dx += 2) {
              for (let dy = -radius; dy <= radius; dy += 2) {
                const nearEl = document.elementFromPoint(x + dx, y + dy);
                const nearInput = nearEl?.closest('input, textarea, [contenteditable="true"]');
                if (nearInput instanceof HTMLElement) return nearInput;
              }
            }
            return el instanceof HTMLElement ? el : null;
          };

          const target = getInteractiveElement(x, y);
          if (target) {
            target.focus();
            if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
              target.select();
            }
          }
        }, { x: typeAtX, y: typeAtY });

        if (params.clear) {
          await page.keyboard.press('Backspace');
        }
        await page.keyboard.type(params.text, { delay: 30 });
        if (params.pressEnter) {
          await page.keyboard.press('Enter');
        }
        break;
      case "type":
        if (params.index) {
          const targetInfo = await page.evaluate((index) => {
            const target = document.querySelector(`[data-agent-index="${index}"]`);
            if (target instanceof HTMLElement) {
              target.scrollIntoView({ behavior: 'smooth', block: 'center' });
              target.focus();
              if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
                target.select();
              }
              const rect = target.getBoundingClientRect();
              return {
                success: true,
                x: rect.x + rect.width / 2,
                y: rect.y + rect.height / 2
              };
            }
            return { success: false };
          }, params.index);
          
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
          throw new Error("Invalid coordinates for type");
        }
        const typeX = Math.max(0, params.x);
        const typeY = Math.max(0, params.y);

        // Click to focus first
        await page.mouse.click(typeX, typeY);
        await page.waitForTimeout(200);
        
        // JS Fallback for focus
        await page.evaluate(({ x, y }) => {
          const getInteractiveElement = (x, y) => {
            const el = document.elementFromPoint(x, y);
            if (!el) return null;
            const input = el.closest('input, textarea, [contenteditable="true"]');
            if (input instanceof HTMLElement) return input;
            
            const radius = 10;
            for (let dx = -radius; dx <= radius; dx += 2) {
              for (let dy = -radius; dy <= radius; dy += 2) {
                const nearEl = document.elementFromPoint(x + dx, y + dy);
                const nearInput = nearEl?.closest('input, textarea, [contenteditable="true"]');
                if (nearInput instanceof HTMLElement) return nearInput;
              }
            }
            return el instanceof HTMLElement ? el : null;
          };

          const target = getInteractiveElement(x, y);
          if (target) {
            target.focus();
            if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
              target.select();
            }
          }
        }, { x: typeX, y: typeY });
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
        if (params.index) {
          const hoverResult = await page.evaluate((index) => {
            const target = document.querySelector(`[data-agent-index="${index}"]`);
            if (target instanceof HTMLElement) {
              target.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
          }, params.index);
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
        const html = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return el ? el.outerHTML.slice(0, 10000) : "Element not found";
        }, selector);
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
  }
}

startServer();
