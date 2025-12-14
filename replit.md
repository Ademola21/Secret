# Puppeteer Real Browser - Enhanced Automation Dashboard

## Overview
This project enhances `puppeteer-real-browser` by integrating a **real-time web dashboard** for monitoring and controlling automation tasks. The core library focuses on making Puppeteer behave like a real browser to bypass bot detection systems like Cloudflare. The enhanced version introduces advanced automation tools, a Nano cryptocurrency wallet manager (CryptoVault), and an automated faucet claiming module (FaucetSentry), all controllable via a responsive web dashboard. The project aims to provide a robust, undetectable, and versatile platform for web automation, cryptocurrency management, and automated online interactions.

## User Preferences
I prefer iterative development with clear communication on progress. Please ask before making major architectural changes or introducing new external dependencies. I value detailed explanations for complex technical decisions. Ensure the codebase remains clean, well-documented, and follows best practices for maintainability and scalability.

## System Architecture
The project is built around a Node.js Express server (`server/index.js`) that integrates with Socket.io for real-time communication, enabling a dynamic web dashboard. The dashboard provides three main tabs: Automation, CryptoVault, and FaucetSentry.

### UI/UX Decisions
- **Dashboard**: Web-based control panel with real-time updates using Socket.io.
- **Styling**: Modern dark theme with a focus on mobile responsiveness.
- **Live Monitoring**: Real-time log streaming with color-coded severity, live screenshot capture during automation tasks, and status indicators.
- **Interactive Elements**: Start, stop, and manage tasks directly from the UI, interactive forms for wallet management and faucet claiming.

### Technical Implementations
- **Automation Engine**: `server/engine.js` manages automation tasks using a patched Puppeteer (`rebrowser-puppeteer-core`) to evade bot detection. It integrates `ghost-cursor` for realistic mouse movements and supports authenticated proxies. For Linux, Xvfb is used for headless operation.
- **Task Management**: Supports a variety of tasks including bot detection tests, Cloudflare Turnstile solving, fingerprint tests, custom navigation, web scraping, form automation, session recording, multi-page crawling, batch screenshots, and performance audits.
- **CAPTCHA Solving**: Built-in, no external services required, utilizing OCR (Tesseract.js) for image CAPTCHAs and behavioral simulation for reCAPTCHA v3 bypass.
- **CryptoVault (Nano Wallet Manager)**: `server/nano-wallet.js` handles Nano cryptocurrency wallet operations including creation, import, deletion, sending, and receiving. It supports HD (BIP39/BIP44) and Legacy wallets, integrates with GPU PoW workers for faster proof-of-work, and provides real-time balance synchronization. Wallet data is stored encrypted in `data/nano-wallets.json`.
- **FaucetSentry (Automated Faucet Claiming)**: `server/faucet-sentry.js` automates the process of claiming cryptocurrency from faucets. It uses a bank wallet system, auto-creates and deletes temporary claim wallets, and supports Direct, Proxy, or Tor connections. It leverages CryptoVault's GPU worker settings. Configuration and state are managed in `data/faucet-sentry-config.json`.
- **Multi-Instance Manager**: `server/multi-instance-manager.js` enables running 1-10 simultaneous Chrome browsers for parallel faucet claiming. Each instance is assigned a unique Tor SOCKS port (9050-9068) for independent connections. See `docs/MULTI_INSTANCE_IMPLEMENTATION.md` for details.
- **API Endpoints**: A comprehensive set of RESTful API endpoints are provided for external control and integration for automation tasks, Nano wallet management, and FaucetSentry operations.
- **Socket.io Events**: Real-time updates are pushed to the dashboard via Socket.io for automation status, logs, screenshots, Nano wallet activity, and FaucetSentry status and logs.

### System Design Choices
- **Modularity**: Separation of concerns with distinct modules for the Express server, automation engine, Nano wallet manager, and FaucetSentry.
- **Security**: Encrypted storage for wallet data and secure handling of sensitive information.
- **Persistence**: Configuration and wallet data persist across restarts.
- **Cross-platform Compatibility**: Auto-detection of Chrome/Chromium paths and environment for deployment on Replit, Ubuntu, Debian, and other Linux systems.
- **Error Handling**: Comprehensive error handling throughout the system with notifications in the UI.

## External Dependencies
- **Server**: `express`, `socket.io`, `uuid`.
- **Automation Core**: `rebrowser-puppeteer-core` (patched Puppeteer), `ghost-cursor`, `chrome-launcher`, `tree-kill`, `xvfb` (for Linux).
- **Browser**: `chromium`.
- **System**: `X11 libraries` (for display support on Linux).
- **Client-side Cryptography (Nano)**: `nanocurrency-web` (used within CryptoVault).
- **OCR**: `Tesseract.js` (for CAPTCHA solving).