# AI Browser Agent

An autonomous AI browser agent that uses Playwright to control a headless Chromium browser and an AI model (Amazon Nova via OpenRouter or direct API) to navigate the web and complete tasks.

## Architecture

- **Frontend**: React 19 + TypeScript + Vite + Tailwind CSS v4
- **Backend**: Express + Socket.IO + Vite dev middleware (unified server via `tsx`)
- **Browser Automation**: Playwright Chromium with stealth plugin
- **AI**: Amazon Nova Pro (via OpenRouter or Amazon API) for decision-making

The server handles both the API routes and serves the React frontend via Vite middleware in development. Socket.IO provides real-time communication for browser screenshots, status updates, and action execution.

## Port Configuration

- App runs on port **5000** (required for Replit webview)
- Server binds to `0.0.0.0` for proxy compatibility

## Environment Variables

- `GEMINI_API_KEY` - For Gemini AI API (optional, frontend use)
- `VITE_NOVA_API_KEY` - For Amazon Nova via OpenRouter (`sk-or-...`) or direct API
- `APP_URL` - The hosted URL of this application
- `PORT` - Override server port (default: 5000)

## Key Files

- `server.ts` - Express + Socket.IO + Vite middleware server
- `src/App.tsx` - Main React UI component
- `vite.config.ts` - Vite build configuration
- `package.json` - Dependencies and scripts

## Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run start` - Start production server
