import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { NanoToolDefinition } from "./types.js";
import { textResult, jsonTextResult } from "./types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let puppeteerModule: any = null;
async function loadPuppeteer() {
  if (puppeteerModule) return puppeteerModule;
  puppeteerModule = await import("puppeteer");
  return puppeteerModule;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_SNAPSHOT_CHARS = 30_000;

// ── Persistent browser session ────────────────────────────────────────

interface BrowserSession {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  browser: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any;
  consoleMessages: Array<{ level: string; text: string; ts: string }>;
}

const sessions = new Map<string, BrowserSession>();

async function getOrCreateSession(
  executablePath?: string,
): Promise<BrowserSession> {
  const key = "default";
  const existing = sessions.get(key);
  if (existing) {
    try {
      // Check browser is still alive
      await existing.browser.version();
      return existing;
    } catch {
      sessions.delete(key);
    }
  }

  const puppeteer = await loadPuppeteer();
  const browser = await puppeteer.default.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
    ...(executablePath ? { executablePath } : {}),
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  const consoleMessages: BrowserSession["consoleMessages"] = [];
  page.on("console", (msg: { type: () => string; text: () => string }) => {
    consoleMessages.push({
      level: msg.type(),
      text: msg.text(),
      ts: new Date().toISOString(),
    });
    // Keep only last 100 messages
    if (consoleMessages.length > 100) consoleMessages.shift();
  });

  const session: BrowserSession = { browser, page, consoleMessages };
  sessions.set(key, session);
  return session;
}

async function closeSession(): Promise<void> {
  const session = sessions.get("default");
  if (session) {
    await session.browser.close().catch(() => {});
    sessions.delete("default");
  }
}

// ── Accessibility snapshot (like OpenClaw's snapshot action) ──────────

async function getAccessibilitySnapshot(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
  maxChars: number,
): Promise<{ snapshot: string; url: string; title: string }> {
  const url = page.url();
  const title = await page.title().catch(() => "");

  // Use Puppeteer's accessibility tree
  const snapshot = await page.accessibility.snapshot({ interestingOnly: true });
  const text = formatAccessibilityTree(snapshot, 0);
  const truncated =
    text.length > maxChars ? text.slice(0, maxChars) + "\n... (truncated)" : text;

  return { snapshot: truncated, url, title };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatAccessibilityTree(node: any, depth: number): string {
  if (!node) return "(empty page)";

  const indent = "  ".repeat(depth);
  const parts: string[] = [];

  const role = node.role || "";
  const name = node.name || "";
  const value = node.value || "";

  if (role && role !== "none" && role !== "GenericContainer") {
    let line = `${indent}[${role}]`;
    if (name) line += ` "${name}"`;
    if (value) line += ` value="${value}"`;
    if (node.checked !== undefined) line += ` checked=${node.checked}`;
    if (node.selected !== undefined) line += ` selected=${node.selected}`;
    if (node.disabled) line += ` disabled`;
    if (node.focused) line += ` focused`;
    parts.push(line);
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      parts.push(formatAccessibilityTree(child, depth + (role ? 1 : 0)));
    }
  }

  return parts.join("\n");
}

// ── Main tool ─────────────────────────────────────────────────────────

const ACTIONS = [
  "open",
  "navigate",
  "click",
  "type",
  "press",
  "screenshot",
  "snapshot",
  "evaluate",
  "wait",
  "scroll",
  "console",
  "close",
] as const;

const ACT_KINDS = [
  "click",
  "type",
  "press",
  "hover",
  "select",
  "scroll",
  "wait",
  "evaluate",
] as const;

export function createBrowserTool(opts?: {
  executablePath?: string;
  screenshotDir?: string;
}): NanoToolDefinition {
  const screenshotDir =
    opts?.screenshotDir ?? "/tmp/nano-openclaw-screenshots";

  return {
    name: "browser",
    label: "Browser",
    description: `Interactive browser control with a persistent Puppeteer session.
Use snapshot+act pattern for UI automation: take a snapshot to understand the page, then act on elements.

ACTIONS:
- open: Launch browser and navigate to URL
- navigate: Navigate current page to a new URL
- click: Click an element by CSS selector
- type: Type text into an element (clears existing text first)
- press: Press a keyboard key (e.g. Enter, Tab, Escape, ArrowDown)
- screenshot: Take a screenshot of the current page
- snapshot: Get the page's accessibility tree (interactive elements, text content, structure)
- evaluate: Execute JavaScript in the page context
- wait: Wait for a selector to appear or a fixed time
- scroll: Scroll the page (up/down/to element)
- console: Get recent browser console messages
- close: Close the browser session

WORKFLOW for interacting with pages:
1. open/navigate to the URL
2. snapshot to understand the page structure
3. Use click/type/press to interact with elements (using CSS selectors from the snapshot)
4. screenshot to verify the result visually

CSS SELECTOR TIPS:
- Use IDs when available: "#search-input"
- Use data attributes: "[data-testid='submit']"
- Use aria labels: "[aria-label='Search']"
- Use text content: "button:has-text('Submit')" or combine: ".form-group input[type='email']"
- Use nth-child for lists: "ul > li:nth-child(2)"`,
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: [...ACTIONS],
          description: "Action to perform",
        },
        url: {
          type: "string",
          description: "URL (for open/navigate)",
        },
        selector: {
          type: "string",
          description: "CSS selector (for click/type/wait/scroll)",
        },
        text: {
          type: "string",
          description: "Text to type (for type action)",
        },
        key: {
          type: "string",
          description: "Key to press (for press action, e.g. 'Enter', 'Tab', 'Escape')",
        },
        fn: {
          type: "string",
          description: "JavaScript to evaluate in page context (for evaluate action)",
        },
        timeMs: {
          type: "number",
          description: "Milliseconds to wait (for wait action, default: 1000)",
        },
        direction: {
          type: "string",
          description:
            "Scroll direction: 'up' or 'down' (for scroll action, default: 'down')",
        },
        amount: {
          type: "number",
          description:
            "Scroll amount in pixels (for scroll action, default: 500)",
        },
        fullPage: {
          type: "boolean",
          description:
            "Capture full page screenshot (for screenshot, default: false)",
        },
        maxChars: {
          type: "number",
          description:
            "Max characters for snapshot (default: 30000)",
        },
        level: {
          type: "string",
          description:
            "Filter console messages by level: log, warn, error (for console action)",
        },
      },
    },
    execute: async (_toolCallId, params) => {
      const p = params as Record<string, unknown>;
      const action = String(p.action ?? "");

      try {
        switch (action) {
          // ── open ─────────────────────────────────────────────
          case "open": {
            const url = String(p.url ?? "");
            if (!url) return textResult("Error: url is required");
            const session = await getOrCreateSession(opts?.executablePath);
            await session.page.goto(url, {
              waitUntil: "networkidle2",
              timeout: DEFAULT_TIMEOUT_MS,
            });
            const title = await session.page.title().catch(() => "");
            return jsonTextResult({
              ok: true,
              url: session.page.url(),
              title,
            });
          }

          // ── navigate ─────────────────────────────────────────
          case "navigate": {
            const url = String(p.url ?? "");
            if (!url) return textResult("Error: url is required");
            const session = await getOrCreateSession(opts?.executablePath);
            await session.page.goto(url, {
              waitUntil: "networkidle2",
              timeout: DEFAULT_TIMEOUT_MS,
            });
            const title = await session.page.title().catch(() => "");
            return jsonTextResult({
              ok: true,
              url: session.page.url(),
              title,
            });
          }

          // ── click ────────────────────────────────────────────
          case "click": {
            const selector = String(p.selector ?? "");
            if (!selector) return textResult("Error: selector is required");
            const session = await getOrCreateSession(opts?.executablePath);
            await session.page.waitForSelector(selector, {
              timeout: DEFAULT_TIMEOUT_MS,
            });
            await session.page.click(selector);
            // Brief wait for navigation/DOM update
            await session.page
              .waitForNavigation({ timeout: 2000 })
              .catch(() => {});
            return jsonTextResult({
              ok: true,
              url: session.page.url(),
              clicked: selector,
            });
          }

          // ── type ─────────────────────────────────────────────
          case "type": {
            const selector = String(p.selector ?? "");
            const text = String(p.text ?? "");
            if (!selector) return textResult("Error: selector is required");
            if (!text) return textResult("Error: text is required");
            const session = await getOrCreateSession(opts?.executablePath);
            await session.page.waitForSelector(selector, {
              timeout: DEFAULT_TIMEOUT_MS,
            });
            // Clear existing content then type
            await session.page.click(selector, { clickCount: 3 });
            await session.page.type(selector, text);
            return jsonTextResult({
              ok: true,
              typed: text.length > 50 ? text.slice(0, 47) + "..." : text,
              selector,
            });
          }

          // ── press ────────────────────────────────────────────
          case "press": {
            const key = String(p.key ?? "");
            if (!key) return textResult("Error: key is required");
            const session = await getOrCreateSession(opts?.executablePath);
            await session.page.keyboard.press(key);
            // Brief wait for DOM update
            await new Promise((r) => setTimeout(r, 300));
            return jsonTextResult({ ok: true, pressed: key });
          }

          // ── screenshot ───────────────────────────────────────
          case "screenshot": {
            const session = await getOrCreateSession(opts?.executablePath);
            await fs.mkdir(screenshotDir, { recursive: true });
            const filename = `browser-${randomUUID().slice(0, 8)}.jpg`;
            const filepath = path.join(screenshotDir, filename);

            const fullPage = p.fullPage === true;
            const screenshotOpts: Record<string, unknown> = {
              path: filepath,
              type: "jpeg",
              quality: 80,
            };

            if (fullPage) {
              const bodyHeight = await session.page.evaluate(() =>
                Math.max(
                  document.body.scrollHeight,
                  document.documentElement.scrollHeight,
                ),
              );
              if (bodyHeight > 2000) {
                screenshotOpts.clip = {
                  x: 0,
                  y: 0,
                  width: 1280,
                  height: 2000,
                };
              } else {
                screenshotOpts.fullPage = true;
              }
            }

            await session.page.screenshot(screenshotOpts);
            const buf = await fs.readFile(filepath);
            const base64 = buf.toString("base64");
            const title = await session.page.title().catch(() => "");

            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    ok: true,
                    url: session.page.url(),
                    title,
                    path: filepath,
                  }),
                },
                {
                  type: "image" as never,
                  data: base64,
                  mimeType: "image/jpeg",
                } as never,
              ],
            };
          }

          // ── snapshot ─────────────────────────────────────────
          case "snapshot": {
            const session = await getOrCreateSession(opts?.executablePath);
            const maxChars =
              typeof p.maxChars === "number" && p.maxChars > 0
                ? Math.floor(p.maxChars)
                : MAX_SNAPSHOT_CHARS;
            const snap = await getAccessibilitySnapshot(
              session.page,
              maxChars,
            );
            return jsonTextResult({
              ok: true,
              url: snap.url,
              title: snap.title,
              snapshot: snap.snapshot,
            });
          }

          // ── evaluate ─────────────────────────────────────────
          case "evaluate": {
            const fn = String(p.fn ?? "");
            if (!fn) return textResult("Error: fn is required");
            const session = await getOrCreateSession(opts?.executablePath);
            const result = await session.page.evaluate(fn);
            const resultStr =
              typeof result === "string"
                ? result
                : JSON.stringify(result, null, 2);
            const truncated =
              resultStr && resultStr.length > 5000
                ? resultStr.slice(0, 4997) + "..."
                : resultStr;
            return jsonTextResult({
              ok: true,
              result: truncated ?? null,
            });
          }

          // ── wait ─────────────────────────────────────────────
          case "wait": {
            const session = await getOrCreateSession(opts?.executablePath);
            const selector = p.selector ? String(p.selector) : undefined;
            const timeMs =
              typeof p.timeMs === "number" ? p.timeMs : 1000;

            if (selector) {
              await session.page.waitForSelector(selector, {
                timeout: Math.max(timeMs, DEFAULT_TIMEOUT_MS),
              });
              return jsonTextResult({ ok: true, found: selector });
            }

            await new Promise((r) => setTimeout(r, timeMs));
            return jsonTextResult({ ok: true, waited: `${timeMs}ms` });
          }

          // ── scroll ───────────────────────────────────────────
          case "scroll": {
            const session = await getOrCreateSession(opts?.executablePath);
            const selector = p.selector ? String(p.selector) : undefined;
            const direction = String(p.direction ?? "down");
            const amount = typeof p.amount === "number" ? p.amount : 500;

            if (selector) {
              await session.page.evaluate(
                (sel: string) => {
                  const el = document.querySelector(sel);
                  if (el) el.scrollIntoView({ behavior: "smooth" });
                },
                selector,
              );
              return jsonTextResult({
                ok: true,
                scrolledTo: selector,
              });
            }

            const scrollY = direction === "up" ? -amount : amount;
            await session.page.evaluate((y: number) => {
              window.scrollBy(0, y);
            }, scrollY);
            return jsonTextResult({
              ok: true,
              scrolled: `${direction} ${amount}px`,
            });
          }

          // ── console ──────────────────────────────────────────
          case "console": {
            const session = await getOrCreateSession(opts?.executablePath);
            const level = p.level ? String(p.level).toLowerCase() : undefined;
            let msgs = session.consoleMessages;
            if (level) {
              msgs = msgs.filter((m) => m.level === level);
            }
            return jsonTextResult({
              ok: true,
              url: session.page.url(),
              messageCount: msgs.length,
              messages: msgs.slice(-50), // last 50
            });
          }

          // ── close ────────────────────────────────────────────
          case "close": {
            await closeSession();
            return jsonTextResult({ ok: true, closed: true });
          }

          default:
            return textResult(
              `Error: unknown action "${action}". Use: ${ACTIONS.join(", ")}`,
            );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return textResult(`Error [browser.${action}]: ${msg}`);
      }
    },
  };
}

// Cleanup on process exit
process.on("exit", () => {
  for (const session of sessions.values()) {
    session.browser.close().catch(() => {});
  }
});
