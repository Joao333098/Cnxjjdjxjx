import express from "express";
import { createServer as createViteServer } from "vite";
import { Server } from "socket.io";
import http from "http";
import cors from "cors";
import { chromium, Browser, Page } from "playwright-chromium";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

const PORT = 3000;

// AI Setup removed from backend - Gemini must be called from frontend

async function startServer() {
  let browser: Browser | null = null;
  let page: Page | null = null;

  app.use(cors());
  app.use(express.json());
  
  let activePage: Page | null = null;
  let browserContext: any = null;

  // Vite middleware
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  // Socket.io logic
  io.on("connection", (socket) => {
    console.log("Client connected");

    const stopFlags = new Map<string, boolean>();

    socket.on("start-task", async () => {
      try {
        if (!browser) {
          browser = await chromium.launch({ headless: true });
          browserContext = await browser.newContext({
            viewport: { width: 390, height: 844 },
            deviceScaleFactor: 1,
            isMobile: true,
            hasTouch: true,
            userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
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
            await activePage.waitForLoadState("load", { timeout: 5000 });
            await activePage.waitForLoadState("networkidle", { timeout: 5000 });
          } catch (e) {
            // Ignore timeout errors during wait
          }
          await activePage.waitForTimeout(1000);
          
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
          
          // Perform the actual click/tap
          await activePage.touchscreen.tap(clickX, clickY);
          
          // JS Fallback for manual clicks too
          await activePage.waitForTimeout(100);
          await activePage.evaluate(({ x, y }) => {
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
          }, { x: clickX, y: clickY });

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
  const screenshot = await page.screenshot({ type: "jpeg", quality: 50 });
  const base64Screenshot = screenshot.toString("base64");
  const url = page.url();
  const title = await page.title();

  const accessibilityTree = await page.evaluate(`(() => {
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

    const walk = (node, depth = 0) => {
      if (depth > 15) return null; 
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
        className: node.className?.slice(0, 50) || undefined,
        href: node.getAttribute("href") || undefined,
        title: node.getAttribute("title") || undefined,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      };

      if (node.tagName === "INPUT" || node.tagName === "TEXTAREA" || node.tagName === "SELECT") {
        info.value = node.value;
        info.type = node.type;
      }

      if (children.length > 0) info.children = children;
      return info;
    };
    return walk(document.body);
  })()`);

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
  
  // Ensure viewport is consistent with the agent's view (iPhone 12/13/14 size)
  await page.setViewportSize({ width: 390, height: 844 });
  
  try {
    switch (action) {
      case "navigate":
        let url = params.url;
        if (!url) throw new Error("URL is required for navigate action");
        if (!url.startsWith('http')) url = 'https://' + url;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(2000); // Extra settling time
        break;
      case "click":
        if (typeof params.x !== 'number' || typeof params.y !== 'number') {
          throw new Error("Invalid coordinates for click");
        }
        const clickX = Math.max(0, params.x);
        const clickY = Math.max(0, params.y);
        
        // Move mouse first to trigger hover effects
        await page.mouse.move(clickX, clickY);
        await page.waitForTimeout(100);
        
        // Perform the actual click/tap
        await page.touchscreen.tap(clickX, clickY);
        
        // Fallback: If it's a focusable element, ensure it's focused and clicked
        await page.waitForTimeout(100);
        const clickResult = await page.evaluate(({ x, y }) => {
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
          const elements = Array.from(document.querySelectorAll('button, a, span, div, p, label'));
          const target = elements.find(el => 
            el.textContent?.trim().toLowerCase() === text.toLowerCase() ||
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
        const selectorResult = await page.evaluate((selector) => {
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
        }, params.selector);
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
      case "type":
        if (typeof params.x !== 'number' || typeof params.y !== 'number') {
          throw new Error("Invalid coordinates for type");
        }
        const typeX = Math.max(0, params.x);
        const typeY = Math.max(0, params.y);
        const textToType = String(params.text || "");

        // Tap to focus first
        await page.touchscreen.tap(typeX, typeY);
        await page.waitForTimeout(200);

        // JS fallback: find the best editable target near coordinates
        const focusedTarget = await page.evaluate(({ x, y }) => {
          const isEditable = (el) => {
            if (!(el instanceof HTMLElement)) return false;
            if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
              return !el.disabled && !el.readOnly;
            }
            if (el.isContentEditable) return true;
            const role = el.getAttribute('role');
            return role === 'textbox';
          };

          const isVisible = (el) => {
            if (!(el instanceof HTMLElement)) return false;
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;
            const style = window.getComputedStyle(el);
            return style.visibility !== 'hidden' && style.display !== 'none';
          };

          const centerDistance = (el) => {
            const rect = el.getBoundingClientRect();
            const cx = rect.x + rect.width / 2;
            const cy = rect.y + rect.height / 2;
            return Math.hypot(cx - x, cy - y);
          };

          const collectCandidates = () => {
            const candidates = [];
            const addIfEditable = (el) => {
              if (!isEditable(el) || !isVisible(el)) return;
              candidates.push(el);
            };

            const atPoint = document.elementFromPoint(x, y);
            if (atPoint instanceof HTMLElement) {
              const direct = atPoint.closest('input, textarea, [contenteditable="true"], [role="textbox"]');
              addIfEditable(direct);

              // Label fallback: clicking label should target its associated control
              if (atPoint instanceof HTMLLabelElement && atPoint.control) {
                addIfEditable(atPoint.control);
              }
              const labelParent = atPoint.closest('label');
              if (labelParent instanceof HTMLLabelElement && labelParent.control) {
                addIfEditable(labelParent.control);
              }
            }

            const radius = 28;
            for (let dx = -radius; dx <= radius; dx += 4) {
              for (let dy = -radius; dy <= radius; dy += 4) {
                const near = document.elementFromPoint(x + dx, y + dy);
                if (!(near instanceof HTMLElement)) continue;
                const target = near.closest('input, textarea, [contenteditable="true"], [role="textbox"]');
                addIfEditable(target);
                if (near instanceof HTMLLabelElement && near.control) addIfEditable(near.control);
                const nearLabel = near.closest('label');
                if (nearLabel instanceof HTMLLabelElement && nearLabel.control) addIfEditable(nearLabel.control);
              }
            }

            if (candidates.length === 0) {
              document.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"]').forEach((el) => addIfEditable(el));
            }

            return Array.from(new Set(candidates));
          };

          const candidates = collectCandidates();
          if (candidates.length === 0) return { found: false };

          const best = candidates.sort((a, b) => centerDistance(a) - centerDistance(b))[0];
          if (!(best instanceof HTMLElement)) return { found: false };

          best.focus();
          const rect = best.getBoundingClientRect();

          return {
            found: true,
            tag: best.tagName.toLowerCase(),
            id: best.id || undefined,
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
          };
        }, { x: typeX, y: typeY });

        await page.waitForTimeout(150);

        if (!focusedTarget?.found) {
          throw new Error("No editable element found near coordinates for type");
        }

        if (params.clear) {
          await page.keyboard.press('ControlOrMeta+a');
          await page.keyboard.press('Backspace');
          await page.waitForTimeout(50);
        }

        if (textToType) {
          await page.keyboard.type(textToType, { delay: 30 });
        }

        // Verification/fallback for inputs that ignore keyboard events
        const typedOk = await page.evaluate((expectedText, clearRequested) => {
          const active = document.activeElement;
          if (!active) return false;

          if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
            return clearRequested ? active.value === expectedText : active.value.includes(expectedText);
          }

          if (active instanceof HTMLElement && active.isContentEditable) {
            const value = (active.innerText || '').trim();
            return clearRequested ? value === expectedText : value.includes(expectedText);
          }

          return false;
        }, textToType, Boolean(params.clear));

        if (!typedOk && textToType) {
          await page.evaluate((value, clearRequested) => {
            const active = document.activeElement;
            if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
              active.focus();
              if (clearRequested) active.value = '';
              active.value = clearRequested ? value : `${active.value}${value}`;
              active.dispatchEvent(new Event('input', { bubbles: true }));
              active.dispatchEvent(new Event('change', { bubbles: true }));
              return;
            }

            if (active instanceof HTMLElement && active.isContentEditable) {
              active.focus();
              const current = clearRequested ? '' : (active.innerText || '');
              active.innerText = `${current}${value}`;
              active.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
              active.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }, textToType, Boolean(params.clear));
        }

        if (params.pressEnter) {
          await page.waitForTimeout(200);
          await page.keyboard.press("Enter");
        }

        return { success: true, target: focusedTarget };
      case "scroll":
        const scrollAmount = params.amount || 500;
        if (params.direction === "down") {
          await page.evaluate((amt) => window.scrollBy(0, amt), scrollAmount);
          await page.mouse.wheel(0, scrollAmount);
        } else if (params.direction === "up") {
          await page.evaluate((amt) => window.scrollBy(0, -amt), scrollAmount);
          await page.mouse.wheel(0, -scrollAmount);
        } else if (params.direction === "right") {
          await page.evaluate((amt) => window.scrollBy(amt, 0), scrollAmount);
          await page.mouse.wheel(scrollAmount, 0);
        } else if (params.direction === "left") {
          await page.evaluate((amt) => window.scrollBy(-amt, 0), scrollAmount);
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
        await page.waitForTimeout(params.ms || 2000);
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
