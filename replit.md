# AI Browser Agent

## Overview
A full-stack AI-powered autonomous browser agent application. The agent can navigate the web, interact with pages, and complete tasks using a combination of vision (screenshots), accessibility trees, and AI reasoning (Nova/Gemini APIs).

## Architecture
- **Frontend**: React 19 + TypeScript + Tailwind CSS v4 (via Vite middleware)
- **Backend**: Express.js + Socket.io (real-time communication)
- **Browser Automation**: Playwright Chromium (headless browser controlled by the agent)
- **AI Models**: Amazon Nova (via OpenAI-compatible API) for agent reasoning; Gemini API available for frontend

## Project Structure
- `server.ts` - Express + Socket.io backend, serves Vite frontend in dev, controls Playwright browser
- `src/App.tsx` - Main React component: agent chat UI, live browser preview, console logs
- `src/main.tsx` - React entry point
- `src/index.css` - Global styles
- `index.html` - HTML entry point
- `vite.config.ts` - Vite configuration with Tailwind, React, host/proxy settings
- `tsconfig.json` - TypeScript configuration
- `.env.example` - Environment variable template

## Environment Variables
- `GEMINI_API_KEY` - Google Gemini API key (for frontend AI calls)
- `VITE_NOVA_API_KEY` - Amazon Nova API key (for backend agent reasoning via `/api/nova`)
- `APP_URL` - Deployment URL for self-referential links

## Running the App
- **Development**: `npm run dev` — starts Express + Vite on port 5000
- **Build**: `npm run build` — builds the frontend to `dist/`

## Key Features
- Live browser preview with screenshot streaming via Socket.io
- Autonomous agent loop using Nova Pro vision model
- Manual browser control (click, type, navigate)
- Accessibility tree inspection
- Console log capture from the controlled browser
- Continuous/step mode toggle
- Playwright-powered headless browser automation
